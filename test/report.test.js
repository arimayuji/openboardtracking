import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { report, reportCsv } from '../src/report.js';

const DOD = { 'dod-tests': true, 'dod-security': true };
const client = { role: 'client', agent: 'client-agent' };
const dev = { role: 'dev', agent: 'dev-agent' };

// Negotiates, builds and delivers a contract. Leaves it in 'delivered'.
function delivered(s, { title = 'Login', ...extra } = {}) {
  const c = s.createIntent({ title, criteria: ['login works'], ...extra }, client);
  s.propose(c.id, { estimate: { hours: 4 }, plan: 'oauth' }, dev);
  s.agree(c.id, { version: 2 }, dev);
  s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  const results = Object.fromEntries(c.proposal.criteria.map((k) => [k.id, true]));
  s.deliver(c.id, { results: { ...results, ...DOD }, usage: { hours: 1, costUsd: extra.costUsd ?? 0 } }, dev);
  return c;
}

// Accepted contract whose timestamps (and optional valueBrl) are placed in a chosen period.
function accepted(s, { createdAt, acceptedAt, valueBrl, ...rest }) {
  const c = delivered(s, rest);
  s.accept(c.id, client);
  c.createdAt = createdAt;
  c.acceptedAt = acceptedAt;
  if (valueBrl !== undefined) c.valueBrl = valueBrl;
  return c;
}

// Moves the timestamp of the latest event of this type.
function stampLast(s, type, at) {
  [...s.state.events].reverse().find((e) => e.type === type).at = at;
}

const OCT_1 = '2026-10-01T00:00:00.000Z';
const NOV_1 = '2026-11-01T00:00:00.000Z';
const SEP_15 = '2026-09-15T10:00:00.000Z';

test('default period is the current UTC month; out-of-period contracts stay out', () => {
  const s = new Contracts();
  accepted(s, { title: 'Dentro', createdAt: '2026-10-01T09:00:00.000Z', acceptedAt: '2026-10-03T09:00:00.000Z' });
  accepted(s, { title: 'Setembro', createdAt: '2026-09-20T09:00:00.000Z', acceptedAt: '2026-09-30T23:59:00.000Z' });
  accepted(s, { title: 'Depois de agora', createdAt: '2026-10-14T09:00:00.000Z', acceptedAt: '2026-10-16T09:00:00.000Z' });

  const r = report(s, { now: new Date('2026-10-15T12:00:00.000Z') });
  assert.equal(r.from, OCT_1);
  assert.equal(r.to, '2026-10-15T12:00:00.000Z');
  assert.deepEqual(r.delivered.map((d) => d.title), ['Dentro']);
});

