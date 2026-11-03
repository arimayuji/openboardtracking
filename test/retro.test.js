import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { retro } from '../src/retro.js';
import { Slack } from '../src/slack.js';
import { Webhooks } from '../src/webhooks.js';
import { createApp } from '../src/app.js';

const DAY = 864e5;
const client = { role: 'client', agent: 'c' };
const human = { role: 'human', agent: 'h' };
const integration = { role: 'integration', agent: 'x' };
const DOD = { 'dod-tests': true, 'dod-security': true };
const dev = (agent) => ({ role: 'dev', agent });

// Full happy path up to delivery. Criterion id is c1 (first string criterion).
function deliverOne(s, { agent = 'dev-b', title = 'Pedido', estimate = 1, hours = 1, irreversible = false } = {}) {
  const d = dev(agent);
  const c = s.createIntent({ title, criteria: ['tela funciona'], irreversible }, client);
  s.propose(c.id, { estimate: { hours: estimate } }, d);
  s.agree(c.id, { version: 2 }, client);
  s.agree(c.id, { version: 2 }, d);
  s.start(c.id, d);
  s.deliver(c.id, { results: { c1: true, ...DOD }, usage: { hours } }, d);
  return c;
}

// Contract that escalates for exceeding its hours budget while being built.
function budgetOverrun(s, agent = 'dev-a') {
  const d = dev(agent);
  const c = s.createIntent({ title: 'Relatório', criteria: ['gera PDF'], budget: { hours: 10 } }, client);
  s.propose(c.id, { estimate: { hours: 1 } }, d);
  s.agree(c.id, { version: 2 }, client);
  s.agree(c.id, { version: 2 }, d);
  s.start(c.id, d);
  s.reportUsage(c.id, { hours: 11 }, d);
  return c;
}

test('empty store: no findings, zero numbers, since is the window start', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const r = retro(new Contracts(), { days: 14, now });
  assert.equal(r.since, new Date(now - 14 * DAY).toISOString());
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.suggestions, []);
  assert.deepEqual(r.numbers, { accepted: 0, rejected: 0, escalated: 0, overBudget: 0, recurrences: 0, stale: 0 });
});

test('high rejection rate: 3 of 8 deliveries come back, with the most common reason words', () => {
  const s = new Contracts();
  const cs = Array.from({ length: 8 }, (_, i) => deliverOne(s, { title: `Entrega ${i}` }));
  const reasons = ['Faltou teste de integração no checkout', 'Checkout sem teste de integração', 'Login sem teste automatizado'];
  cs.slice(0, 3).forEach((c, i) => s.reject(c.id, { reason: reasons[i] }, client));

  const r = retro(s);
  const f = r.findings.find((x) => x.kind === 'rejeicoes');
  assert.equal(f.severity, 'atenção');
  assert.equal(f.text, '3 de 8 entregas (38%) voltaram para ajustes.');
  assert.equal(f.evidence.deliveries, 8);
  assert.equal(f.evidence.rejected, 3);
  assert.equal(f.evidence.rate, 0.38);
  assert.equal(f.evidence.topWords[0], 'teste');
  assert.ok(f.evidence.topWords.includes('checkout'));
  assert.ok(!f.evidence.topWords.includes('sem'), 'stopwords and short words are ignored');
  assert.ok(f.evidence.topWords.length <= 5);
  assert.equal(r.numbers.rejected, 3);
  assert.ok(r.suggestions.some((x) => x.action === 'refinar_criterios'));
});

test('few deliveries or a low rate do not trigger the rejection finding', () => {
  const s = new Contracts();
  const cs = Array.from({ length: 8 }, () => deliverOne(s));
  s.reject(cs[0].id, { reason: 'ajuste pequeno' }, client);
  assert.equal(retro(s).findings.some((x) => x.kind === 'rejeicoes'), false);

  const small = new Contracts();
  const two = [deliverOne(small), deliverOne(small)];
  small.reject(two[0].id, { reason: 'ajuste' }, client);
  small.reject(two[1].id, { reason: 'ajuste' }, client);
  assert.equal(retro(small).findings.some((x) => x.kind === 'rejeicoes'), false, 'only 2 deliveries');
});

