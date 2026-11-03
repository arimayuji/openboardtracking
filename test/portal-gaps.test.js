// Portal API for the spec-gaps "Portal" bullets: value per request, split, dependencies, report JSON and CSV.
// Spec: docs/spec-gaps-finais.md section 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';

const ana = { role: 'human', agent: 'ana@acme.com' };
const bia = { role: 'human', agent: 'bia@acme.com' };
const admin = { role: 'human', agent: 'admin' };
const client = { role: 'client', agent: 'client-agent' };
const dev = { role: 'dev', agent: 'dev-agent' };
const DOD = { 'dod-tests': true, 'dod-security': true };
const APPROVE_ONLY_ANA = 'Só aprovadores podem fazer isso. Peça para ana@acme.com aprovar.';

const okFetch = async () => ({ ok: true, status: 200 });

function setup() {
  const store = new Contracts();
  const app = createApp({
    store,
    hooks: new Webhooks(store, { fetchImpl: okFetch }),
    slack: new Slack(store, { token: undefined }),
    env: {},
    fetchImpl: okFetch,
  });
  return { store, app };
}

const req = (path, { method = 'GET', body } = {}) => new Request(`http://x${path}`, {
  method,
  headers: body === undefined ? {} : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const call = (app, path, opts, actor = ana) => app.handle(req(path, opts), actor);

const open = (store, extra = {}) => store.createIntent({ title: 'Login', criteria: ['login works'], ...extra }, client);

// Negotiates, builds and delivers a contract with every check passing. Leaves it in 'delivered'.
function delivered(store, extra = {}) {
  const c = open(store, extra);
  store.propose(c.id, { estimate: { hours: 4 }, plan: 'oauth' }, dev);
  store.agree(c.id, { version: 2 }, dev);
  store.agree(c.id, { version: 2 }, client);
  store.start(c.id, dev);
  const results = Object.fromEntries(c.proposal.criteria.map((k) => [k.id, true]));
  store.deliver(c.id, { results: { ...results, ...DOD }, usage: { hours: 1, costUsd: extra.costUsd ?? 2 } }, dev);
  return c;
}

const WIDE = '/api/portal/report?from=2000-01-01&to=2100-01-01';

test('create accepts valueScore and valueBrl and shows them in the view', async () => {
  const { app, store } = setup();
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'Relatório', criteria: ['mostra totais'], valueScore: 4, valueBrl: 1500 } });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.valueScore, 4);
  assert.equal(view.valueBrl, 1500);
  assert.equal(store.get(view.id).valueScore, 4);
});

test('create without value fields shows null', async () => {
  const { app } = setup();
  const view = await (await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'Sem valor', criteria: ['ok'] } })).json();
  assert.equal(view.valueScore, null);
  assert.equal(view.valueBrl, null);
});

test('invalid valueScore is refused with 400', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'X', criteria: ['ok'], valueScore: 9 } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'valueScore deve ser de 1 a 5');
});

test('negative valueBrl is refused with 400', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/requests', { method: 'POST', body: { title: 'X', criteria: ['ok'], valueBrl: -1 } });
  assert.equal(res.status, 400);
});

test('split returns the parent with childIds and two child views', async () => {
  const { app, store } = setup();
  const big = open(store, { title: 'Grande' });
  const res = await call(app, `/api/portal/requests/${big.id}/split`, {
    method: 'POST',
    body: { parts: [{ title: 'Parte A', criteria: ['a funciona'] }, { title: 'Parte B', criteria: ['b funciona'] }] },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.parent.id, big.id);
  assert.equal(body.parent.childIds.length, 2);
  assert.equal(body.children.length, 2);
  assert.deepEqual(body.children.map((v) => v.id), body.parent.childIds);
  assert.ok(body.children.every((v) => v.parentId === big.id));
  assert.deepEqual(body.children.map((v) => v.title), ['Parte A', 'Parte B']);
});

test('split with fewer than two parts is refused', async () => {
  const { app, store } = setup();
  const big = open(store);
  const res = await call(app, `/api/portal/requests/${big.id}/split`, { method: 'POST', body: { parts: [{ title: 'Só uma', criteria: ['x'] }] } });
  assert.equal(res.status, 400);
  assert.equal(store.get(big.id).childIds, undefined);
});

test('split by someone who is not an approver is 403', async () => {
  const { app, store } = setup();
  store.updateConfig({ portal: { approvers: ['ana@acme.com'] } }, admin);
  const big = open(store);
  const parts = [{ title: 'A', criteria: ['a'] }, { title: 'B', criteria: ['b'] }];
  const res = await call(app, `/api/portal/requests/${big.id}/split`, { method: 'POST', body: { parts } }, bia);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, APPROVE_ONLY_ANA);
  assert.equal(store.get(big.id).childIds, undefined);
});

