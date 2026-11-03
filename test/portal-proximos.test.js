// Portal API for the "próximos" features: approvers, suggested criteria, scope change and goals.
// Spec: docs/spec-proximos.md sections 1, 2, 4 and 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';
import { TEMPLATES } from '../src/templates.js';

const ana = { role: 'human', agent: 'ana@acme.com' };
const bia = { role: 'human', agent: 'bia@acme.com' };
const admin = { role: 'human', agent: 'admin' };
const client = { role: 'client', agent: 'client-agent' };
const dev = { role: 'dev', agent: 'dev-agent' };
const APPROVE_ONLY_ANA = 'Só aprovadores podem fazer isso. Peça para ana@acme.com aprovar.';

const okFetch = async () => ({ ok: true, status: 200 });

// Every criterion and Definition of Done check passed, as a delivery report would say.
const ALL_PASS = (c) => Object.fromEntries([...c.proposal.criteria, ...c.dod].map((k) => [k.id, true]));

function setup({ env = {}, fetchImpl = okFetch } = {}) {
  const store = new Contracts();
  const app = createApp({
    store,
    hooks: new Webhooks(store, { fetchImpl }),
    slack: new Slack(store, { token: undefined }),
    env,
    fetchImpl,
  });
  return { store, app };
}

const req = (path, { method = 'GET', body } = {}) => new Request(`http://x${path}`, {
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const call = (app, path, opts, actor = ana) => app.handle(req(path, opts), actor);

const open = (store, extra = {}) => store.createIntent({ title: 'Login', criteria: ['login works', 'tests green'], ...extra }, client);

// Dev proposes an estimate: the request is waiting for the client to confirm.
function proposed(store, extra) {
  const c = open(store, extra);
  store.propose(c.id, { estimate: { hours: 4 }, plan: 'oauth' }, dev);
  return c;
}

// Agreed by both sides and being built.
function building(store, extra) {
  const c = proposed(store, extra);
  store.agree(c.id, { version: 2 }, dev);
  store.agree(c.id, { version: 2 }, client);
  store.start(c.id, dev);
  return c;
}

function withApprovers(store, approvers) {
  store.updateConfig({ portal: { approvers } }, admin);
}

test('only approvers can confirm, and others get a 403 naming the approver', async () => {
  const { store, app } = setup();
  withApprovers(store, ['ana@acme.com']);
  const c = proposed(store);
  const res = await call(app, `/api/portal/requests/${c.id}/confirm`, { method: 'POST', body: {} }, bia);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, APPROVE_ONLY_ANA);
  assert.equal(store.get(c.id).state, 'negotiating');
  const ok = await call(app, `/api/portal/requests/${c.id}/confirm`, { method: 'POST', body: {} }, ana);
  assert.equal(ok.status, 200);
});

test('non-approvers cannot decide, accept, reject or change scope', async () => {
  const { store, app } = setup();
  withApprovers(store, ['ana@acme.com']);

  const escalated = open(store);
  store.escalate(escalated.id, { reason: 'exceeds budget' }, client);
  const decision = await call(app, `/api/portal/requests/${escalated.id}/decision`, { method: 'POST', body: { decision: 'approve' } }, bia);
  assert.equal(decision.status, 403);
  assert.equal((await decision.json()).error, APPROVE_ONLY_ANA);

  const delivered = building(store);
  store.deliver(delivered.id, { results: {} }, dev);
  for (const action of ['accept', 'reject']) {
    const res = await call(app, `/api/portal/requests/${delivered.id}/${action}`, { method: 'POST', body: { reason: 'x' } }, bia);
    assert.equal(res.status, 403, action);
    assert.equal((await res.json()).error, APPROVE_ONLY_ANA, action);
  }
  assert.equal(store.get(delivered.id).state, 'delivered');

  const working = building(store);
  const change = await call(app, `/api/portal/requests/${working.id}/change`, { method: 'POST', body: { criteria: ['x'], reason: 'y' } }, bia);
  assert.equal(change.status, 403);
  assert.equal((await change.json()).error, APPROVE_ONLY_ANA);
  assert.equal(store.get(working.id).state, 'building');
});

test('canDecide tells each person whether they may approve', async () => {
  const { store, app } = setup();
  withApprovers(store, ['ana@acme.com']);
  const c = proposed(store);
  const asBia = await (await call(app, `/api/portal/requests/${c.id}`, {}, bia)).json();
  const asAna = await (await call(app, `/api/portal/requests/${c.id}`, {}, ana)).json();
  assert.equal(asBia.canDecide, false);
  assert.equal(asAna.canDecide, true);
  const list = await (await call(app, '/api/portal/requests', {}, bia)).json();
  assert.equal(list[0].canDecide, false);
});

test('an empty approver list lets everyone approve', async () => {
  const { store, app } = setup();
  withApprovers(store, []);
  const c = proposed(store);
  const view = await (await call(app, `/api/portal/requests/${c.id}`, {}, bia)).json();
  assert.equal(view.canDecide, true);
  const ok = await call(app, `/api/portal/requests/${c.id}/confirm`, { method: 'POST', body: {} }, bia);
  assert.equal(ok.status, 200);
});

test('suggest-criteria is a 503 while the LLM is disabled', async () => {
  const { app } = setup({ env: { ANTHROPIC_API_KEY: 'k' } });
  const res = await call(app, '/api/portal/suggest-criteria', { method: 'POST', body: { title: 'Painel', description: 'Quero um painel' } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'Sugestão automática não está ativada.');
});

test('suggest-criteria is a 503 when enabled but no API key is configured', async () => {
  const { store, app } = setup();
  store.updateConfig({ llm: { enabled: true } }, admin);
  const res = await call(app, '/api/portal/suggest-criteria', { method: 'POST', body: { title: 'Painel' } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'Sugestão automática não está ativada.');
});

test('suggest-criteria returns the model criteria and sends the API key', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"criteria":["a","b","c"]}' }] }) };
  };
  const { store, app } = setup({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl });
  store.updateConfig({ llm: { enabled: true } }, admin);
  const res = await call(app, '/api/portal/suggest-criteria', { method: 'POST', body: { title: 'Painel', description: 'Quero um painel' } }, bia);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { criteria: ['a', 'b', 'c'] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen[0].init.headers['x-api-key'], 'k');
  assert.equal(JSON.parse(seen[0].init.body).model, 'claude-haiku-5-5');
});

