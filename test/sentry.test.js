import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Contracts } from '../src/contract.js';
import { handleSentry, verifySentrySignature } from '../src/sentry.js';

const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'dev-a' };
const DOD = { 'dod-tests': true, 'dod-security': true };
const issue = (extra = {}) => ({ id: '4242', shortId: 'APP-1A', title: "TypeError: Cannot read properties of undefined (reading 'total')", culprit: 'checkout/cart.js in applyCoupon', level: 'error', count: '12', userCount: 5, web_url: 'https://sentry.io/issues/4242/', project: { slug: 'web' }, ...extra });
const send = (s, action, extra) => handleSentry(s, 'issue', { action, data: { issue: issue(extra) } });

test('signature is checked with the client secret', () => {
  const raw = '{"a":1}';
  const sig = createHmac('sha256', 'k').update(raw).digest('hex');
  verifySentrySignature(raw, sig, 'k');
  assert.throws(() => verifySentrySignature(raw, sig, 'x'), /invalid/);
  assert.throws(() => verifySentrySignature(raw, undefined, 'k'), /missing/);
  assert.throws(() => verifySentrySignature(raw, sig, undefined), /not configured/);
});

test('new issue opens a bug with source data; fatal opens an expedite incident', () => {
  const s = new Contracts();
  const c = s.get(send(s, 'created').contract);
  assert.equal(c.kind, 'bug');
  assert.equal(c.priority, 2);
  assert.equal(c.source.users, 5);
  assert.equal(c.source.events, 12);
  assert.match(c.title, /^\[sentry\] TypeError/);
  const f = s.get(send(s, 'created', { id: '99', level: 'fatal' }).contract);
  assert.equal(f.kind, 'incident');
  assert.equal(f.classOfService, 'expedite');
});

test('alert for the same issue is an occurrence, not new work', () => {
  const s = new Contracts();
  const c = s.get(send(s, 'created').contract);
  handleSentry(s, 'event_alert', { action: 'triggered', data: { event: { issue_id: '4242', title: 'TypeError', level: 'error' } } });
  assert.equal(s.state.contracts.length, 1);
  assert.equal(c.occurrences, 2);
});

test('resolved in Sentry is the only way to pass sentry-resolved; regression reverts it', () => {
  const s = new Contracts();
  const c = s.get(send(s, 'created').contract);
  s.propose(c.id, { estimate: { hours: 1 } }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true, c2: true, 'sentry-resolved': true, ...DOD } }, dev);
  assert.throws(() => s.accept(c.id, client), /sentry-resolved/);
  send(s, 'resolved');
  assert.equal(c.verified['sentry-resolved'], true);
  send(s, 'unresolved', { count: '30' });
  assert.equal(c.verified['sentry-resolved'], false);
  assert.equal(c.source.events, 30);
  send(s, 'resolved');
  s.accept(c.id, client);
  assert.equal(c.state, 'accepted');
});

test('regression after the contract was closed opens new work marked as recurrence', () => {
  const s = new Contracts();
  const c = s.get(send(s, 'created').contract);
  s.escalate(c.id, { reason: 'x' }, client);
  s.resolve(c.id, { decision: 'cancel' }, { role: 'human', agent: 'h' });
  const again = s.get(send(s, 'unresolved').contract);
  assert.notEqual(again.id, c.id);
  assert.equal(again.source.recurrenceOf, c.id);
});

test('unknown resources and actions are ignored', () => {
  const s = new Contracts();
  assert.match(handleSentry(s, 'metric_alert', { action: 'critical', data: {} }).ignored, /resource/);
  assert.match(send(s, 'assigned').ignored, /action/);
  assert.equal(s.state.contracts.length, 0);
});
