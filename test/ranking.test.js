import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { ranking } from '../src/ranking.js';
import { quickWins } from '../src/intake.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';

const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'd' };
const human = { role: 'human', agent: 'h' };

// Default calibration (no history): p85 of est * [0.8, 1, 1.2, 1.5, 2, 3]
// est 1 -> 2.25, est 2 -> 4.5, est 4 -> 9, est 12 -> 27.
function make(store, { title, est, valueScore, dependsOn, childIds, priority } = {}) {
  const c = store.createIntent({ title: title ?? 'pedido', criteria: ['ok'], ...(priority ? { priority } : {}) }, client);
  if (est != null) store.propose(c.id, { estimate: { hours: est } }, dev);
  if (valueScore !== undefined) c.valueScore = valueScore;
  if (dependsOn) c.dependsOn = dependsOn;
  if (childIds) c.childIds = childIds;
  return c;
}

test('ranks by valueScore / p85 hours, highest first', () => {
  const s = new Contracts();
  const a = make(s, { title: 'A', est: 1, valueScore: 5 });   // 5 / 2.25 = 2.22
  const b = make(s, { title: 'B', est: 1, valueScore: 3 });   // 3 / 2.25 = 1.33
  const c = make(s, { title: 'C', est: 4, valueScore: 5 });   // 5 / 9 = 0.56
  const r = ranking(s);
  assert.deepEqual(r.ranked.map((x) => x.id), [a.id, b.id, c.id]);
  assert.equal(r.ranked[0].score, 2.22);
  assert.equal(r.ranked[0].p85Hours, 2.25);
  assert.equal(r.ranked[2].score, 0.56);
  assert.deepEqual(Object.keys(r.ranked[0]).sort(), ['id', 'p85Hours', 'reason', 'score', 'title', 'valueBrl', 'valueScore']);
});

test('missing valueScore counts as 3 and valueBrl is null when absent', () => {
  const s = new Contracts();
  const a = make(s, { est: 1 });
  const [item] = ranking(s).ranked;
  assert.equal(item.id, a.id);
  assert.equal(item.valueScore, 3);
  assert.equal(item.valueBrl, null);
  a.valueBrl = 1500;
  assert.equal(ranking(s).ranked[0].valueBrl, 1500);
});

test('work without an estimate goes to needsEstimate, not ranked', () => {
  const s = new Contracts();
  const a = make(s, { title: 'sem estimativa', valueScore: 4 });
  const r = ranking(s);
  assert.deepEqual(r.ranked, []);
  assert.deepEqual(r.needsEstimate, [{ id: a.id, title: 'sem estimativa', valueScore: 4 }]);
});

test('a contract waiting on another one is blocked with the blocking ids', () => {
  const s = new Contracts();
  const a = make(s, { title: 'base', est: 1, valueScore: 5 });
  const b = make(s, { title: 'depende', est: 1, valueScore: 5, dependsOn: [a.id] });
  let r = ranking(s);
  assert.deepEqual(r.blocked, [{ id: b.id, title: 'depende', blockedBy: [a.id] }]);
  assert.deepEqual(r.ranked.map((x) => x.id), [a.id]);
  // once the dependency is accepted, the work becomes rankable
  a.state = 'accepted';
  r = ranking(s);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(r.ranked.map((x) => x.id), [b.id]);
});

test('a dependency that is only building still blocks', () => {
  const s = new Contracts();
  const a = make(s, { est: 1 });
  a.state = 'building';
  const b = make(s, { est: 1, dependsOn: [a.id] });
  assert.deepEqual(ranking(s).blocked, [{ id: b.id, title: 'pedido', blockedBy: [a.id] }]);
});

test('parents with childIds are excluded from every list', () => {
  const s = new Contracts();
  const child = make(s, { est: 1, valueScore: 4 });
  const parent = make(s, { est: 1, valueScore: 5, childIds: [child.id] });
  const parentNoEst = make(s, { valueScore: 5, childIds: [child.id] });
  const r = ranking(s);
  const ids = [...r.ranked, ...r.needsEstimate, ...r.blocked].map((x) => x.id);
  assert.ok(!ids.includes(parent.id));
  assert.ok(!ids.includes(parentNoEst.id));
  assert.deepEqual(r.ranked.map((x) => x.id), [child.id]);
});

test('reasons for the special cases and the balanced default', () => {
  const s = new Contracts();
  const fast = make(s, { est: 1, valueScore: 5 });        // p85 2.25 <= 8, value 5
  const big = make(s, { est: 12, valueScore: 4 });        // p85 27 > 24, value 4
  const low = make(s, { est: 4, valueScore: 2 });         // p85 9 > 8, value 2
  const mid = make(s, { est: 4, valueScore: 3 });         // neither rule
  const byId = Object.fromEntries(ranking(s).ranked.map((x) => [x.id, x.reason]));
  assert.equal(byId[fast.id], 'Alto valor e rápido de fazer');
  assert.equal(byId[big.id], 'Alto valor, mas grande: considere dividir');
  assert.equal(byId[low.id], 'Baixo valor para o esforço');
  assert.equal(byId[mid.id], 'Valor e esforço equilibrados');
});

test('GET /api/ranking returns { ranked, needsEstimate, blocked } for any signed-in actor', async () => {
  const store = new Contracts();
  const hooks = new Webhooks(store, { fetchImpl: async () => ({ ok: true, status: 200 }) });
  const slack = new Slack(store, { token: undefined });
  const app = createApp({ store, hooks, slack, env: {}, fetchImpl: async () => ({ ok: true, status: 200 }) });
  const a = make(store, { title: 'A', est: 1, valueScore: 5 });
  make(store, { title: 'sem estimativa' });
  const res = await app.handle(new Request('http://x/api/ranking'), human);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ranked[0].id, a.id);
  assert.equal(body.needsEstimate.length, 1);
  assert.deepEqual(body.blocked, []);
  const anon = await app.handle(new Request('http://x/api/ranking'), null);
  assert.equal(anon.status, 401);
});

test('quickWins breaks ties on priority by valueScore (higher first)', () => {
  const s = new Contracts();
  const low = make(s, { title: 'baixo', est: 0.5, valueScore: 2 });
  const high = make(s, { title: 'alto', est: 0.5, valueScore: 5 });
  const none = make(s, { title: 'sem valor', est: 0.5 });           // defaults to 3
  const urgent = make(s, { title: 'urgente', est: 0.5, valueScore: 1, priority: 1 });
  const ids = quickWins(s).quickWins.map((x) => x.id);
  assert.deepEqual(ids, [urgent.id, high.id, none.id, low.id]);
});
