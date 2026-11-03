// Client view in plain Portuguese: what a non-technical client sees about each contract.
// Nothing here may leak internal jargon (PR, token, WIP, DoD, building...).
// Pure functions over the store, so the same code runs in Node and on Cloudflare Workers.

export const STATUS = {
  negotiating: { label: 'Em definição', tone: 'neutral' },
  agreed: { label: 'Pronto para começar', tone: 'neutral' },
  building: { label: 'Em produção', tone: 'progress' },
  delivered: { label: 'Aguardando sua aprovação', tone: 'attention' },
  escalated: { label: 'Precisa da sua decisão', tone: 'attention' },
  accepted: { label: 'Entregue', tone: 'success' },
  rejected: { label: 'Cancelado', tone: 'danger' },
};

const DECISION_OPTIONS = [
  { decision: 'approve', label: 'Aprovar' },
  { decision: 'renegotiate', label: 'Ajustar' },
  { decision: 'cancel', label: 'Cancelar' },
];

const TIMELINE_TEXT = {
  intent: 'Pedido criado',
  agreed: 'Escopo combinado',
  start: 'Produção iniciada',
  deliver: 'Entregue para sua aprovação',
  accept: 'Você aprovou a entrega',
  reject: 'Você pediu ajustes',
  escalated: 'Precisa da sua decisão',
  resolve: 'Decisão registrada',
  occurrence: 'O problema aconteceu de novo',
  verified: 'Verificação automática concluída',
  change: 'Você pediu uma mudança no pedido',
  'goal-link': 'Pedido ligado a um objetivo',
};

const HOURS_PER_DAY = 8;

// USD -> BRL rate from organization config, or null when none is set.
function usdToBrl(store) {
  const rate = store.config?.fx?.usdToBrl;
  return typeof rate === 'number' && rate > 0 ? rate : null;
}

function toBrl(store, usd) {
  const rate = usdToBrl(store);
  return rate == null ? null : round(usd * rate, 2);
}

// actor (optional): canDecide tells the portal whether this person may approve; no actor = true.
export function clientView(store, contract, actor) {
  const c = contract;
  const forecast = forecastText(store, c);
  return {
    id: c.id,
    title: c.title,
    area: c.area ?? null,
    goalId: c.goalId ?? null,
    canDecide: actor ? store.canApprove(actor.agent) : true,
    canChange: ['agreed', 'building', 'delivered'].includes(c.state),
    createdAt: c.createdAt,
    status: { code: c.state, ...(STATUS[c.state] ?? { label: c.state, tone: 'neutral' }) },
    spent: { usd: c.usage?.costUsd ?? 0, brl: toBrl(store, c.usage?.costUsd ?? 0) },
    forecast: forecast == null ? null : { text: forecast },
    needsDecision: c.state === 'escalated' ? decisionFor(c.escalation?.reason ?? '') : null,
    canAccept: c.state === 'delivered',
    proposal: proposalFor(store, c),
    criteria: (c.proposal?.criteria ?? []).map((k) => ({
      text: k.text,
      done: c.verified?.[k.id] === true || c.delivery?.results?.[k.id] === true,
    })),
  };
}

// The dev side proposed estimate and plan; the client must confirm it before work starts.
function proposalFor(store, c) {
  const p = c.proposal;
  if (c.state !== 'negotiating' || p?.by !== 'dev' || !p.estimate || !Object.keys(p.estimate).length) return null;
  if (c.agreedBy?.includes('client')) return null;
  const hours = p.calibrated?.hours?.p85 ?? p.estimate.hours;
  const parts = [];
  if (hours != null) {
    const days = Math.max(1, Math.ceil(hours / 8));
    parts.push(`prazo estimado de até ${days} ${days === 1 ? 'dia' : 'dias'} (85% de chance)`);
  }
  const usd = p.calibrated?.costUsd?.p85 ?? p.estimate.costUsd;
  if (usd != null) {
    const brl = toBrl(store, usd);
    parts.push(brl != null ? `custo previsto de até R$ ${brl.toFixed(2).replace('.', ',')}` : `custo previsto de até US$ ${usd}`);
  }
  return {
    version: p.version,
    text: `O time propôs: ${parts.join(' e ') || 'começar o trabalho'}.${p.plan ? ` Como: ${p.plan}` : ''} Confirme para começar.`,
  };
}

// Turns an escalation reason into a question the client can answer.
function decisionFor(reason) {
  let question;
  if (reason.includes('exceeds budget')) {
    question = 'O custo previsto passou do orçamento combinado. Quer aprovar mesmo assim, ajustar o pedido ou cancelar?';
  } else if (reason.includes('irreversible')) {
    question = 'Esta entrega mexe em algo que não dá para desfazer. Você autoriza?';
  } else if (reason.includes('no agreement')) {
    question = 'Não houve acordo sobre o escopo. Quer aprovar a última proposta, rediscutir ou cancelar?';
  } else {
    question = `Precisamos da sua decisão: ${reason}`;
  }
  return { question, options: DECISION_OPTIONS.map((o) => ({ ...o })) };
}

// Forecast in working days of 8h, rounded up, using the calibrated P85 hours.
// Returns null when there is no hours estimate or the work is already finished.
export function forecastText(store, contract) {
  const c = contract;
  if (c.proposal?.estimate?.hours == null) return null;
  if (['accepted', 'rejected', 'delivered'].includes(c.state)) return null;
  const target = c.proposal.calibrated?.hours?.p85 ?? c.proposal.estimate.hours;
  const remaining = Math.max(0, target - (c.usage?.hours ?? 0));
  const days = Math.max(1, Math.ceil(remaining / HOURS_PER_DAY));
  return `Boa chance de ficar pronto em até ${days} ${days === 1 ? 'dia' : 'dias'} (85%)`;
}

// Chronology of the contract, in plain sentences. Internal-only events are skipped.
export function timeline(store, contract) {
  return store.history(contract.id)
    .filter((e) => Object.hasOwn(TIMELINE_TEXT, e.type))
    .map((e) => ({ at: e.at, text: TIMELINE_TEXT[e.type] }));
}

// Dashboard numbers for the client home. `now` selects the calendar month (UTC).
export function overview(store, now = new Date()) {
  const all = store.list();
  const inMonth = (iso) => {
    if (!iso) return false;
    const d = new Date(iso);
    return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
  };
  const count = (...states) => all.filter((c) => states.includes(c.state)).length;
  const accepted = all.filter((c) => c.state === 'accepted');
  const spentUsd = round(all.filter((c) => inMonth(c.updatedAt)).reduce((s, c) => s + (c.usage?.costUsd ?? 0), 0), 2);
  const days = accepted.map((c) => (Date.parse(c.acceptedAt) - Date.parse(c.createdAt)) / 864e5);

  return {
    deliveredThisMonth: accepted.filter((c) => inMonth(c.acceptedAt)).length,
    inProgress: count('negotiating', 'agreed', 'building'),
    waitingYou: count('delivered', 'escalated'),
    spentThisMonth: { usd: spentUsd, brl: toBrl(store, spentUsd) },
    avgDaysToDeliver: days.length ? round(days.reduce((s, d) => s + d, 0) / days.length, 1) : null,
    recentDeliveries: [...accepted]
      .sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt))
      .slice(0, 5)
      .map((c) => ({ id: c.id, title: c.title, deliveredAt: c.acceptedAt })),
  };
}

function round(n, d = 2) {
  return Math.round(n * 10 ** d) / 10 ** d;
}
