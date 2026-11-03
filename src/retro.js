// Automatic retrospective: what went wrong in the last N days, in plain Portuguese,
// with a short suggestion for each kind of finding. Derived from the event log only.
// Spec: docs/spec-proximos.md, section 3.
import { calibration } from './estimate.js';
import { flow } from './flow.js';

const DAY = 864e5;
const REJECT_RATE = 0.3;
const MIN_DELIVERIES = 3;
const MIN_ESTIMATE_SAMPLES = 3;
const ESTIMATE_BIAS = 1.3;
const HIGH_BUDGET_ESCALATIONS = 3;
const TOP_WORDS = 5;
const MIN_WORD = 4;

// Common Portuguese words that say nothing about why work was rejected.
const STOPWORDS = new Set([
  'para', 'pela', 'pelo', 'pelas', 'pelos', 'com', 'sem', 'uma', 'umas', 'uns', 'mais', 'mas', 'como',
  'isso', 'isto', 'esta', 'este', 'estes', 'estas', 'esse', 'essa', 'esses', 'essas', 'aquele', 'aquela',
  'quando', 'onde', 'entre', 'sobre', 'ainda', 'muito', 'muita', 'muitos', 'muitas', 'pode', 'podem',
  'foi', 'ser', 'sendo', 'estao', 'estão', 'também', 'tambem', 'depois', 'antes', 'porque',
  'pois', 'nao', 'não', 'seja', 'sido', 'tem', 'têm', 'todo', 'toda', 'todos', 'todas', 'outro',
  'outra', 'outros', 'outras', 'cada', 'algum', 'alguma', 'apenas', 'dessa', 'desse', 'deste', 'desta',
  'nesta', 'neste', 'nessa', 'nesse', 'numa', 'vezes',
]);

export function retro(store, { days = 14, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const inWindow = (e) => Date.parse(e.at) >= since;
  const events = store.state.events.filter(inWindow);
  const ofType = (type) => events.filter((e) => e.type === type);

  const deliveries = ofType('deliver');
  const rejects = ofType('reject');
  const escalations = ofType('escalated');
  const accepts = ofType('accept');
  const approvedResolves = ofType('resolve').filter((e) => store.get(e.contractId).state === 'accepted');

  const recurring = store.state.contracts.filter((c) => c.source?.recurrenceOf && Date.parse(c.createdAt) >= since);
  const stale = flow(store, { nowMs: now }).stale;
  const overBudget = escalations.filter((e) => String(e.data?.reason ?? '').includes('exceeds budget'));

  const numbers = {
    accepted: accepts.length + approvedResolves.length,
    rejected: rejects.length,
    escalated: escalations.length,
    overBudget: overBudget.length,
    recurrences: recurring.length,
    stale: stale.length,
  };

  const findings = [];
  const suggestions = [];
  const suggest = (text, action) => {
    if (!suggestions.some((s) => s.action === action)) suggestions.push({ text, action });
  };

  // Rejections: how many delivered work came back for changes.
  const rate = deliveries.length ? rejects.length / deliveries.length : 0;
  if (deliveries.length >= MIN_DELIVERIES && rate >= REJECT_RATE) {
    findings.push({
      kind: 'rejeicoes',
      severity: 'atenção',
      text: `${rejects.length} de ${deliveries.length} entregas (${Math.round(rate * 100)}%) voltaram para ajustes.`,
      evidence: {
        rate: round(rate),
        deliveries: deliveries.length,
        rejected: rejects.length,
        topWords: topWords(rejects.map((e) => e.data?.reason ?? '')),
      },
    });
    suggest('Detalhar melhor os critérios antes de começar', 'refinar_criterios');
  }

  // Escalations: grouped by the kind of reason.
  if (escalations.length) {
    const count = { orcamento: 0, semAcordo: 0, irreversivel: 0, pedidoManual: 0 };
    for (const e of escalations) {
      const r = String(e.data?.reason ?? '');
      if (r.includes('exceeds budget')) count.orcamento++;
      else if (r.includes('no agreement')) count.semAcordo++;
      else if (r.includes('irreversible')) count.irreversivel++;
      else count.pedidoManual++;
    }
    findings.push({
      kind: 'escalonamentos',
      severity: count.orcamento >= HIGH_BUDGET_ESCALATIONS ? 'alta' : 'info',
      text: `${escalations.length} pedido(s) precisaram de decisão humana: ${count.orcamento} por orçamento, ${count.semAcordo} sem acordo, ${count.irreversivel} irreversíveis, ${count.pedidoManual} por pedido manual.`,
      evidence: { total: escalations.length, ...count },
    });
    if (count.semAcordo > 0) suggest('Quebrar pedidos grandes em partes menores', 'quebrar_pedidos');
  }

  // Estimates: agents whose real hours run well above what they estimated.
  for (const [agent, metrics] of Object.entries(calibration(store))) {
    const h = metrics.hours;
    if (h.samples >= MIN_ESTIMATE_SAMPLES && h.medianRatio >= ESTIMATE_BIAS) {
      findings.push({
        kind: 'estimativa',
        severity: 'atenção',
        text: `${agent} costuma levar ${decimal(h.medianRatio)} vezes o tempo estimado.`,
        evidence: { agent, medianRatio: h.medianRatio, samples: h.samples },
      });
      suggest('Usar a estimativa calibrada deste agente nas próximas propostas', 'calibrar_agente');
    }
  }

  if (overBudget.length) {
    findings.push({
      kind: 'orcamento',
      severity: 'atenção',
      text: `${overBudget.length} pedido(s) pararam por gasto acima do orçamento.`,
      evidence: { count: overBudget.length },
    });
    suggest('Revisar o orçamento dos pedidos que estouraram o limite, ou cortar escopo', 'ajustar_orcamento');
  }

  if (recurring.length) {
    const titles = recurring.slice(0, 3).map((c) => c.title);
    findings.push({
      kind: 'recorrencia',
      severity: 'alta',
      text: `O problema voltou em ${recurring.length} pedido(s): ${titles.join('; ')}.`,
      evidence: { count: recurring.length, ids: recurring.map((c) => c.id) },
    });
    suggest('Investigar a causa raiz antes de corrigir de novo', 'investigar_causa');
  }

  if (stale.length) {
    findings.push({
      kind: 'parados',
      severity: 'atenção',
      text: `${stale.length} item(ns) parado(s) há mais tempo que o normal.`,
      evidence: { count: stale.length, ids: stale },
    });
    suggest('Destravar os itens parados', 'destravar');
  }

  return { since: new Date(since).toISOString(), findings, suggestions, numbers };
}

// Most frequent meaningful words across reject reasons (ties broken alphabetically).
function topWords(reasons) {
  const counts = new Map();
  for (const reason of reasons) {
    for (const w of String(reason).toLowerCase().split(/[^\p{L}]+/u)) {
      if (w.length < MIN_WORD || STOPWORDS.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_WORDS)
    .map(([word]) => word);
}

// Brazilian decimal comma, one decimal place.
const decimal = (n) => n.toFixed(1).replace('.', ',');
const round = (n) => Math.round(n * 100) / 100;
