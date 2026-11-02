import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { handleDatadog, handleMessage, quickWins, verifyIntakeToken } from '../src/intake.js';

const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'dev-a' };
const DOD = { 'dod-tests': true, 'dod-security': true };
const alert = (extra = {}) => ({ id: '1', title: 'API 5xx > 5%', body: 'error rate high', priority: 'P1', alert_transition: 'Triggered', aggregation_key: 'api-5xx', link: 'https://dd/1', ...extra });

test('intake token is required and checked', () => {
  assert.throws(() => verifyIntakeToken('x', undefined), /not configured/);
  assert.throws(() => verifyIntakeToken('x', 'secret'), /invalid/);
  verifyIntakeToken('secret', 'secret');
});

test('P1 alert opens an expedite incident; repeats count as occurrences', () => {
  const s = new Contracts();
  const r = handleDatadog(s, alert());
  const c = s.get(r.contract);
  assert.equal(c.kind, 'incident');
  assert.equal(c.classOfService, 'expedite');
  assert.equal(c.priority, 1);
  handleDatadog(s, alert({ alert_transition: 'Re-Triggered' }));
  assert.equal(s.state.contracts.length, 1);
  assert.equal(c.occurrences, 2);
});

test('low priority alert opens a standard bug', () => {
  const s = new Contracts();
  const c = s.get(handleDatadog(s, alert({ priority: 'P4', aggregation_key: 'disk' })).contract);
  assert.equal(c.kind, 'bug');
  assert.equal(c.classOfService, 'standard');
});

test('alert-resolved only counts when the monitor recovers, not on the dev claim', () => {
  const s = new Contracts();
  const c = s.get(handleDatadog(s, alert()).contract);
  s.propose(c.id, { estimate: { hours: 1 } }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true, c2: true, 'alert-resolved': true, ...DOD } }, dev);
  assert.throws(() => s.accept(c.id, client), /alert-resolved/);
  handleDatadog(s, alert({ alert_transition: 'Recovered' }));
  s.accept(c.id, client);
  assert.equal(c.state, 'accepted');
  // fires again after closing: new contract marked as recurrence
  const again = s.get(handleDatadog(s, alert()).contract);
  assert.notEqual(again.id, c.id);
  assert.equal(again.source.recurrenceOf, c.id);
});

test('expedite work has its own WIP limit and skips the standard one', () => {
  const s = new Contracts(null, { wip: { building: 1, perAgent: 1, escalated: 3, expedite: 1 } });
  const f = s.createIntent({ title: 'feat', criteria: ['ok'] }, client);
  s.propose(f.id, { estimate: { hours: 1 } }, dev);
  s.agree(f.id, { version: 2 }, dev); s.agree(f.id, { version: 2 }, client);
  s.start(f.id, dev);
  const inc = s.get(handleDatadog(s, alert()).contract);
  s.propose(inc.id, { estimate: { hours: 1 } }, dev);
  s.agree(inc.id, { version: 2 }, dev); s.agree(inc.id, { version: 2 }, client);
  s.start(inc.id, dev); // standard limits are full, expedite still starts
  assert.equal(inc.state, 'building');
  const inc2 = s.get(handleDatadog(s, alert({ aggregation_key: 'db' })).contract);
  s.propose(inc2.id, { estimate: { hours: 1 } }, dev);
  s.agree(inc2.id, { version: 2 }, dev); s.agree(inc2.id, { version: 2 }, client);
  assert.throws(() => s.start(inc2.id, dev), /expedite/);
});

test('clients cannot open expedite work themselves', () => {
  const s = new Contracts();
  assert.throws(() => s.createIntent({ title: 'x', criteria: ['ok'], classOfService: 'expedite' }, client), /only incident signals/);
  assert.throws(() => s.openSignal({ title: 'x', criteria: ['ok'] }, client), /only integrations/);
});

test('chat bug report opens a bug; same thread is deduplicated', () => {
  const s = new Contracts();
  const r = handleMessage(s, { source: 'slack', from: 'cliente@acme', text: 'Checkout quebra no cupom\nao aplicar CUPOM10 dá erro 500', link: 'https://slack/t/1' });
  const c = s.get(r.contract);
  assert.equal(c.title, '[bug] Checkout quebra no cupom');
  assert.equal(c.kind, 'bug');
  handleMessage(s, { source: 'slack', text: 'ainda quebrando', link: 'https://slack/t/1' });
  assert.equal(c.occurrences, 2);
  assert.throws(() => handleMessage(s, { text: '  ' }), /text is required/);
});

test('quick wins use the calibrated estimate; unestimated bugs need sizing', () => {
  const s = new Contracts();
  const small = s.get(handleMessage(s, { text: 'typo no rodapé' }).contract);
  const big = s.get(handleMessage(s, { text: 'relatório lento' }).contract);
  handleMessage(s, { text: 'sem estimativa ainda' });
  s.propose(small.id, { estimate: { hours: 0.5 } }, dev);
  s.propose(big.id, { estimate: { hours: 5 } }, dev);
  const q = quickWins(s, { maxHours: 2 });
  assert.deepEqual(q.quickWins.map((x) => x.id), [small.id]);
  assert.equal(q.quickWins[0].p85Hours, 1.13);
  assert.equal(q.needsEstimate.length, 1);
});