test('depends adds a dependency and blockedBy shows the other title', async () => {
  const { app, store } = setup();
  const base = open(store, { title: 'Base' });
  const top = open(store, { title: 'Topo' });
  const res = await call(app, `/api/portal/requests/${top.id}/depends`, { method: 'POST', body: { dependsOn: base.id } });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.deepEqual(view.dependsOn, [base.id]);
  assert.deepEqual(view.blockedBy, ['Base']);
});

test('a circular dependency is refused with the Portuguese message', async () => {
  const { app, store } = setup();
  const a = open(store, { title: 'A' });
  const b = open(store, { title: 'B' });
  await call(app, `/api/portal/requests/${b.id}/depends`, { method: 'POST', body: { dependsOn: a.id } });
  const res = await call(app, `/api/portal/requests/${a.id}/depends`, { method: 'POST', body: { dependsOn: b.id } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Isso criaria uma dependência circular.');
  assert.deepEqual(store.get(a.id).dependsOn ?? [], []);
});

test('depending on itself is refused', async () => {
  const { app, store } = setup();
  const a = open(store);
  const res = await call(app, `/api/portal/requests/${a.id}/depends`, { method: 'POST', body: { dependsOn: a.id } });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Um pedido não pode depender de si mesmo.');
});

test('DELETE depends removes the dependency', async () => {
  const { app, store } = setup();
  const base = open(store, { title: 'Base' });
  const top = open(store, { title: 'Topo' });
  await call(app, `/api/portal/requests/${top.id}/depends`, { method: 'POST', body: { dependsOn: base.id } });
  const res = await call(app, `/api/portal/requests/${top.id}/depends/${base.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.deepEqual(view.dependsOn, []);
  assert.deepEqual(view.blockedBy, []);
});

test('depends by a non-approver is 403', async () => {
  const { app, store } = setup();
  store.updateConfig({ portal: { approvers: ['ana@acme.com'] } }, admin);
  const base = open(store, { title: 'Base' });
  const top = open(store, { title: 'Topo' });
  const res = await call(app, `/api/portal/requests/${top.id}/depends`, { method: 'POST', body: { dependsOn: base.id } }, bia);
  assert.equal(res.status, 403);
  const del = await call(app, `/api/portal/requests/${top.id}/depends/${base.id}`, { method: 'DELETE' }, bia);
  assert.equal(del.status, 403);
});

test('report JSON gives totals and delivered items for the period', async () => {
  const { app, store } = setup();
  const c = delivered(store, { title: 'Entregue', costUsd: 2 });
  store.accept(c.id, client);
  const res = await call(app, WIDE);
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.totals.delivered, 1);
  assert.equal(r.totals.costUsd, 2);
  assert.deepEqual(r.delivered.map((d) => d.title), ['Entregue']);
  assert.equal(r.delivered[0].costUsd, 2);
  assert.equal(r.totals.brl, undefined);
  assert.equal(r.delivered[0].brl, undefined);
});

test('report with a configured rate adds costBrl to totals and each delivered item', async () => {
  const { app, store } = setup();
  store.updateConfig({ fx: { usdToBrl: 5 } }, admin);
  const c = delivered(store, { title: 'Com câmbio', costUsd: 2 });
  store.accept(c.id, client);
  const r = await (await call(app, WIDE)).json();
  assert.deepEqual(r.totals.brl, { costBrl: 10 });
  assert.deepEqual(r.delivered[0].brl, { costBrl: 10 });
});

test('report.csv returns CSV with BOM, header and the delivered row', async () => {
  const { app, store } = setup();
  const c = delivered(store, { title: 'Planilha', costUsd: 2 });
  store.accept(c.id, client);
  const res = await call(app, '/api/portal/report.csv?from=2000-01-01&to=2100-01-01');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="relatorio-2000-01-01-2100-01-01.csv"');
  // Response.text() drops the BOM, so decode the bytes with ignoreBOM to keep it visible.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
  assert.ok(text.startsWith('﻿pedido;área;objetivo;entregue em;dias;custo (US$);valor (R$)\r\n'));
  assert.ok(text.includes('Planilha;'));
});

test('report with an invalid period is refused with 400', async () => {
  const { app } = setup();
  const res = await call(app, '/api/portal/report?from=nope&to=2100-01-01');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'from inválido');
});

test('report routes are closed to clients who are not humans', async () => {
  const { app } = setup();
  const res = await call(app, WIDE, undefined, { role: 'client', agent: 'x' });
  assert.equal(res.status, 403);
});