test('suggest-criteria passes the template area to the model', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"criteria":["a"]}' }] }) };
  };
  const { store, app } = setup({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl });
  store.updateConfig({ llm: { enabled: true } }, admin);
  const tpl = TEMPLATES.find((t) => t.id === 'saude-lembrete-consultas');
  const res = await call(app, '/api/portal/suggest-criteria', { method: 'POST', body: { title: 'Lembretes', templateId: tpl.id } });
  assert.equal(res.status, 200);
  const content = JSON.parse(seen[0].body).messages[0].content;
  assert.doesNotMatch(content, /não informada/);
});

test('suggest-criteria with an unknown template is a 400 in Portuguese', async () => {
  const { store, app } = setup({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: okFetch });
  store.updateConfig({ llm: { enabled: true } }, admin);
  const res = await call(app, '/api/portal/suggest-criteria', { method: 'POST', body: { title: 'x', templateId: 'nao-existe' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Escolha outro ou comece do zero/);
});

test('suggest-criteria with an unusable model answer is a 502 in Portuguese', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'não sei' }] }) });
  const { store, app } = setup({ env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl });
  store.updateConfig({ llm: { enabled: true } }, admin);
  const res = await call(app, '/api/portal/suggest-criteria', { method: 'POST', body: { title: 'Painel' } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Não foi possível sugerir critérios/);
});

test('changing scope from building goes back to negotiating with the new criteria and a timeline sentence', async () => {
  const { store, app } = setup();
  withApprovers(store, ['ana@acme.com']);
  const c = building(store);
  const before = await (await call(app, `/api/portal/requests/${c.id}`, {}, ana)).json();
  assert.equal(before.canChange, true);
  const res = await call(app, `/api/portal/requests/${c.id}/change`, {
    method: 'POST',
    body: { criteria: ['login works', 'mfa works'], reason: 'quero mfa' },
  });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.status.code, 'negotiating');
  assert.deepEqual(view.criteria.map((k) => k.text), ['login works', 'mfa works']);
  const detail = await (await call(app, `/api/portal/requests/${c.id}`, {}, ana)).json();
  assert.ok(detail.timeline.some((e) => e.text === 'Você pediu uma mudança no pedido'));
});

