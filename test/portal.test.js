import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';
import { TEMPLATES } from '../src/templates.js';

const human = { role: 'human', agent: 'ana@acme.com' };
const dev = { role: 'dev', agent: 'dev-a' };
const DOD = { 'dod-tests': true, 'dod-security': true };

function setup() {
  const store = new Contracts();
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const app = createApp({
    store,
    hooks: new Webhooks(store, { fetchImpl }),
    slack: new Slack(store, { token: undefined }),
    env: {},
    fetchImpl,
  });
  return { store, app };
}

const req = (path, { method = 'GET', body } = {}) => new Request(`http://x${path}`, {
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const call = (app, path, opts, actor = human) => app.handle(req(path, opts), actor);

test('me returns the e-mail of the person and the tenant', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/me');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: 'ana@acme.com', tenant: null });
});

test('templates lists all the ready-made models', async () => {
  const { app } = setup();
  const list = await (await call(app, '/api/portal/templates')).json();
  assert.equal(list.length, TEMPLATES.length);
  assert.ok(list.length >= 10);
});

test('creating from a template keeps area, sensitivity and the template criteria', async () => {
  const { app } = setup();
  const tpl = TEMPLATES.find((t) => t.id === 'saude-lembrete-consultas');
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'Lembretes', templateId: tpl.id } });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.area, 'saude');
  assert.equal(view.title, 'Lembretes');
  assert.deepEqual(view.criteria.map((c) => c.text), tpl.criteria);
  assert.equal(view.status.code, 'negotiating');
});

test('creating from "- " lines in the description turns them into criteria', async () => {
  const { app, store } = setup();
  const description = 'Quero um painel.\n- O painel mostra o turnover por área\n- Os números são mensais\nSem linha de critério aqui';
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'Painel', description } });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.deepEqual(view.criteria.map((c) => c.text), ['O painel mostra o turnover por área', 'Os números são mensais']);
  assert.equal(store.get(view.id).goal, description);
});

test('creating without any criteria is a 400 in Portuguese', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'Sem critério', description: 'Algo vago' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Descreva pelo menos um critério de pronto/);
});

test('an unknown template is a 400 in Portuguese', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'x', templateId: 'nao-existe', criteria: ['ok'] } });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error.length > 0);
});

test('budgetBrl without a configured exchange rate is a 400 that explains it', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'x', criteria: ['ok'], budgetBrl: 2500 } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /câmbio ainda não foi configurado/);
});

test('budgetBrl with a rate of 5 becomes budget.costUsd', async () => {
  const { app, store } = setup();
  await call(app, '/api/config', { method: 'POST', body: { fx: { usdToBrl: 5 } } });
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'x', criteria: ['ok'], budgetBrl: 2500 } });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(store.get(view.id).budget.costUsd, 500);
  assert.equal(view.spent.brl, 0);
});

test('a dev cannot use the portal (403)', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/requests', { method: 'GET' }, dev);
  assert.equal(res.status, 403);
  assert.ok((await res.json()).error);
});

test('list puts escalated requests first, then ready-to-accept, then the rest', async () => {
  const { app, store } = setup();
  const make = (title) => store.createIntent({ title, criteria: ['ok'] }, { role: 'client', agent: 'ana@acme.com' });
  const old = make('antigo');
  const ready = make('pronto');
  const escalated = make('escalonado');
  store.propose(ready.id, { estimate: { hours: 1 } }, dev);
  store.agree(ready.id, { version: 2 }, dev);
  store.agree(ready.id, { version: 2 }, { role: 'client', agent: 'ana@acme.com' });
  store.start(ready.id, dev);
  store.deliver(ready.id, { results: { c1: true, ...DOD } }, dev);
  store.escalate(escalated.id, { reason: 'x' }, { role: 'client', agent: 'ana@acme.com' });
  const list = await (await call(app, '/api/portal/requests')).json();
  assert.deepEqual(list.map((c) => c.title), ['escalonado', 'pronto', 'antigo']);
  assert.ok(list[0].needsDecision);
  assert.ok(list[1].canAccept);
  assert.ok(old);
});

test('decision approve on an escalated request resumes it', async () => {
  const { app, store } = setup();
  const c = store.createIntent({ title: 'x', criteria: ['ok'] }, { role: 'client', agent: 'ana@acme.com' });
  store.escalate(c.id, { reason: 'no agreement after 5 rounds' }, { role: 'client', agent: 'ana@acme.com' });
  const res = await call(app, `/api/portal/requests/${c.id}/decision`, { method: 'POST', body: { decision: 'approve' } });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.needsDecision, null);
  assert.equal(view.status.code, 'agreed');
  assert.equal(store.get(c.id).state, 'agreed');
});

