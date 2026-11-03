import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { STATUS, clientView, forecastText, timeline, overview } from '../src/plain.js';

const DOD = { 'dod-tests': true, 'dod-security': true };
const client = { role: 'client', agent: 'c' };
const dev = { role: 'dev', agent: 'd' };
const human = { role: 'human', agent: 'h' };
const ci = { role: 'integration', agent: 'ci' };

const intent = (s, extra = {}) => s.createIntent({ title: 'Relatório de turnover', criteria: ['relatório enviado', 'dados conferidos'], ...extra }, client);

// Drives a contract to 'building' with an hours estimate.
function building(s, { estimate = { hours: 4 }, ...extra } = {}) {
  const c = intent(s, extra);
  s.propose(c.id, { estimate, plan: 'plano' }, dev);
  s.agree(c.id, { version: 2 }, dev);
  s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  return c;
}

const deliver = (s, c, results = { c1: true, c2: true }) => s.deliver(c.id, { results: { ...results, ...DOD }, links: ['pr/1'] }, dev);

test('status labels and tones follow the plain-language table', () => {
  assert.deepEqual(STATUS.negotiating, { label: 'Em definição', tone: 'neutral' });
  assert.deepEqual(STATUS.building, { label: 'Em produção', tone: 'progress' });
  assert.deepEqual(STATUS.delivered, { label: 'Aguardando sua aprovação', tone: 'attention' });
  assert.deepEqual(STATUS.accepted, { label: 'Entregue', tone: 'success' });
  assert.deepEqual(STATUS.rejected, { label: 'Cancelado', tone: 'danger' });

  const s = new Contracts();
  const c = intent(s);
  assert.equal(clientView(s, c).status.code, 'negotiating');
  assert.equal(clientView(s, c).status.label, 'Em definição');
  assert.equal(clientView(s, c).area, null);
});

test('spent.brl is null without a rate and converted once fx is set', () => {
  const s = new Contracts();
  const c = building(s);
  s.reportUsage(c.id, { costUsd: 2 }, dev);

  assert.deepEqual(clientView(s, c).spent, { usd: 2, brl: null });
  assert.equal(overview(s).spentThisMonth.brl, null);

  s.state.config.fx = { usdToBrl: 5 };
  assert.deepEqual(clientView(s, c).spent, { usd: 2, brl: 10 });
  assert.equal(overview(s).spentThisMonth.brl, 10);
});

test('budget escalation becomes the budget question with three options', () => {
  const s = new Contracts();
  const c = intent(s, { budget: { hours: 5 } });
  s.propose(c.id, { estimate: { hours: 4 }, plan: 'p' }, dev);
  assert.equal(c.state, 'escalated');

  const view = clientView(s, c);
  assert.equal(view.status.label, 'Precisa da sua decisão');
  assert.equal(view.needsDecision.question, 'O custo previsto passou do orçamento combinado. Quer aprovar mesmo assim, ajustar o pedido ou cancelar?');
  assert.deepEqual(view.needsDecision.options, [
    { decision: 'approve', label: 'Aprovar' },
    { decision: 'renegotiate', label: 'Ajustar' },
    { decision: 'cancel', label: 'Cancelar' },
  ]);
});

test('irreversible change asks for authorization and cannot be accepted yet', () => {
  const s = new Contracts();
  const c = intent(s, { irreversible: true });
  s.propose(c.id, { estimate: { hours: 1 }, plan: 'p' }, dev);
  s.agree(c.id, { version: 2 }, dev);
  s.agree(c.id, { version: 2 }, client);
  s.start(c.id, dev);
  deliver(s, c);
  s.accept(c.id, client);

  assert.equal(c.state, 'escalated');
  const view = clientView(s, c);
  assert.equal(view.needsDecision.question, 'Esta entrega mexe em algo que não dá para desfazer. Você autoriza?');
  assert.equal(view.canAccept, false);
});

test('no-agreement escalation and generic escalation get their own questions', () => {
  const s = new Contracts();
  const c = intent(s);
  for (let i = 0; i < 6; i++) s.propose(c.id, { criteria: [`versão ${i}`] }, client);
  assert.equal(clientView(s, c).needsDecision.question, 'Não houve acordo sobre o escopo. Quer aprovar a última proposta, rediscutir ou cancelar?');

  const g = intent(s);
  s.escalate(g.id, { reason: 'cliente pediu revisão' }, client);
  assert.equal(clientView(s, g).needsDecision.question, 'Precisamos da sua decisão: cliente pediu revisão');
  assert.equal(clientView(s, intent(s)).needsDecision, null);
});