test('delivered list: accepted only, newest first, with the documented fields', () => {
  const s = new Contracts();
  const a = accepted(s, { title: 'Antigo', createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-03T12:00:00.000Z', costUsd: 1.25 });
  const b = accepted(s, { title: 'Novo', createdAt: '2026-10-05T00:00:00.000Z', acceptedAt: '2026-10-20T00:00:00.000Z', costUsd: 0.5, area: 'web' });
  s.createIntent({ title: 'Ainda aberto', criteria: ['x'] }, client);

  const r = report(s, { from: OCT_1, to: NOV_1 });
  assert.deepEqual(r.delivered, [
    { id: b.id, title: 'Novo', area: 'web', goalId: null, deliveredAt: b.acceptedAt, days: 15, costUsd: 0.5, valueBrl: null },
    { id: a.id, title: 'Antigo', area: null, goalId: null, deliveredAt: a.acceptedAt, days: 2.5, costUsd: 1.25, valueBrl: null },
  ]);
});

test('totals: cost in 2 decimals, valueBrl sums only filled values, avgDays in 1 decimal', () => {
  const s = new Contracts();
  accepted(s, { createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-03T00:00:00.000Z', costUsd: 0.333, valueBrl: 1000 });
  accepted(s, { createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-04T00:00:00.000Z', costUsd: 0.333 });
  accepted(s, { createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-02T06:00:00.000Z', costUsd: 0.001, valueBrl: 0 });

  const r = report(s, { from: OCT_1, to: NOV_1 });
  assert.equal(r.totals.delivered, 3);
  assert.equal(r.totals.costUsd, 0.67);
  assert.equal(r.totals.valueBrl, 1000);
  assert.equal(r.totals.avgDays, 2.1); // (2 + 3 + 1.25) / 3 = 2.083...
});

test('no deliveries: avgDays and valueBrl are null and the highlight says so', () => {
  const s = new Contracts();
  const r = report(s, { from: OCT_1, to: NOV_1 });
  assert.equal(r.totals.delivered, 0);
  assert.equal(r.totals.avgDays, null);
  assert.equal(r.totals.valueBrl, null);
  assert.equal(r.highlights[0], 'Nenhum pedido entregue no período.');
  assert.ok(r.highlights.length >= 2 && r.highlights.length <= 4);
});

test('previous period has the same length and feeds the "a mais" comparison', () => {
  const s = new Contracts();
  // Previous period: [Aug 31, Oct 1), 31 days.
  accepted(s, { createdAt: '2026-09-10T10:00:00.000Z', acceptedAt: SEP_15 });
  // Current period: [Oct 1, Nov 1). Oct 1 00:00 is in, Nov 1 00:00 is out.
  accepted(s, { createdAt: '2026-09-30T00:00:00.000Z', acceptedAt: OCT_1 });
  accepted(s, { createdAt: '2026-10-05T00:00:00.000Z', acceptedAt: '2026-10-10T00:00:00.000Z' });
  accepted(s, { createdAt: '2026-10-15T00:00:00.000Z', acceptedAt: '2026-10-20T00:00:00.000Z' });
  accepted(s, { createdAt: '2026-10-25T00:00:00.000Z', acceptedAt: NOV_1 });

  const r = report(s, { from: OCT_1, to: NOV_1 });
  assert.equal(r.totals.delivered, 3);
  assert.deepEqual(r.previous, { delivered: 1, costUsd: 0, avgDays: 5 });
  assert.equal(r.highlights[0], 'Entregamos 3 pedidos, 2 a mais que no período anterior.');
});

test('comparison sentences: "a menos" and "o mesmo número"', () => {
  const fewer = new Contracts();
  accepted(fewer, { createdAt: '2026-09-10T00:00:00.000Z', acceptedAt: SEP_15 });
  accepted(fewer, { createdAt: '2026-09-10T00:00:00.000Z', acceptedAt: '2026-09-16T00:00:00.000Z' });
  accepted(fewer, { createdAt: '2026-10-05T00:00:00.000Z', acceptedAt: '2026-10-06T00:00:00.000Z' });
  assert.equal(report(fewer, { from: OCT_1, to: NOV_1 }).highlights[0],
    'Entregamos 1 pedido, 1 a menos que no período anterior.');

  const same = new Contracts();
  accepted(same, { createdAt: '2026-09-10T00:00:00.000Z', acceptedAt: SEP_15 });
  accepted(same, { createdAt: '2026-10-05T00:00:00.000Z', acceptedAt: '2026-10-06T00:00:00.000Z' });
  assert.equal(report(same, { from: OCT_1, to: NOV_1 }).highlights[0],
    'Entregamos 1 pedido, o mesmo número que no período anterior.');
});

test('highlights use decimal comma for days and pt-BR money for valueBrl', () => {
  const s = new Contracts();
  accepted(s, { createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-03T00:00:00.000Z', valueBrl: 10000 });
  accepted(s, { createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-04T00:00:00.000Z', valueBrl: 2500 });

  const r = report(s, { from: OCT_1, to: NOV_1 });
  assert.deepEqual(r.highlights, [
    'Entregamos 2 pedidos, 2 a mais que no período anterior.',
    'O tempo médio de entrega foi de 2,5 dias.',
    'Valor estimado entregue: R$ 12.500,00.',
  ]);
});

test('incidents, rejections and changes are counted by their period', () => {
  const s = new Contracts();
  // Stuck in building after a rejection; it does not block the incidents below.
  const rejected = delivered(s, { title: 'Recusado' });
  s.reject(rejected.id, { reason: 'faltou teste' }, client);
  stampLast(s, 'reject', '2026-10-07T10:00:00.000Z');

  s.createIntent({ title: 'Falha no login', criteria: ['x'], kind: 'incident' }, client).createdAt = '2026-10-05T08:00:00.000Z';
  s.createIntent({ title: 'Falha no pagamento', criteria: ['x'], kind: 'incident' }, client).createdAt = '2026-10-30T08:00:00.000Z';
  s.createIntent({ title: 'Antiga', criteria: ['x'], kind: 'incident' }, client).createdAt = SEP_15;
  s.createIntent({ title: 'Melhoria', criteria: ['x'] }, client).createdAt = '2026-10-06T00:00:00.000Z';

  s.requestChange(rejected.id, { criteria: ['login works', 'mfa'], reason: 'mfa' }, client);
  stampLast(s, 'change', '2026-10-08T10:00:00.000Z');

  const r = report(s, { from: OCT_1, to: NOV_1 });
  assert.equal(r.totals.incidents, 2);
  assert.equal(r.totals.rejected, 1);
  assert.equal(r.totals.changes, 1);
  assert.ok(r.highlights.includes('Houve 2 incidentes no período.'));
});

test('byArea and byGoal: "sem área" fallback, goal titles, removed goals', () => {
  const s = new Contracts();
  const checkout = s.createGoal({ title: 'Checkout' }, client);
  const old = s.createGoal({ title: 'Antigo' }, client);
  const when = { createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-03T00:00:00.000Z' };

  accepted(s, { ...when, area: 'web', goalId: checkout.id, costUsd: 1.5 });
  accepted(s, { ...when, area: 'web', costUsd: 0.5 });
  accepted(s, { ...when, goalId: checkout.id, costUsd: 1 });
  accepted(s, { ...when, area: 'api', goalId: old.id, costUsd: 0.25 });
  s.state.goals = s.state.goals.filter((g) => g.id !== old.id);

  const r = report(s, { from: OCT_1, to: NOV_1 });
  assert.deepEqual(r.byArea, {
    web: { delivered: 2, costUsd: 2 },
    'sem área': { delivered: 1, costUsd: 1 },
    api: { delivered: 1, costUsd: 0.25 },
  });
  assert.deepEqual(r.byGoal, {
    [checkout.id]: { title: 'Checkout', delivered: 2, costUsd: 2.5 },
    [old.id]: { title: 'Objetivo removido', delivered: 1, costUsd: 0.25 },
  });
});

test('CSV: header, decimal comma, ; and " escaping, empty cells, CRLF', () => {
  const s = new Contracts();
  const goal = s.createGoal({ title: 'Checkout' }, client);
  accepted(s, {
    title: 'Relatório; "ajuste" final', createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-03T12:00:00.000Z',
    area: 'web', goalId: goal.id, costUsd: 1.25, valueBrl: 1234.5,
  });
  accepted(s, { title: 'Simples', createdAt: '2026-10-01T00:00:00.000Z', acceptedAt: '2026-10-04T00:00:00.000Z', costUsd: 0 });

  const raw = reportCsv(report(s, { from: OCT_1, to: NOV_1 }));
  assert.ok(raw.startsWith('\uFEFF'), 'starts with BOM');
  const csv = raw.slice(1);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'pedido;área;objetivo;entregue em;dias;custo (US$);valor (R$)');
  // Newest first: 'Simples' (Oct 4) before the report-title one (Oct 3).
  assert.equal(lines[1], 'Simples;sem área;;2026-10-04;3,0;0,00;');
  assert.equal(lines[2], '"Relatório; ""ajuste"" final";web;Checkout;2026-10-03;2,5;1,25;1234,50');
  assert.equal(lines[3], '');
  assert.ok(csv.endsWith('\r\n'));
  assert.ok(!csv.replace(/\r\n/g, '').includes('\n'));
});

test('CSV of a period without deliveries is just the header', () => {
  const r = report(new Contracts(), { from: OCT_1, to: NOV_1 });
  assert.equal(reportCsv(r), '\uFEFFpedido;área;objetivo;entregue em;dias;custo (US$);valor (R$)\r\n');
});

test('invalid periods are refused with 400', () => {
  const s = new Contracts();
  assert.throws(() => report(s, { from: 'nao-e-data' }), (e) => e.status === 400);
  assert.throws(() => report(s, { from: NOV_1, to: OCT_1 }), (e) => e.status === 400);
});
