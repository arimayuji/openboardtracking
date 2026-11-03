import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';

const DOD = { 'dod-tests': true, 'dod-security': true };
const client = { role: 'client', agent: 'client-agent' };
const dev = { role: 'dev', agent: 'dev-agent' };
const human = { role: 'human', agent: 'alice' };

const open = (s, extra = {}) => s.createIntent({ title: 'Login', criteria: ['login works', 'tests green'], ...extra }, client);

// Negotiate to agreed and start building (no budget, so nothing escalates).
function building(s, extra = {}) {
  const c = open(s, extra);
  s.propose(c.id, { estimate: { hours: 4 }, plan: 'oauth' }, dev);
  s.agree(c.id, { version: 2 }, dev);
  s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  return c;
}

test('change from building returns to negotiating with new version and criteria', () => {
  const s = new Contracts();
  const c = building(s);
  s.requestChange(c.id, { criteria: ['login works', 'mfa works'], reason: 'quero mfa' }, client);
  assert.equal(c.state, 'negotiating');
  assert.equal(c.proposal.version, 3);
  assert.equal(c.proposal.by, 'client');
  assert.deepEqual(c.proposal.criteria.map((k) => k.text), ['login works', 'mfa works']);
  assert.deepEqual(c.agreedBy, []);
  assert.equal(c.rounds, 0);
});

test('change keeps previous estimate, calibrated as reference and plan', () => {
  const s = new Contracts();
  const c = building(s);
  const { estimate, calibrated, plan } = c.proposal;
  s.requestChange(c.id, { criteria: ['mfa works'] }, client);
  assert.deepEqual(c.proposal.estimate, estimate);
  assert.deepEqual(c.proposal.calibrated, calibrated);
  assert.equal(c.proposal.plan, plan);
});

test('change keeps consumption already done and records changes[] and event', () => {
  const s = new Contracts();
  const c = building(s);
  s.reportUsage(c.id, { hours: 2, costUsd: 1.5, model: 'm' }, dev);
  s.requestChange(c.id, { criteria: ['mfa works'], reason: 'escopo maior' }, client);
  assert.equal(c.usage.hours, 2);
  assert.equal(c.usage.costUsd, 1.5);
  assert.equal(c.changes.length, 1);
  assert.deepEqual({ ...c.changes[0], at: undefined }, { at: undefined, reason: 'escopo maior', fromState: 'building', version: 3 });
  const ev = s.history(c.id).find((e) => e.type === 'change');
  assert.equal(ev.data.fromState, 'building');
  assert.equal(ev.data.version, 3);
});

test('change by dev is refused with 403', () => {
  const s = new Contracts();
  const c = building(s);
  assert.throws(() => s.requestChange(c.id, { criteria: ['x'] }, dev), (e) => e.status === 403);
});

test('change from negotiating is refused with 409', () => {
  const s = new Contracts();
  const c = open(s);
  assert.throws(() => s.requestChange(c.id, { criteria: ['x'] }, client), (e) => e.status === 409);
});

test('change without criteria is refused with 400', () => {
  const s = new Contracts();
  const c = building(s);
  assert.throws(() => s.requestChange(c.id, { criteria: [] }, client), (e) => e.status === 400);
  assert.throws(() => s.requestChange(c.id, {}, client), (e) => e.status === 400);
  assert.equal(c.state, 'building');
});

test('after a change, dev proposes and both agree again to agreed', () => {
  const s = new Contracts();
  const c = building(s);
  s.requestChange(c.id, { criteria: ['mfa works'] }, client);
  s.propose(c.id, { estimate: { hours: 6 } }, dev);
  s.agree(c.id, { version: c.proposal.version }, dev);
  s.agree(c.id, { version: c.proposal.version }, client);
  assert.equal(c.state, 'agreed');
});

test('canApprove: empty list lets everyone approve, otherwise case-insensitive membership', () => {
  const s = new Contracts();
  assert.equal(s.canApprove('anyone@x.com'), true);
  s.updateConfig({ portal: { approvers: ['Ana@Empresa.com'] } }, human);
  assert.equal(s.canApprove('ana@empresa.com'), true);
  assert.equal(s.canApprove('ANA@EMPRESA.COM'), true);
  assert.equal(s.canApprove('bob@empresa.com'), false);
});