test('forecast rounds remaining hours up to working days and drops out when finished', () => {
  const s = new Contracts();
  const c = building(s, { estimate: { hours: 4 } });
  // Calibrated P85 with no history is 9h: two days of 8h.
  assert.equal(forecastText(s, c), 'Boa chance de ficar pronto em até 2 dias (85%)');

  s.reportUsage(c.id, { hours: 4 }, dev);
  // 5h left -> 1 day.
  assert.equal(forecastText(s, c), 'Boa chance de ficar pronto em até 1 dia (85%)');
  assert.equal(clientView(s, c).forecast.text, 'Boa chance de ficar pronto em até 1 dia (85%)');

  s.reportUsage(c.id, { hours: 20 }, dev);
  // Over the estimate: never negative, still at least one day.
  assert.equal(forecastText(s, c), 'Boa chance de ficar pronto em até 1 dia (85%)');

  deliver(s, c);
  assert.equal(forecastText(s, c), null);
  assert.equal(clientView(s, c).forecast, null);
});

test('criteria done flags come from delivery results or verified checks, never from DoD', () => {
  const s = new Contracts();
  const c = building(s);
  s.setVerified(c.id, 'c2', true, 'ci', ci);
  s.deliver(c.id, { results: { c1: true, 'dod-tests': true, ...DOD }, links: [] }, dev);

  const view = clientView(s, c);
  assert.deepEqual(view.criteria, [
    { text: 'relatório enviado', done: true },
    { text: 'dados conferidos', done: true },
  ]);
  assert.equal(view.canAccept, true);

  const t = building(s);
  s.deliver(t.id, { results: { c1: false, c2: true, ...DOD }, links: [] }, dev);
  assert.deepEqual(clientView(s, t).criteria.map((k) => k.done), [false, true]);
});

test('timeline turns events into plain sentences and skips internal ones', () => {
  const s = new Contracts();
  const c = building(s);
  deliver(s, c);
  s.accept(c.id, client);

  assert.deepEqual(timeline(s, c).map((e) => e.text), [
    'Pedido criado',
    'Escopo combinado',
    'Produção iniciada',
    'Entregue para sua aprovação',
    'Você aprovou a entrega',
  ]);
  assert.ok(timeline(s, c).every((e) => typeof e.at === 'string'));

  const r = building(s);
  deliver(s, r);
  s.reject(r.id, { reason: 'faltou gráfico' }, client);
  assert.equal(timeline(s, r).at(-1).text, 'Você pediu ajustes');
});

test('overview counts by state and by month, with recent deliveries', () => {
  const s = new Contracts();
  const a = building(s, { title: 'A' });
  const b = building(s, { title: 'B' });
  intent(s, { title: 'C' });
  deliver(s, a);
  s.accept(a.id, client);
  s.reportUsage(b.id, { costUsd: 3 }, dev);
  deliver(s, b);

  // Pin the dates to October 2026 so the month logic is deterministic.
  a.createdAt = '2026-10-01T10:00:00.000Z';
  a.acceptedAt = '2026-10-05T10:00:00.000Z';
  a.updatedAt = '2026-10-05T10:00:00.000Z';
  b.updatedAt = '2026-10-10T10:00:00.000Z';

  const october = overview(s, new Date('2026-10-20T12:00:00Z'));
  assert.equal(october.deliveredThisMonth, 1);
  assert.equal(october.inProgress, 1);
  assert.equal(october.waitingYou, 1);
  assert.equal(october.avgDaysToDeliver, 4);
  assert.deepEqual(october.recentDeliveries, [{ id: a.id, title: 'A', deliveredAt: '2026-10-05T10:00:00.000Z' }]);
  assert.deepEqual(october.spentThisMonth, { usd: 3, brl: null });

  const november = overview(s, new Date('2026-11-02T12:00:00Z'));
  assert.equal(november.deliveredThisMonth, 0);
  assert.deepEqual(november.spentThisMonth, { usd: 0, brl: null });
});

test('overview is empty-safe and reports no average without deliveries', () => {
  const s = new Contracts();
  assert.deepEqual(overview(s, new Date('2026-11-02T00:00:00Z')), {
    deliveredThisMonth: 0,
    inProgress: 0,
    waitingYou: 0,
    spentThisMonth: { usd: 0, brl: null },
    avgDaysToDeliver: null,
    recentDeliveries: [],
  });
});

test('client-facing text never contains internal jargon', () => {
  const s = new Contracts();
  const c = building(s);
  deliver(s, c);
  const texts = [
    ...Object.values(STATUS).map((x) => x.label),
    ...timeline(s, c).map((e) => e.text),
    JSON.stringify(clientView(s, c)),
    JSON.stringify(overview(s)),
  ].join('\n');
  for (const word of [/\bPR\b/, /token/i, /\bWIP\b/, /\bDoD\b/, /building/i]) assert.doesNotMatch(texts, word);
});
