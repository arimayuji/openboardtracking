import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';

const client = { role: 'client', agent: 'client-agent' };
const dev = { role: 'dev', agent: 'dev-agent' };
const human = { role: 'human', agent: 'alice' };

const open = (s, extra = {}) => s.createIntent({ title: 'Login', criteria: ['login works', 'tests green'], ...extra }, client);

test('happy path: negotiate, agree, build, deliver, accept', () => {
  const s = new Contracts();
  const c = open(s);
  s.propose(c.id, { estimate: { hours: 4 }, plan: 'oauth' }, dev);
  s.agree(c.id, { version: 2 }, dev);
  s.agree(c.id, { version: 2 }, client);
  assert.equal(c.state, 'agreed');
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true, c2: true }, links: ['pr/1'] }, dev);
  s.accept(c.id, client);
  assert.equal(c.state, 'accepted');
});

test('roles cannot cross their boundaries', () => {
  const s = new Contracts();
  const c = open(s);
  assert.throws(() => s.createIntent({ title: 'x', criteria: ['y'] }, dev), /only client/);
  assert.throws(() => s.propose(c.id, { criteria: ['less work'] }, dev), /cannot change acceptance criteria/);
  assert.throws(() => s.propose(c.id, { estimate: { hours: 1 } }, client), /cannot set estimate/);
  assert.throws(() => s.start(c.id, client), /cannot start/);
});

test('new proposal invalidates previous agreement', () => {
  const s = new Contracts();
  const c = open(s);
  s.propose(c.id, { estimate: { hours: 4 } }, dev);
  s.agree(c.id, { version: 2 }, dev);
  s.propose(c.id, { criteria: ['login works', 'tests green', 'mfa'] }, client);
  assert.deepEqual(c.agreedBy, []);
  assert.throws(() => s.agree(c.id, { version: 2 }, client), /stale version/);
});

test('acceptance is mechanical', () => {
  const s = new Contracts();
  const c = open(s);
  s.propose(c.id, { estimate: { hours: 2 } }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true, c2: false } }, dev);
  assert.throws(() => s.accept(c.id, client), /c2/);
});

test('over budget escalates to human, who can approve', () => {
  const s = new Contracts();
  const c = open(s, { budget: { hours: 5 } });
  s.propose(c.id, { estimate: { hours: 20 } }, dev);
  assert.equal(c.state, 'escalated');
  assert.equal(s.summary().needsHuman.length, 1);
  assert.throws(() => s.resolve(c.id, { decision: 'approve' }, client), /cannot resolve/);
  s.resolve(c.id, { decision: 'approve', budget: { hours: 100 } }, human);
  assert.equal(c.state, 'agreed');
});

test('too many rounds escalate', () => {
  const s = new Contracts();
  const c = open(s);
  for (let i = 0; i < 6; i++)
    i % 2 ? s.propose(c.id, { criteria: [`v${i}`] }, client) : s.propose(c.id, { estimate: { hours: i + 1 } }, dev);
  assert.equal(c.state, 'escalated');
});

test('irreversible changes need human approval to accept', () => {
  const s = new Contracts();
  const c = open(s, { irreversible: true });
  s.propose(c.id, { estimate: { hours: 1 } }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true, c2: true } }, dev);
  s.accept(c.id, client);
  assert.equal(c.state, 'escalated');
  s.resolve(c.id, { decision: 'approve' }, human);
  assert.equal(c.state, 'accepted');
});

test('usage is tracked live and escalates when burn passes budget', () => {
  const s = new Contracts();
  const c = open(s, { budget: { tokens: 1_000_000, costUsd: 20 } });
  s.propose(c.id, { estimate: { hours: 1, tokens: 100_000, costUsd: 2 } }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  s.reportUsage(c.id, { tokensIn: 50_000, tokensOut: 10_000, costUsd: 1.5, model: 'model-a', toolCalls: 12, hours: 0.5 }, dev);
  assert.equal(c.usage.tokens, 60_000);
  assert.equal(c.usage.byModel['model-a'].costUsd, 1.5);
  assert.throws(() => s.reportUsage(c.id, { costUsd: 1 }, client), /cannot usage/);
  s.reportUsage(c.id, { costUsd: 25 }, dev);
  assert.equal(c.state, 'escalated');
  assert.match(c.escalation.reason, /spent costUsd/);
  s.resolve(c.id, { decision: 'approve', budget: { costUsd: 50 } }, human);
  assert.equal(c.state, 'building');
});
