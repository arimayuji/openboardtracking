import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { handleGithub, verifySignature, contractIdFrom } from '../src/github.js';

const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'dev-a' };
const human = { role: 'human', agent: 'h' };

function building(s) {
  const c = s.createIntent({ title: 'Login', criteria: ['ok'] }, client);
  s.propose(c.id, { estimate: { hours: 1 } }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  return c;
}

const pr = (c, extra = {}) => ({
  action: 'opened',
  repository: { full_name: 'acme/app' },
  pull_request: { number: 7, html_url: 'https://github.com/acme/app/pull/7', title: 'Login', body: '', head: { ref: `obt-${c.id}-login`, sha: 'abc123' }, merged: false, ...extra },
});

test('webhooks: only humans subscribe, deliveries are signed and filtered by event type', async () => {
  const s = new Contracts();
  const sent = [];
  const hooks = new Webhooks(s, { fetchImpl: async (url, opts) => { sent.push({ url, ...opts }); return { ok: true, status: 200 }; }, backoffMs: 0 });
  assert.throws(() => hooks.add({ url: 'https://x.test', secret: 's' }, dev), /only human/);
  hooks.add({ url: 'https://x.test/hook', events: ['escalated'], secret: 'shh' }, human);
  assert.equal(hooks.list()[0].secret, '***');
  const c = s.createIntent({ title: 'x', criteria: ['ok'] }, client);
  await hooks.dispatch({ id: 'noise', type: 'intent' });
  assert.equal(sent.length, 0);
  s.escalate(c.id, { reason: 'help' }, client);
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 1);
  const { body, headers } = sent[0];
  assert.equal(headers['x-obt-event'], 'escalated');
  assert.equal(headers['x-obt-signature-256'], 'sha256=' + createHmac('sha256', 'shh').update(body).digest('hex'));
  assert.equal(JSON.parse(body).contract.state, 'escalated');
});

test('webhooks: failed deliveries are retried and logged', async () => {
  const s = new Contracts();
  let calls = 0;
  const hooks = new Webhooks(s, { fetchImpl: async () => { calls++; throw new Error('down'); }, backoffMs: 0 });
  hooks.add({ url: 'https://x.test', secret: 's' }, human);
  await hooks.dispatch({ id: 'e1', type: 'intent' });
  assert.equal(calls, 3);
  assert.equal(hooks.deliveries().at(-1).error, 'down');
});

test('github: signature verification', () => {
  const raw = '{"a":1}';
  const sig = 'sha256=' + createHmac('sha256', 'k').update(raw).digest('hex');
  verifySignature(raw, sig, 'k');
  assert.throws(() => verifySignature(raw, sig, 'other'), /invalid signature/);
  assert.throws(() => verifySignature(raw, undefined, 'k'), /missing signature/);
  assert.throws(() => verifySignature(raw, sig, undefined), /not configured/);
});

test('github: contract id is found in branch, title or body', () => {
  assert.equal(contractIdFrom('obt-1a2b3c4d-login'), '1a2b3c4d');
  assert.equal(contractIdFrom(null, 'feat: login (obt:1A2B3C4D)'), '1a2b3c4d');
  assert.equal(contractIdFrom('feature/login'), null);
});

test('github: PR links evidence, CI sets verified result, merge delivers', () => {
  const s = new Contracts();
  const c = building(s);
  handleGithub(s, 'pull_request', pr(c));
  assert.equal(c.links[0].number, 7);
  handleGithub(s, 'check_suite', { action: 'completed', repository: { full_name: 'acme/app' }, check_suite: { head_sha: 'abc123', head_branch: `obt-${c.id}-login`, conclusion: 'success', pull_requests: [{ number: 7 }] } });
  assert.equal(c.verified['dod-tests'], true);
  handleGithub(s, 'pull_request', { ...pr(c, { merged: true }), action: 'closed' });
  assert.equal(c.state, 'delivered');
  assert.equal(c.delivery.by, 'integration');
});

test('github: CI result overrides the dev agent claim', () => {
  const s = new Contracts();
  const c = building(s);
  handleGithub(s, 'pull_request', pr(c));
  handleGithub(s, 'check_suite', { action: 'completed', check_suite: { head_sha: 'abc123', conclusion: 'failure', pull_requests: [] } });
  s.deliver(c.id, { results: { c1: true, 'dod-tests': true, 'dod-security': true } }, dev);
  assert.throws(() => s.accept(c.id, client), /dod-tests/);
});

test('github: verifiedOnly checks ignore self-declared results', () => {
  const s = new Contracts();
  s.updateConfig({ verifiedOnly: ['dod-security'], github: { checks: { CodeQL: 'dod-security' } } }, human);
  const c = building(s);
  s.deliver(c.id, { results: { c1: true, 'dod-tests': true, 'dod-security': true } }, dev);
  assert.throws(() => s.accept(c.id, client), /dod-security/);
  handleGithub(s, 'pull_request', pr(c));
  handleGithub(s, 'check_run', { action: 'completed', check_run: { name: 'CodeQL', head_sha: 'abc123', conclusion: 'success', pull_requests: [] } });
  s.accept(c.id, client);
  assert.equal(c.state, 'accepted');
});

test('github: integration role is not usable through agent actions', () => {
  const s = new Contracts();
  const c = building(s);
  assert.throws(() => s.deliver(c.id, {}, { role: 'integration', agent: 'x' }), /unknown role/);
});
