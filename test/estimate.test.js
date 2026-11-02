import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { calibrate, calibration, forecast } from '../src/estimate.js';

const client = { role: 'client', agent: 'c' };
const devA = { role: 'dev', agent: 'dev-a' };

// Runs a contract to acceptance with a given estimate and actual effort.
function complete(s, dev, est, actual) {
  const c = s.createIntent({ title: 't', criteria: ['ok'] }, client);
  s.propose(c.id, { estimateHours: est }, dev);
  s.agree(c.id, { version: 2 }, dev); s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true }, actualHours: actual }, dev);
  s.accept(c.id, client);
  return c;
}

test('without history uses conservative default and says so', () => {
  const r = calibrate(new Contracts(), 10);
  assert.equal(r.source, 'default');
  assert.ok(r.p85 > r.raw);
});

test('agent that always underestimates by 2x gets calibrated', () => {
  const s = new Contracts();
  for (let i = 0; i < 5; i++) complete(s, devA, 4, 8);
  const r = calibrate(s, 10, 'dev-a');
  assert.equal(r.source, 'agent');
  assert.equal(r.p50, 20);
  assert.equal(calibration(s)['dev-a'].medianRatio, 2);
});

test('budget is checked against calibrated P85, not raw estimate', () => {
  const s = new Contracts();
  for (let i = 0; i < 5; i++) complete(s, devA, 4, 8);
  const c = s.createIntent({ title: 'x', criteria: ['ok'], budgetHours: 15 }, client);
  s.propose(c.id, { estimateHours: 10 }, devA); // raw 10 fits, calibrated 20 does not
  assert.equal(c.state, 'escalated');
  assert.match(c.escalation.reason, /P85 estimate 20h/);
});

test('forecast aggregates open contracts and flags unestimated ones', () => {
  const s = new Contracts();
  for (let i = 0; i < 5; i++) complete(s, devA, 4, 4);
  const a = s.createIntent({ title: 'a', criteria: ['ok'] }, client);
  s.propose(a.id, { estimateHours: 10 }, devA);
  s.createIntent({ title: 'b', criteria: ['ok'] }, client); // no estimate yet
  const f = forecast(s, { runs: 100, parallel: 2 });
  assert.equal(f.openContracts, 2);
  assert.equal(f.unestimated.length, 1);
  assert.equal(f.effortHours.p50, 10);
  assert.equal(f.calendarHours.p50, 5);
  assert.ok(f.note);
});
