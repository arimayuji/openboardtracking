import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { flow } from '../src/flow.js';

const DOD = { 'dod-tests': true, 'dod-security': true };
const client = { role: 'client', agent: 'c' };
const human = { role: 'human', agent: 'h' };
const dev = (agent = 'dev-a') => ({ role: 'dev', agent });

function agreed(s, d = dev(), extra = {}) {
  const c = s.createIntent({ title: 't', criteria: ['ok'], ...extra }, client);
  s.propose(c.id, { estimate: { hours: 1 } }, d);
  s.agree(c.id, { version: 2 }, d); s.agree(c.id, { version: 2 }, client);
  return c;
}

test('WIP limit per agent and global', () => {
  const s = new Contracts(null, { wip: { building: 3, perAgent: 2, escalated: 3 } });
  s.start(agreed(s).id, dev()); s.start(agreed(s).id, dev());
  assert.throws(() => s.start(agreed(s).id, dev()), /agent dev-a already has 2/);
  s.start(agreed(s, dev('dev-b')).id, dev('dev-b'));
  assert.throws(() => s.start(agreed(s, dev('dev-c')).id, dev('dev-c')), /3 contracts already building/);
});

test('pending escalations block new work: human attention is a WIP limit', () => {
  const s = new Contracts(null, { wip: { building: 10, perAgent: 10, escalated: 1 } });
  const c = agreed(s);
  s.escalate(c.id, { reason: 'need decision' }, client);
  assert.throws(() => s.start(agreed(s).id, dev()), /escalations waiting for humans/);
});

test('definition of done is required and only humans change it', () => {
  const s = new Contracts();
  const c = agreed(s);
  s.start(c.id, dev());
  s.deliver(c.id, { results: { c1: true } }, dev());
  assert.throws(() => s.accept(c.id, client), /dod-tests, dod-security/);
  assert.throws(() => s.updateConfig({ dod: [] }, client), /only human/);
  assert.throws(() => s.updateConfig({ dod: [] }, dev()), /only human/);
});

test('dod is snapshotted: changing it does not affect contracts in flight', () => {
  const s = new Contracts();
  const old = agreed(s);
  s.updateConfig({ dod: ['tests pass', 'code reviewed', 'docs updated'] }, human);
  const fresh = s.createIntent({ title: 'n', criteria: ['ok'] }, client);
  assert.equal(old.dod.length, 2);
  assert.equal(fresh.dod.length, 3);
  assert.equal(fresh.dod[1].id, 'dod-2');
});

test('flow metrics: cycle time, throughput and stale WIP', () => {
  const s = new Contracts();
  const c = agreed(s);
  s.start(c.id, dev());
  s.deliver(c.id, { results: { c1: true, ...DOD } }, dev());
  s.accept(c.id, client);
  // simulate 10h of cycle time
  c.startedAt = new Date(Date.parse(c.acceptedAt) - 10 * 3600e3).toISOString();
  const stuck = agreed(s);
  s.start(stuck.id, dev());
  const f = flow(s, { nowMs: Date.now() + 20 * 3600e3 });
  assert.equal(f.cycleTimeHours.p50, 10);
  assert.equal(f.throughput.accepted, 1);
  assert.equal(f.wip.building, 1);
  assert.deepEqual(f.stale, [stuck.id]);
});
