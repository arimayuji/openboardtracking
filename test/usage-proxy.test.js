import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { Contracts } from '../src/contract.js';
import { usageFromJson, SseUsage, priceUsage, toContractUsage, proxyRequest } from '../src/usage-proxy.js';

const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'dev-a' };
const human = { role: 'human', agent: 'h' };
const PRICING = { 'model-a': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };

function building(s, budget = {}) {
  const c = s.createIntent({ title: 't', criteria: ['ok'], budget }, client);
  s.propose(c.id, { estimate: { hours: 1 } }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  return c;
}

test('anthropic JSON usage, with cache tokens', () => {
  const u = usageFromJson('anthropic', { model: 'model-a', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } });
  assert.deepEqual(u, { model: 'model-a', input: 100, output: 50, cacheRead: 1000, cacheWrite: 200 });
  assert.equal(priceUsage(PRICING, u), 0.0021);
  assert.deepEqual(toContractUsage(u, 1).tokens, 1350);
});

test('openai chat and responses usage split cached tokens out of input', () => {
  const chat = usageFromJson('openai', { model: 'm', usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 400 } } });
  assert.deepEqual(chat, { model: 'm', input: 600, output: 10, cacheRead: 400, cacheWrite: 0 });
  const resp = usageFromJson('openai', { type: 'response.completed', response: { model: 'm', usage: { input_tokens: 50, output_tokens: 5 } } });
  assert.equal(resp.input, 50);
});

test('anthropic streaming: input from message_start, final output from message_delta', () => {
  const p = new SseUsage('anthropic');
  p.push('event: message_start\ndata: {"type":"message_start","message":{"model":"model-a","usage":{"input_tokens":20,"output_tokens":1}}}\n\n');
  p.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"oi"}}\n\nevent: message_de');
  p.push('lta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
  assert.equal(p.usage.input, 20);
  assert.equal(p.usage.output, 42);
});

test('openai streaming: usage from the final chunk', () => {
  const p = new SseUsage('openai');
  p.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
  p.push('data: {"model":"m","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n');
  assert.equal(p.usage.output, 3);
});

test('unknown model price is recorded as unknown cost, never guessed', () => {
  assert.equal(priceUsage(PRICING, { model: 'other', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
  assert.ok(priceUsage(PRICING, { model: 'model-a-20250101', input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }) === 3);
});

test('verified usage source rejects self-reported tokens and cost, still accepts hours', () => {
  const s = new Contracts();
  s.updateConfig({ usageSource: 'verified' }, human);
  const c = building(s);
  assert.throws(() => s.reportUsage(c.id, { tokensIn: 10, costUsd: 1 }, dev), /provider proxy/);
  s.reportUsage(c.id, { hours: 1 }, dev);
  assert.equal(c.usage.hours, 1);
  assert.throws(() => s.updateConfig({ usageSource: 'whatever' }, human), /usageSource/);
});

// End-to-end through a fake provider and the real proxy handler.
async function withServers(store, providerHandler, fn) {
  const provider = createServer(providerHandler);
  await new Promise((r) => provider.listen(0, r));
  process.env.ANTHROPIC_UPSTREAM_URL = `http://localhost:${provider.address().port}`;
  const proxy = createServer((req, res) => proxyRequest(store, req, res).catch((e) => { res.writeHead(e.status ?? 500); res.end(e.message); }));
  await new Promise((r) => proxy.listen(0, r));
  try { await fn(proxy.address().port); } finally { provider.close(); proxy.close(); delete process.env.ANTHROPIC_UPSTREAM_URL; }
}
function call(port, headers, body) {
  return new Promise((resolve, reject) => {
    const r = request({ port, path: '/proxy/anthropic/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = ''; res.on('data', (d) => (data += d)); res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    r.on('error', reject); r.end(body);
  });
}

test('proxy forwards the request, returns the response and records verified usage', async () => {
  const s = new Contracts();
  s.updateConfig({ pricing: PRICING }, human);
  const c = building(s, { costUsd: 100 });
  let seen;
  await withServers(s, (req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      seen = { key: req.headers['x-api-key'], obt: req.headers['x-obt-contract'], body: JSON.parse(b) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'model-a', content: [], usage: { input_tokens: 1000, output_tokens: 100 } }));
    });
  }, async (port) => {
    const r = await call(port, { 'x-api-key': 'agent-key', 'x-obt-contract': c.id }, JSON.stringify({ model: 'model-a', messages: [] }));
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.data).usage.input_tokens, 1000);
  });
  assert.equal(seen.key, 'agent-key');
  assert.equal(seen.obt, undefined);
  assert.equal(c.usage.tokens, 1100);
  assert.equal(c.verifiedUsage.calls, 1);
  assert.equal(c.verifiedUsage.costUsd, 0.0045);
});

test('proxy refuses contracts that are not building, without calling the provider', async () => {
  const s = new Contracts();
  const c = s.createIntent({ title: 't', criteria: ['ok'] }, client);
  let called = false;
  await withServers(s, (req, res) => { called = true; res.end(); }, async (port) => {
    const r = await call(port, { 'x-obt-contract': c.id }, '{}');
    assert.equal(r.status, 409);
    assert.equal((await call(port, {}, '{}')).status, 400);
  });
  assert.equal(called, false);
});

test('verified burn past the budget escalates', async () => {
  const s = new Contracts();
  s.updateConfig({ pricing: PRICING }, human);
  const c = building(s, { tokens: 500 });
  await withServers(s, (req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"message_start","message":{"model":"model-a","usage":{"input_tokens":900,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n');
    });
  }, async (port) => { await call(port, { 'x-obt-contract': c.id }, '{}'); });
  assert.equal(c.state, 'escalated');
  assert.match(c.escalation.reason, /spent tokens 950/);
});