function delivered(store, criteria = ['ok', 'tests']) {
  const c = store.createIntent({ title: 'Entrega', criteria }, { role: 'client', agent: 'ana@acme.com' });
  const client = { role: 'client', agent: 'ana@acme.com' };
  store.propose(c.id, { estimate: { hours: 2 } }, dev);
  store.agree(c.id, { version: 2 }, dev);
  store.agree(c.id, { version: 2 }, client);
  store.start(c.id, dev);
  return c;
}

test('accept works after delivery with every criterion and DoD result passing', async () => {
  const { app, store } = setup();
  const c = delivered(store);
  const results = { 'c1': true, 'c2': true, ...DOD };
  store.deliver(c.id, { results }, dev);
  const res = await call(app, `/api/portal/requests/${c.id}/accept`, { method: 'POST' });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.status.code, 'accepted');
  assert.equal(view.status.label, 'Entregue');
  assert.equal(view.canAccept, false);
});

test('reject sends the request back to production', async () => {
  const { app, store } = setup();
  const c = delivered(store);
  store.deliver(c.id, { results: { c1: true, c2: true, ...DOD } }, dev);
  const res = await call(app, `/api/portal/requests/${c.id}/reject`, { method: 'POST', body: { reason: 'Falta o filtro por mês' } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status.code, 'building');
  assert.equal(store.get(c.id).state, 'building');
});

test('accept with missing criteria returns the plain Portuguese message', async () => {
  const { app, store } = setup();
  const c = delivered(store);
  store.deliver(c.id, { results: { c1: true, ...DOD } }, dev);
  const res = await call(app, `/api/portal/requests/${c.id}/accept`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'Ainda há itens que não foram concluídos ou verificados.' });
});

test('accept from the wrong state gives the plain Portuguese message', async () => {
  const { app, store } = setup();
  const c = store.createIntent({ title: 'x', criteria: ['ok'] }, { role: 'client', agent: 'ana@acme.com' });
  const res = await call(app, `/api/portal/requests/${c.id}/accept`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'Este pedido não está numa etapa em que isso seja possível agora.');
});

test('request detail includes the plain timeline', async () => {
  const { app, store } = setup();
  const c = store.createIntent({ title: 'x', criteria: ['ok'] }, { role: 'client', agent: 'ana@acme.com' });
  const res = await call(app, `/api/portal/requests/${c.id}`);
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.title, 'x');
  assert.deepEqual(view.timeline.map((t) => t.text), ['Pedido criado']);
});

test('import of a Jira CSV returns the counts', async () => {
  const { app } = setup();
  const csv = [
    'Summary,Status,Resolved,Created,Story Points',
    'Tela de login,Done,2026-01-10,2026-01-02,3',
    'Relatório,In Progress,,2026-02-01,5',
    ',Done,2026-01-10,2026-01-02,1',
  ].join('\n');
  const res = await call(app, '/api/portal/import', { method: 'POST', body: { format: 'jira', csv } });
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.imported, 2);
  assert.equal(result.done, 1);
  assert.equal(result.open, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].row, 3);
});

test('overview counts requests waiting for the person', async () => {
  const { app, store } = setup();
  const c = store.createIntent({ title: 'x', criteria: ['ok'] }, { role: 'client', agent: 'ana@acme.com' });
  store.escalate(c.id, { reason: 'x' }, { role: 'client', agent: 'ana@acme.com' });
  const o = await (await call(app, '/api/portal/overview')).json();
  assert.equal(o.waitingYou, 1);
  assert.equal(o.inProgress, 0);
});

test('client confirms the team proposal through the portal, then work can start', async () => {
  const { Contracts } = await import('../src/contract.js');
  const { createApp } = await import('../src/app.js');
  const store = new Contracts();
  const app = createApp({ store, hooks: null, slack: null });
  const who = { role: 'human', agent: 'ana@acme.com' };
  const call = (path, body) => app.handle(new Request('http://x' + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), who).then((r) => r.json());
  const p = await call('/api/portal/requests', { title: 'Painel', description: 'x', criteria: ['mostra vendas'] });
  assert.equal(p.proposal, null);
  const dev = { role: 'dev', agent: 'd' };
  store.propose(p.id, { estimate: { hours: 10 }, plan: 'planilha + painel' }, dev);
  store.agree(p.id, { version: 2 }, dev);
  const seen = await call(`/api/portal/requests/${p.id}`);
  assert.match(seen.proposal.text, /até \d+ dias? \(85% de chance\)/);
  assert.match(seen.proposal.text, /planilha \+ painel/);
  const ok = await call(`/api/portal/requests/${p.id}/confirm`, {});
  assert.equal(ok.status.code, 'agreed');
  assert.equal(ok.proposal, null);
});