test('canChange is true only in agreed, building and delivered', async () => {
  const { store, app } = setup();
  const neg = proposed(store);
  const get = async (c) => (await (await call(app, `/api/portal/requests/${c.id}`, {}, ana)).json()).canChange;
  assert.equal(await get(neg), false);
  const working = building(store);
  assert.equal(await get(working), true);
  store.deliver(working.id, { results: {} }, dev);
  assert.equal(await get(working), true);
  const escalated = open(store);
  store.escalate(escalated.id, { reason: 'exceeds budget' }, client);
  assert.equal(await get(escalated), false);
});

test('a scope change needs at least one criterion', async () => {
  const { store, app } = setup();
  const c = building(store);
  const res = await call(app, `/api/portal/requests/${c.id}/change`, { method: 'POST', body: { criteria: ['  '], reason: 'x' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /critério/);
  assert.equal(store.get(c.id).state, 'building');
});

test('goals: create returns progress, and the list shows percent of accepted requests', async () => {
  const { store, app } = setup();
  const created = await call(app, '/api/portal/goals', {
    method: 'POST',
    body: { title: 'Reduzir turnover', description: 'Menos saídas', targetDate: '2027-01-31' },
  }, bia);
  assert.equal(created.status, 200);
  const goal = await created.json();
  assert.equal(goal.goal.title, 'Reduzir turnover');
  assert.equal(goal.total, 0);
  assert.equal(goal.percent, 0);

  const first = building(store, { goalId: goal.goal.id });
  open(store, { goalId: goal.goal.id });
  store.deliver(first.id, { results: ALL_PASS(first) }, dev);
  store.accept(first.id, client);
  const list = await (await call(app, '/api/portal/goals', {}, bia)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].total, 2);
  assert.equal(list[0].accepted, 1);
  assert.equal(list[0].percent, 50);
});

test('goals: a request created with goalId is listed under that goal only', async () => {
  const { store, app } = setup();
  const goal = store.createGoal({ title: 'Objetivo A' }, client);
  const other = store.createGoal({ title: 'Objetivo B' }, client);
  const linked = await call(app, '/api/portal/requests', {
    method: 'POST',
    body: { title: 'Painel', criteria: ['mostra o turnover'], goalId: goal.id },
  }, bia);
  assert.equal(linked.status, 200);
  const view = await linked.json();
  assert.equal(view.goalId, goal.id);
  await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'Outro', criteria: ['ok'] } }, bia);

  const filtered = await (await call(app, `/api/portal/requests?goalId=${goal.id}`, {}, bia)).json();
  assert.deepEqual(filtered.map((c) => c.id), [view.id]);
  const none = await (await call(app, `/api/portal/requests?goalId=${other.id}`, {}, bia)).json();
  assert.deepEqual(none, []);
  const all = await (await call(app, '/api/portal/requests', {}, bia)).json();
  assert.equal(all.length, 2);
});

test('an unknown goalId is a 400 "objetivo não encontrado"', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/requests', {
    method: 'POST',
    body: { title: 'Painel', criteria: ['ok'], goalId: 'nao-existe' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'objetivo não encontrado');
});

test('a request linked to a goal says so in its timeline', async () => {
  const { store, app } = setup();
  const c = open(store);
  const goal = store.createGoal({ title: 'Objetivo' }, client);
  store.linkGoal(c.id, goal.id, client);
  const view = await (await call(app, `/api/portal/requests/${c.id}`, {}, bia)).json();
  assert.equal(view.goalId, goal.id);
  assert.ok(view.timeline.some((e) => e.text === 'Pedido ligado a um objetivo'));
});

test('goal routes need a human actor', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/goals', {}, { role: 'dev', agent: 'dev-a' });
  assert.equal(res.status, 403);
});