test('updateConfig portal and llm: human only, merged, validated, logged', () => {
  const s = new Contracts();
  assert.throws(() => s.updateConfig({ portal: { approvers: ['a@x'] } }, client), (e) => e.status === 403);
  assert.throws(() => s.updateConfig({ llm: { enabled: true } }, dev), (e) => e.status === 403);

  s.updateConfig({ portal: { approvers: ['A@x.com'] } }, human);
  assert.deepEqual(s.config.portal.approvers, ['a@x.com']);
  assert.deepEqual(s.config.llm, { enabled: false, model: 'claude-haiku-5-5' });

  s.updateConfig({ llm: { enabled: true } }, human);
  assert.equal(s.config.llm.enabled, true);
  assert.equal(s.config.llm.model, 'claude-haiku-5-5');
  assert.deepEqual(s.config.portal.approvers, ['a@x.com']);

  const ev = s.state.events.filter((e) => e.type === 'config').at(-1);
  assert.deepEqual(ev.data.llm, { enabled: true });

  assert.throws(() => s.updateConfig({ portal: { approvers: 'a@x.com' } }, human), (e) => e.status === 400);
  assert.throws(() => s.updateConfig({ portal: { approvers: [1] } }, human), (e) => e.status === 400);
  assert.throws(() => s.updateConfig({ llm: { enabled: 'yes' } }, human), (e) => e.status === 400);
});

test('old state without goals or portal config loads with defaults', () => {
  const s = new Contracts({ state: { contracts: [], events: [], config: {} } });
  assert.deepEqual(s.listGoals(), []);
  assert.deepEqual(s.config.portal, { approvers: [] });
  assert.equal(s.canApprove('x@y.z'), true);
});

test('createGoal: client and human can create, dev is refused, title required', () => {
  const s = new Contracts();
  const g = s.createGoal({ title: 'Reduzir fila de suporte', description: 'd', targetDate: '2027-01-31' }, client);
  assert.match(g.id, /^[0-9a-f]{8}$/);
  assert.equal(g.createdBy, 'client-agent');
  assert.equal(g.targetDate, '2027-01-31');
  const h = s.createGoal({ title: 'Outro' }, human);
  assert.equal(h.description, '');
  assert.equal(h.targetDate, null);
  assert.throws(() => s.createGoal({ title: 'x' }, dev), (e) => e.status === 403);
  assert.throws(() => s.createGoal({ description: 'sem titulo' }, client), (e) => e.status === 400);
  assert.equal(s.listGoals().length, 2);
  assert.equal(s.getGoal(g.id), g);
  assert.throws(() => s.getGoal('nope0000'), (e) => e.status === 404);
  const ev = s.state.events.filter((e) => e.type === 'goal');
  assert.equal(ev.length, 2);
  assert.equal(ev[0].contractId, null);
});

test('createIntent stores goalId; unknown goalId is 400', () => {
  const s = new Contracts();
  const g = s.createGoal({ title: 'Meta' }, client);
  const c = open(s, { goalId: g.id });
  assert.equal(c.goalId, g.id);
  assert.equal(open(s).goalId, null);
  assert.throws(() => open(s, { goalId: 'deadbeef' }), (e) => e.status === 400 && /objetivo não encontrado/.test(e.message));
});

test('linkGoal: client links, dev refused, unknown goal refused', () => {
  const s = new Contracts();
  const g = s.createGoal({ title: 'Meta' }, client);
  const c = open(s);
  assert.throws(() => s.linkGoal(c.id, g.id, dev), (e) => e.status === 403);
  assert.throws(() => s.linkGoal(c.id, 'deadbeef', client), (e) => e.status === 400);
  s.linkGoal(c.id, g.id, client);
  assert.equal(c.goalId, g.id);
  assert.ok(s.history(c.id).some((e) => e.type === 'goal-link'));
});

test('goalProgress counts and percent with one accepted and one in progress', () => {
  const s = new Contracts();
  const g = s.createGoal({ title: 'Meta' }, client);
  const done = building(s, { goalId: g.id });
  s.reportUsage(done.id, { hours: 3, costUsd: 1.25, model: 'm' }, dev);
  s.deliver(done.id, { results: { c1: true, c2: true, ...DOD }, links: ['pr/1'] }, dev);
  s.accept(done.id, client);
  const wip = building(s, { goalId: g.id });
  s.reportUsage(wip.id, { hours: 1, costUsd: 0.5, model: 'm' }, dev);
  open(s); // not linked to the goal

  const p = s.goalProgress(g.id);
  assert.equal(p.goal.id, g.id);
  assert.equal(p.total, 2);
  assert.equal(p.accepted, 1);
  assert.equal(p.inProgress, 1);
  assert.equal(p.waiting, 0);
  assert.equal(p.spentUsd, 1.75);
  assert.equal(p.percent, 50);
});

test('goalProgress: empty goal has percent 0, waiting counts delivered', () => {
  const s = new Contracts();
  const g = s.createGoal({ title: 'Meta' }, client);
  assert.deepEqual(
    { total: s.goalProgress(g.id).total, percent: s.goalProgress(g.id).percent, spentUsd: s.goalProgress(g.id).spentUsd },
    { total: 0, percent: 0, spentUsd: 0 },
  );
  const c = building(s, { goalId: g.id });
  s.deliver(c.id, { results: { c1: true, c2: true, ...DOD } }, dev);
  const p = s.goalProgress(g.id);
  assert.equal(p.waiting, 1);
  assert.equal(p.percent, 0);
});
