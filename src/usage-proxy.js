// Provider usage proxy: tokens and cost measured from the real API response.
//
// The dev agent points its SDK base URL at this server and sends the contract id:
//   Anthropic: ANTHROPIC_BASE_URL=http://<host>/proxy/anthropic   (header x-obt-contract: <id>)
//   OpenAI:    OPENAI_BASE_URL=http://<host>/proxy/openai/v1        (header x-obt-contract: <id>)
//
// The request goes to the provider unchanged, with the agent's own API key
// (never stored here). The response streams back unchanged while usage is read
// from it: JSON bodies and server-sent events (streaming) are both supported.
//
// Supported endpoints: Anthropic Messages, OpenAI Chat Completions and Responses.
// For OpenAI Chat Completions streaming, the client must send
// stream_options: { include_usage: true }, otherwise the API sends no usage.
import { httpError } from './contract.js';

const ACTOR = { role: 'integration', agent: 'usage-proxy' };
const UPSTREAM = {
  anthropic: () => process.env.ANTHROPIC_UPSTREAM_URL ?? 'https://api.anthropic.com',
  openai: () => process.env.OPENAI_UPSTREAM_URL ?? 'https://api.openai.com',
};
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding']);

// ---- usage extraction (pure) ----

// Normalized: { model, input, output, cacheRead, cacheWrite }
export function usageFromJson(provider, body) {
  if (!body || typeof body !== 'object') return null;
  const u = body.usage ?? body.response?.usage;
  if (!u) return null;
  const model = body.model ?? body.response?.model ?? null;
  if (provider === 'anthropic') {
    return { model, input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
  }
  // OpenAI: chat completions (prompt/completion) or responses (input/output).
  // Cached tokens are part of the input count there, so they are split out.
  const input = n(u.prompt_tokens ?? u.input_tokens);
  const cached = n(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens);
  return { model, input: input - cached, output: n(u.completion_tokens ?? u.output_tokens), cacheRead: cached, cacheWrite: 0 };
}

// Incremental parser for server-sent events; keeps only what it needs.
export class SseUsage {
  constructor(provider) {
    this.provider = provider;
    this.buf = '';
    this.usage = null;
  }

  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line.startsWith('data:')) this.onData(line.slice(5).trim());
    }
  }

  onData(data) {
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (this.provider === 'anthropic') {
      // message_start carries input and cache counts; message_delta carries the final output count.
      if (ev.type === 'message_start' && ev.message) this.usage = usageFromJson('anthropic', ev.message);
      else if (ev.type === 'message_delta' && ev.usage && this.usage) {
        this.usage.output = n(ev.usage.output_tokens);
        if (ev.usage.input_tokens != null) this.usage.input = n(ev.usage.input_tokens);
        if (ev.usage.cache_read_input_tokens != null) this.usage.cacheRead = n(ev.usage.cache_read_input_tokens);
        if (ev.usage.cache_creation_input_tokens != null) this.usage.cacheWrite = n(ev.usage.cache_creation_input_tokens);
      }
    } else {
      // chat completions: last chunk has usage; responses: response.completed has response.usage
      const u = usageFromJson('openai', ev);
      if (u) this.usage = u;
    }
  }
}

// USD from a per-million-token price table; null when the model has no price.
export function priceUsage(pricing, u) {
  const p = pricing?.[u.model] ?? pricing?.[stripDate(u.model)];
  if (!p) return null;
  const perTok = (x) => (Number(x) || 0) / 1e6;
  const cost = u.input * perTok(p.input) + u.output * perTok(p.output)
    + u.cacheRead * perTok(p.cacheRead ?? p.input) + u.cacheWrite * perTok(p.cacheWrite ?? p.input);
  return Math.round(cost * 1e6) / 1e6;
}

export function toContractUsage(u, costUsd) {
  const tokensIn = u.input + u.cacheRead + u.cacheWrite;
  return { tokensIn, tokensOut: u.output, tokens: tokensIn + u.output, costUsd, model: u.model, toolCalls: 0 };
}

// ---- HTTP handler ----

export async function proxyRequest(store, req, res, { fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(req.url, 'http://x');
  const [, , provider, ...rest] = url.pathname.split('/'); // /proxy/<provider>/...
  if (!UPSTREAM[provider]) throw httpError(404, `unknown provider ${provider}`);
  const id = req.headers['x-obt-contract'];
  if (!id) throw httpError(400, 'x-obt-contract header is required');
  const c = store.get(id);
  if (c.state !== 'building') throw httpError(409, `contract ${id} is not building`);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k) && !k.startsWith('x-obt-')) headers[k] = v;
  }
  const target = `${UPSTREAM[provider]()}/${rest.join('/')}${url.search}`;
  const upstream = await fetchImpl(target, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });

  const outHeaders = {};
  upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k) && k !== 'content-encoding') outHeaders[k] = v; });
  res.writeHead(upstream.status, outHeaders);

  const isSse = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
  const sse = isSse ? new SseUsage(provider) : null;
  const decoder = new TextDecoder();
  let jsonText = '';
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      const text = decoder.decode(chunk, { stream: true });
      if (sse) sse.push(text);
      else jsonText += text;
    }
  }
  res.end();

  if (upstream.status >= 400) return null;
  let u = null;
  if (sse) { sse.push('\n'); u = sse.usage; }
  else { try { u = usageFromJson(provider, JSON.parse(jsonText)); } catch { u = null; } }
  if (!u) return null;
  const usage = toContractUsage(u, priceUsage(store.config.pricing, u));
  // The contract may have changed state while the call ran (e.g. escalated); keep the record anyway.
  try { store.recordVerifiedUsage(id, usage, { ...ACTOR, agent: `usage-proxy:${provider}` }); }
  catch (e) { console.error('usage not recorded:', e.message); }
  return usage;
}

const n = (v) => Number(v) || 0;
const stripDate = (m) => String(m ?? '').replace(/-\d{8}$/, '');
