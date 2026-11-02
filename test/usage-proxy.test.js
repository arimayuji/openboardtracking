import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { usageFromJson, SseUsage, priceUsage, toContractUsage, proxyFetch } from '../src/usage-proxy.js';

const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'dev-a' };
const human = { role: 'human', agent: 'h' };
const PRICING = { 'model-a': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
const UPSTREAM = 'http://upstream.test';

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

// Fake provider: records what was sent and answers with the given Response.
function fakeFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, headers: init.headers });
    return answer(url, init);
  };
  return { fetchImpl, calls };
}
const proxyCall = (store, { fetchImpl, env = { ANTHROPIC_UPSTREAM_URL: UPSTREAM } }, headers, body = '{}', path = '/proxy/anthropic/v1/messages') =>
  proxyFetch(store, new Request(`http://obt.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }), { fetchImpl, env });

test('proxy forwards the request, returns the response and records verified usage', async () => {
  const s = new Contracts();
  s.updateConfig({ pricing: PRICING }, human);
  const c = building(s, { costUsd: 100 });
  const { fetchImpl, calls } = fakeFetch(() => new Response(JSON.stringify({ model: 'model-a', content: [], usage: { input_tokens: 1000, output_tokens: 100 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const res = await proxyCall(s, { fetchImpl }, { 'x-api-key': 'agent-key', 'x-obt-contract': c.id }, JSON.stringify({ model: 'model-a', messages: [] }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).usage.input_tokens, 1000);
  assert.equal(calls[0].url, `${UPSTREAM}/v1/messages`);
  assert.equal(calls[0].init.headers['x-api-key'], 'agent-key');
  assert.equal(calls[0].init.headers['x-obt-contract'], undefined);
  assert.equal(JSON.parse(new TextDecoder().decode(calls[0].init.body)).model, 'model-a');
  assert.equal(c.usage.tokens, 1100);
  assert.equal(c.verifiedUsage.calls, 1);
  assert.equal(c.verifiedUsage.costUsd, 0.0045);
});

test('proxy refuses contracts that are not building, without calling the provider', async () => {
  const s = new Contracts();
  const c = s.createIntent({ title: 't', criteria: ['ok'] }, client);
  const { fetchImpl, calls } = fakeFetch(() => new Response('{}'));
  await assert.rejects(proxyCall(s, { fetchImpl }, { 'x-obt-contract': c.id }), { status: 409 });
  await assert.rejects(proxyCall(s, { fetchImpl }, {}), { status: 400 });
  assert.equal(calls.length, 0);
});

test('verified burn past the budget escalates', async () => {
  const s = new Contracts();
  s.updateConfig({ pricing: PRICING }, human);
  const c = building(s, { tokens: 500 });
  const sse = 'data: {"type":"message_start","message":{"model":"model-a","usage":{"input_tokens":900,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n';
  const { fetchImpl } = fakeFetch(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  const res = await proxyCall(s, { fetchImpl }, { 'x-obt-contract': c.id });
  assert.equal(await res.text(), sse); // the stream passes through unchanged
  assert.equal(c.state, 'escalated');
  assert.match(c.escalation.reason, /spent tokens 950/);
});

test('upstream error is passed through and records no usage', async () => {
  const s = new Contracts();
  s.updateConfig({ pricing: PRICING }, human);
  const c = building(s);
  const { fetchImpl } = fakeFetch(() => new Response('{"error":"overloaded"}', { status: 529, headers: { 'content-type': 'application/json' } }));
  const res = await proxyCall(s, { fetchImpl }, { 'x-obt-contract': c.id });
  assert.equal(res.status, 529);
  assert.equal(await res.text(), '{"error":"overloaded"}');
  assert.equal(c.usage.tokens, 0);
});