test('escalations are counted by type from the reason', () => {
  const s = new Contracts();
  budgetOverrun(s);
  deliverOne(s, { irreversible: true });
  const irreversible = s.list({ state: 'delivered' }).find((c) => c.irreversible);
  s.accept(irreversible.id, client);
  const manual = s.createIntent({ title: 'Cor do botão', criteria: ['botão azul'] }, client);
  s.escalate(manual.id, { reason: 'Preciso decidir a cor' }, client);
  const noAgreement = s.createIntent({ title: 'Layout', criteria: ['grade'] }, client);
  for (let i = 0; i < 6; i++) s.propose(noAgreement.id, { criteria: ['grade'] }, client);
  assert.equal(s.get(noAgreement.id).state, 'escalated');

  const r = retro(s);
  const f = r.findings.find((x) => x.kind === 'escalonamentos');
  assert.equal(f.severity, 'info');
  assert.deepEqual(
    { total: f.evidence.total, orcamento: f.evidence.orcamento, semAcordo: f.evidence.semAcordo, irreversivel: f.evidence.irreversivel, pedidoManual: f.evidence.pedidoManual },
    { total: 4, orcamento: 1, semAcordo: 1, irreversivel: 1, pedidoManual: 1 },
  );
  assert.equal(r.numbers.escalated, 4);
  assert.equal(r.numbers.overBudget, 1);
  assert.ok(r.suggestions.some((x) => x.action === 'quebrar_pedidos'));
});

test('estimate bias: an agent who takes twice the estimate gets a finding with a decimal comma', () => {
  const s = new Contracts();
  for (let i = 0; i < 2; i++) deliverOne(s, { agent: 'dev-a', estimate: 2, hours: 4 });
  assert.equal(retro(s).findings.some((x) => x.kind === 'estimativa'), false, 'needs at least 3 samples');

  deliverOne(s, { agent: 'dev-a', estimate: 2, hours: 4 });
  const r = retro(s);
  const f = r.findings.find((x) => x.kind === 'estimativa');
  assert.equal(f.severity, 'atenção');
  assert.equal(f.text, 'dev-a costuma levar 2,0 vezes o tempo estimado.');
  assert.equal(f.evidence.samples, 3);
  assert.ok(r.suggestions.some((x) => x.action === 'calibrar_agente'));
});

test('overBudget: escalations for spending past the budget, three of them is high severity', () => {
  const s = new Contracts();
  for (let i = 0; i < 3; i++) budgetOverrun(s, 'dev-a');
  const r = retro(s);
  assert.equal(r.numbers.overBudget, 3);
  assert.equal(r.findings.find((x) => x.kind === 'escalonamentos').severity, 'alta');
  const f = r.findings.find((x) => x.kind === 'orcamento');
  assert.equal(f.severity, 'atenção');
  assert.equal(f.text, '3 pedido(s) pararam por gasto acima do orçamento.');
  assert.ok(r.suggestions.some((x) => x.action === 'ajustar_orcamento'));
});

test('recurrence: a contract opened from a signal with recurrenceOf is high severity', () => {
  const s = new Contracts();
  s.openSignal({ title: '[alerta] API fora', criteria: ['API responde'], source: { type: 'datadog', fingerprint: 'f1', recurrenceOf: 'abcd1234' } }, integration);
  const r = retro(s);
  assert.equal(r.numbers.recurrences, 1);
  const f = r.findings.find((x) => x.kind === 'recorrencia');
  assert.equal(f.severity, 'alta');
  assert.match(f.text, /\[alerta\] API fora/);
  assert.ok(r.suggestions.some((x) => x.action === 'investigar_causa'));
});

test('window: events older than the window are left out', () => {
  const s = new Contracts();
  for (let i = 0; i < 3; i++) s.accept(deliverOne(s, { title: `Aceito ${i}` }).id, client);
  assert.equal(retro(s).numbers.accepted, 3);

  const later = retro(s, { days: 14, now: Date.now() + 60 * DAY });
  assert.equal(later.numbers.accepted, 0);
  assert.equal(later.numbers.rejected, 0);
  assert.deepEqual(later.findings, []);
});

test('accepted counts accept events and approved escalations; approved ones show up in the window', () => {
  const s = new Contracts();
  s.accept(deliverOne(s).id, client);
  const risky = deliverOne(s, { irreversible: true });
  s.accept(risky.id, client);
  assert.equal(s.get(risky.id).state, 'escalated');
  s.resolve(risky.id, { decision: 'approve' }, human);
  assert.equal(s.get(risky.id).state, 'accepted');
  assert.equal(retro(s).numbers.accepted, 2);
});

