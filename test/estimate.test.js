import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { calibrate, calibration, forecast } from '../src/estimate.js';

const client = { role: 'client', agent: 'c' };
const devA = { role: 'dev', agent: 'dev-a' };

// Runs a contract to acceptance with a given estimate and actual usage.
function complete(s, dev, estimate, usage) {
  const c = s.createIntent({ title: 't', criteria: ['ok'] }, client);
  s.propose(c.id, { estimate }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true }, usage }, dev);
  s.accept(c.id, client);
  return c;
}

test('without history uses conservative default and says so', () => {
  const r = calibrate(new Contracts(), { hours: 10, tokens: 1000 });
  assert.equal(r.hours.source, 'default');
  assert.ok(r.tokens.p85 > r.tokens.raw);
});

test('calibrates each metric independently', () => {
  const s = new Contracts();
  // hours estimates are spot on, tokens are always 3x underestimated
  for (let i = 0; i < 5; i++) complete(s, devA, { hours: 2, tokens: 100_000 }, { hours: 2, tokens: 300_000 });
  const r = calibrate(s, { hours: 10, tokens: 100_000 }, 'dev-a');
  assert.equal(r.hours.p50, 10);
  assert.equal(r.tokens.p50, 300_000);
  assert.equal(r.tokens.source, 'agent');
  assert.equal(calibration(s)['dev-a'].tokens.medianRatio, 3);
});

test('budget is checked against calibrated P85, not raw estimate', () => {
  const s = new Contracts();
  for (let i = 0; i < 5; i++) complete(s, devA, { costUsd: 1 }, { costUsd: 2, hours: 1 });
  const c = s.createIntent({ title: 'x', criteria: ['ok'], budget: { costUsd: 15 } }, client);
  s.propose(c.id, { estimate: { costUsd: 10 } }, devA); // raw 10 fits, calibrated 20 does not
  assert.equal(c.state, 'escalated');
  assert.match(c.escalation.reason, /P85 costUsd 20/);
});

test('forecast subtracts what was already spent and flags unestimated', () => {
  const s = new Contracts();
  for (let i = 0; i < 5; i++) complete(s, devA, { hours: 4, costUsd: 1 }, { hours: 4, costUsd: 1 });
  const a = s.createIntent({ title: 'a', criteria: ['ok'] }, client);
  s.propose(a.id, { estimate: { hours: 10, costUsd: 5 } }, devA);
  s.agree(a.id, { version: 2 }, devA); s.agree(a.id, { version: 2 }, client);
  s.start(a.id, devA);
  s.reportUsage(a.id, { hours: 4, costUsd: 2 }, devA);
  s.createIntent({ title: 'b', criteria: ['ok'] }, client); // no estimate yet
  const f = forecast(s, { runs: 100, parallel: 2 });
  assert.equal(f.openContracts, 2);
  assert.equal(f.metrics.hours.remaining.p50, 6);
  assert.equal(f.metrics.costUsd.spent, 2);
  assert.equal(f.calendarHours.p50, 3);
  assert.equal(f.metrics.hours.unestimated.length, 1);
  assert.ok(f.note);
});
