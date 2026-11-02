import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';

const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'dev-a' };
const human = { role: 'human', agent: 'h' };

function setup(env = {}) {
  const store = new Contracts();
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const hooks = new Webhooks(store, { fetchImpl });
  const slack = new Slack(store, { token: undefined });
  const app = createApp({ store, hooks, slack, env, fetchImpl });
  return { store, app };
}

const req = (path, { method = 'GET', body, headers = {} } = {}) => new Request(`http://x${path}`, {
  method,
  headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('client creates an intent and gets the contract as JSON', async () => {
  const { app } = setup();
  const res = await app.handle(req('/api/contracts', { method: 'POST', body: { title: 'a', criteria: ['b'] } }), client);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const c = await res.json();
  assert.equal(c.title, 'a');
  assert.equal(c.state, 'negotiating');
});

test('a dev cannot create an intent (403)', async () => {
  const { app } = setup();
  const res = await app.handle(req('/api/contracts', { method: 'POST', body: { title: 'a', criteria: ['b'] } }), dev);
  assert.equal(res.status, 403);
  assert.ok((await res.json()).error);
});

test('GET /api/contracts filters by ?state=', async () => {
  const { app } = setup();
  await app.handle(req('/api/contracts', { method: 'POST', body: { title: 'a', criteria: ['b'] } }), client);
  const hit = await app.handle(req('/api/contracts?state=negotiating'), human);
  assert.equal(hit.status, 200);
  assert.equal((await hit.json()).length, 1);
  const miss = await app.handle(req('/api/contracts?state=building'), human);
  assert.deepEqual(await miss.json(), []);
});

test('unknown route is 404 with a JSON error', async () => {
  const { app } = setup();
  const res = await app.handle(req('/api/nope'), human);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not found' });
});

test('invalid JSON body is 400', async () => {
  const { app } = setup();
  const res = await app.handle(req('/api/contracts', { method: 'POST', body: '{bad' }), client);
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test('digest is human-only', async () => {
  const { app } = setup();
  const res = await app.handle(req('/api/slack/digest', { method: 'POST', body: {} }), dev);
  assert.equal(res.status, 403);
});

test('intake rejects a bad token (401) and accepts the configured one', async () => {
  const { app } = setup({ INTAKE_TOKEN: 'secret-token' });
  const body = { text: 'the login page is down', source: 'test' };
  const bad = await app.handle(req('/api/intake/message', { method: 'POST', body, headers: { 'x-obt-intake-token': 'nope' } }), null);
  assert.equal(bad.status, 401);
  const good = await app.handle(req('/api/intake/message', { method: 'POST', body, headers: { 'x-obt-intake-token': 'secret-token' } }), null);
  assert.equal(good.status, 200);
});

test('github webhook rejects a bad signature (401)', async () => {
  const { app } = setup({ GITHUB_WEBHOOK_SECRET: 'gh-secret' });
  const raw = JSON.stringify({ action: 'opened' });
  const bad = await app.handle(req('/api/integrations/github', {
    method: 'POST', body: raw, headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': 'sha256=deadbeef' },
  }), null);
  assert.equal(bad.status, 401);
  const good = createHmac('sha256', 'gh-secret').update(raw).digest('hex');
  const ok = await app.handle(req('/api/integrations/github', {
    method: 'POST', body: raw, headers: { 'x-github-event': 'ping', 'x-hub-signature-256': `sha256=${good}` },
  }), null);
  assert.equal(ok.status, 200);
});