test('stale work is counted and suggests unblocking', () => {
  const s = new Contracts();
  const c = s.createIntent({ title: 'Parado', criteria: ['ok'] }, client);
  const r = retro(s, { now: Date.now() + 2 * DAY });
  assert.equal(r.numbers.stale, 1);
  assert.equal(r.findings.find((x) => x.kind === 'parados').severity, 'atenção');
  assert.ok(r.suggestions.some((x) => x.action === 'destravar'));
  assert.equal(c.state, 'negotiating');
});

test('suggestions: one per finding kind, mapped to action codes, no duplicates', () => {
  const s = new Contracts();
  for (let i = 0; i < 3; i++) deliverOne(s, { agent: 'dev-a', estimate: 2, hours: 4, title: `Estimado ${i}` });
  for (let i = 0; i < 5; i++) deliverOne(s, { title: `Entrega ${i}` });
  const rejected = s.list({ state: 'delivered' }).slice(0, 3);
  for (const c of rejected) s.reject(c.id, { reason: 'faltou teste' }, client);
  for (let i = 0; i < 3; i++) budgetOverrun(s, 'dev-b');
  const sem = s.createIntent({ title: 'Grande', criteria: ['tudo'] }, client);
  for (let i = 0; i < 6; i++) s.propose(sem.id, { criteria: ['tudo'] }, client);
  s.openSignal({ title: 'Login cai', criteria: ['login ok'], source: { type: 'sentry', recurrenceOf: 'zz' } }, integration);

  const r = retro(s, { now: Date.now() + 2 * DAY });
  const kinds = r.findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['escalonamentos', 'estimativa', 'orcamento', 'parados', 'recorrencia', 'rejeicoes']);
  const actions = r.suggestions.map((x) => x.action).sort();
  assert.deepEqual(actions, ['ajustar_orcamento', 'calibrar_agente', 'destravar', 'investigar_causa', 'quebrar_pedidos', 'refinar_criterios']);
  assert.ok(r.suggestions.every((x) => typeof x.text === 'string' && x.text.length > 0));
});

test('GET /api/retro returns the retrospective through the app', async () => {
  const store = new Contracts();
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const app = createApp({ store, hooks: new Webhooks(store, { fetchImpl }), slack: new Slack(store, { token: undefined }), env: {}, fetchImpl });
  const c = deliverOne(store);
  store.reject(c.id, { reason: 'ajuste' }, client);

  const res = await app.handle(new Request('http://x/api/retro?days=7'), human);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['findings', 'numbers', 'since', 'suggestions']);
  assert.equal(body.numbers.rejected, 1);
  assert.ok(Math.abs(Date.parse(body.since) - (Date.now() - 7 * DAY)) < 60e3, 'days=7 sets the window');

  const anon = await app.handle(new Request('http://x/api/retro'), null);
  assert.equal(anon.status, 401);
});

test('Slack digest adds "O que aprender" with at most 3 attention lines', () => {
  const s = new Contracts();
  const slack = new Slack(s, { token: undefined });
  const cs = Array.from({ length: 8 }, (_, i) => deliverOne(s, { title: `Entrega ${i}` }));
  for (const c of cs.slice(0, 3)) s.reject(c.id, { reason: 'faltou teste' }, client);
  for (let i = 0; i < 3; i++) budgetOverrun(s, 'dev-a');
  s.openSignal({ title: 'Login cai', criteria: ['login ok'], source: { type: 'sentry', recurrenceOf: 'zz' } }, integration);

  const text = slack.digestText();
  const lines = text.split('\n');
  const at = lines.indexOf('*O que aprender:*');
  assert.ok(at > 0, 'section present');
  const bullets = lines.slice(at + 1).filter((l) => l.startsWith('• '));
  assert.equal(bullets.length, 3);
  assert.match(text, /3 de 8 entregas/);
});

test('Slack digest has no "O que aprender" without attention or high findings, and escapes text', () => {
  const s = new Contracts();
  const slack = new Slack(s, { token: undefined });
  assert.doesNotMatch(slack.digestText(), /O que aprender/);

  s.openSignal({ title: 'Login <quebrado> & cai', criteria: ['login ok'], source: { type: 'sentry', recurrenceOf: 'zz' } }, integration);
  const text = slack.digestText();
  assert.match(text, /\*O que aprender:\*/);
  assert.match(text, /Login &lt;quebrado&gt; &amp; cai/);
  assert.doesNotMatch(text, /<quebrado>/);
});
