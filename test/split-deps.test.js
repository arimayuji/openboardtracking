import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';

const DOD = { 'dod-tests': true, 'dod-security': true };
const client = { role: 'client', agent: 'client-agent' };
const dev = { role: 'dev', agent: 'dev-agent' };
const human = { role: 'human', agent: 'alice' };

const intent = (s, extra = {}) => s.createIntent({ title: 'Painel', criteria: ['tela abre', 'testes verdes'], ...extra }, client);

// Moves a contract to agreed (dev estimates, both agree on version 2).
const agreeAll = (s, c) => {
  s.propose(c.id, { estimate: { hours: 2 } }, dev);
  s.agree(c.id, { version: 2 }, dev);
  s.agree(c.id, { version: 2 }, client);
};

const finish = (s, c) => {
  s.start(c.id, dev);
  s.deliver(c.id, { results: { c1: true, c2: true, ...DOD } }, dev);
  s.accept(c.id, client);
};

const twoParts = [
  { title: 'Parte A', criteria: ['A funciona'] },
  { title: 'Parte B', criteria: ['B funciona'] },
];

test('value fields are stored on the contract, null when absent', () => {
  const s = new Contracts();
  const c = intent(s, { valueScore: 4, valueBrl: 1500 });
  assert.equal(c.valueScore, 4);
  assert.equal(c.valueBrl, 1500);
  const d = intent(s);
  assert.equal(d.valueScore, null);
  assert.equal(d.valueBrl, null);
  const z = intent(s, { valueScore: 1, valueBrl: 0 });
  assert.equal(z.valueBrl, 0);
});

test('invalid valueScore and valueBrl are rejected with 400', () => {
  const s = new Contracts();
  for (const valueScore of [0, 6, 2.5, '3']) {
    assert.throws(() => intent(s, { valueScore }), (e) => e.status === 400 && e.message === 'valueScore deve ser de 1 a 5');
  }
  assert.throws(() => intent(s, { valueBrl: -1 }), (e) => e.status === 400);
  assert.throws(() => intent(s, { valueBrl: '100' }), (e) => e.status === 400);
});

test('split creates children inheriting goal and area, with parentId', () => {
  const s = new Contracts();
  const goal = s.createGoal({ title: 'Onboarding' }, client);
  const parent = intent(s, { goalId: goal.id, area: 'web', sensitive: false, priority: 1 });
  agreeAll(s, parent);
  assert.equal(parent.state, 'agreed');
  const { parent: p, children } = s.splitContract(parent.id, { parts: twoParts }, client);
  assert.equal(p, parent);
  assert.equal(children.length, 2);
  for (const ch of children) {
    assert.equal(ch.parentId, parent.id);
    assert.equal(ch.goalId, goal.id);
    assert.equal(ch.area, 'web');
    assert.equal(ch.priority, 1);
    assert.deepEqual(ch.budget, {});
    assert.equal(ch.state, 'negotiating');
  }
  assert.deepEqual(parent.childIds, children.map((x) => x.id));
  assert.equal(parent.state, 'negotiating');
  assert.deepEqual(parent.agreedBy, []);
  const splitEv = s.history(parent.id).find((e) => e.type === 'split');
  assert.deepEqual(splitEv.data.childIds, parent.childIds);
  assert.ok(s.history(children[0].id).some((e) => e.type === 'intent' && e.role === 'client'));
});

test('dev can split too', () => {
  const s = new Contracts();
  const c = intent(s);
  const { children } = s.splitContract(c.id, { parts: twoParts }, dev);
  assert.equal(children.length, 2);
});

test('human cannot split', () => {
  const s = new Contracts();
  const c = intent(s);
  assert.throws(() => s.splitContract(c.id, { parts: twoParts }, human), (e) => e.status === 403);
});

test('cannot split a contract that is building', () => {
  const s = new Contracts();
  const c = intent(s);
  agreeAll(s, c);
  s.start(c.id, dev);
  assert.throws(() => s.splitContract(c.id, { parts: twoParts }, client), (e) => e.status === 409);
});

test('split needs at least 2 parts, each with title and criteria', () => {
  const s = new Contracts();
  const c = intent(s);
  assert.throws(() => s.splitContract(c.id, { parts: [twoParts[0]] }, client), (e) => e.status === 400);
  assert.throws(() => s.splitContract(c.id, { parts: [twoParts[0], { title: 'x', criteria: [] }] }, client), (e) => e.status === 400);
  assert.throws(() => s.splitContract(c.id, { parts: [twoParts[0], { criteria: ['y'] }] }, client), (e) => e.status === 400);
  assert.equal(c.childIds, undefined);
});

test('a contract cannot be split twice', () => {
  const s = new Contracts();
  const c = intent(s);
  s.splitContract(c.id, { parts: twoParts }, client);
  assert.throws(() => s.splitContract(c.id, { parts: twoParts }, client), (e) => e.status === 409);
});

test('parent with children cannot start', () => {
  const s = new Contracts();
  const c = intent(s);
  agreeAll(s, c);
  s.splitContract(c.id, { parts: twoParts }, client);
  assert.throws(() => s.start(c.id, dev), (e) => e.status === 409 && e.message === 'Este pedido foi dividido; trabalhe nas partes.');
});

test('parent is accepted automatically when every child is accepted', () => {
  const s = new Contracts();
  const parent = intent(s);
  const { children: [a, b] } = s.splitContract(parent.id, { parts: twoParts }, client);
  agreeAll(s, a);
  finish(s, a);
  assert.equal(parent.state, 'negotiating');
  agreeAll(s, b);
  finish(s, b);
  assert.equal(parent.state, 'accepted');
  assert.ok(parent.acceptedAt);
  const ev = s.history(parent.id).find((e) => e.type === 'accept');
  assert.equal(ev.data.auto, true);
  assert.equal(ev.role, 'system');
  assert.equal(ev.agent, 'system');
});

test('parent is auto-accepted when the last child is accepted by a human resolve', () => {
  const s = new Contracts();
  const parent = intent(s);
  const { children: [a, b] } = s.splitContract(parent.id, { parts: twoParts }, client);
  agreeAll(s, a);
  finish(s, a);
  agreeAll(s, b);
  s.start(b.id, dev);
  s.deliver(b.id, { results: { c1: true, c2: true, ...DOD } }, dev);
  // Irreversible work escalates on accept; the human approval accepts it.
  b.irreversible = true;
  s.accept(b.id, client);
  assert.equal(b.state, 'escalated');
  assert.equal(parent.state, 'negotiating');
  s.resolve(b.id, { decision: 'approve' }, human);
  assert.equal(b.state, 'accepted');
  assert.equal(parent.state, 'accepted');
});

test('addDependency blocks start until the dependency is accepted', () => {
  const s = new Contracts();
  const a = intent(s, { title: 'A' });
  const b = intent(s, { title: 'B' });
  s.addDependency(a.id, b.id, client);
  assert.deepEqual(s.blockers(a.id), [b.id]);
  agreeAll(s, a);
  assert.throws(() => s.start(a.id, dev), (e) => e.status === 409 && e.message === 'Este pedido depende de outros que ainda não foram entregues.');
  agreeAll(s, b);
  finish(s, b);
  assert.deepEqual(s.blockers(a.id), []);
  s.start(a.id, dev);
  assert.equal(a.state, 'building');
});

test('dependency ids are not duplicated', () => {
  const s = new Contracts();
  const a = intent(s, { title: 'A' });
  const b = intent(s, { title: 'B' });
  s.addDependency(a.id, b.id, client);
  s.addDependency(a.id, b.id, dev);
  assert.deepEqual(a.dependsOn, [b.id]);
});

test('cycles are rejected with 400', () => {
  const s = new Contracts();
  const a = intent(s, { title: 'A' });
  const b = intent(s, { title: 'B' });
  s.addDependency(a.id, b.id, client);
  assert.throws(() => s.addDependency(b.id, a.id, client), (e) => e.status === 400 && e.message === 'Isso criaria uma dependência circular.');
  assert.equal(b.dependsOn, undefined);
});

test('a contract cannot depend on itself', () => {
  const s = new Contracts();
  const a = intent(s);
  assert.throws(() => s.addDependency(a.id, a.id, client), (e) => e.status === 400);
});

test('dependencies need client or dev, and both contracts must exist', () => {
  const s = new Contracts();
  const a = intent(s);
  assert.throws(() => s.addDependency(a.id, a.id, human), (e) => e.status === 403);
  assert.throws(() => s.addDependency(a.id, 'nope', client), (e) => e.status === 404);
  assert.throws(() => s.addDependency('nope', a.id, client), (e) => e.status === 404);
});

test('removeDependency unblocks the contract', () => {
  const s = new Contracts();
  const a = intent(s, { title: 'A' });
  const b = intent(s, { title: 'B' });
  s.addDependency(a.id, b.id, client);
  agreeAll(s, a);
  assert.throws(() => s.start(a.id, dev), /depende/);
  s.removeDependency(a.id, b.id, dev);
  assert.deepEqual(s.blockers(a.id), []);
  s.start(a.id, dev);
  assert.equal(a.state, 'building');
  assert.ok(s.history(a.id).some((e) => e.type === 'undepends'));
});
