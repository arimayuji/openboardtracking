// Relatório por período: o que foi entregue, quanto custou, valor estimado e
// comparação com o período anterior de mesmo tamanho. Tudo derivado do estado
// (contratos e eventos), sem guardar nada novo.
import { httpError } from './contract.js';

const DAY = 86400e3;
const SEM_AREA = 'sem área';
const OBJETIVO_REMOVIDO = 'Objetivo removido';

export function report(store, { from, to, now = new Date() } = {}) {
  const nowDate = toDate(now, 'now');
  const end = to == null ? nowDate : toDate(to, 'to');
  const start = from == null ? new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)) : toDate(from, 'from');
  if (start >= end) throw httpError(400, 'from deve ser anterior a to');

  const len = end - start;
  const prevStart = new Date(start.getTime() - len);
  const cur = summarize(store, start, end);
  const prev = summarize(store, prevStart, start);
  const previous = { delivered: prev.totals.delivered, costUsd: prev.totals.costUsd, avgDays: prev.totals.avgDays };

  return {
    from: start.toISOString(),
    to: end.toISOString(),
    delivered: cur.delivered,
    totals: cur.totals,
    byArea: cur.byArea,
    byGoal: cur.byGoal,
    previous,
    highlights: highlights(cur.totals, previous),
  };
}

// Semicolon-separated, Portuguese header, decimal comma, CRLF line endings.
export function reportCsv(r) {
  const header = ['pedido', 'área', 'objetivo', 'entregue em', 'dias', 'custo (US$)', 'valor (R$)'];
  const lines = [header];
  for (const d of r.delivered) {
    const goal = d.goalId == null ? '' : (Object.hasOwn(r.byGoal ?? {}, d.goalId) ? r.byGoal[d.goalId].title : OBJETIVO_REMOVIDO);
    lines.push([
      d.title,
      d.area ?? SEM_AREA,
      goal,
      new Date(d.deliveredAt).toISOString().slice(0, 10),
      d.days == null ? '' : csvNum(d.days, 1),
      csvNum(d.costUsd, 2),
      d.valueBrl == null ? '' : csvNum(d.valueBrl, 2),
    ]);
  }
  // BOM so spreadsheet apps detect UTF-8 (accents in Portuguese).
  return '\uFEFF' + lines.map((l) => l.map(csvField).join(';')).join('\r\n') + '\r\n';
}

// ---- internals ----

function summarize(store, from, to) {
  const { contracts = [], events = [], goals = [] } = store.state;
  const list = contracts
    .filter((c) => c.state === 'accepted' && inPeriod(c.acceptedAt, from, to))
    .sort((a, b) => ms(b.acceptedAt) - ms(a.acceptedAt));

  const delivered = list.map((c) => ({
    id: c.id,
    title: c.title,
    area: c.area ?? null,
    goalId: c.goalId ?? null,
    deliveredAt: c.acceptedAt,
    days: daysBetween(c),
    costUsd: c.usage?.costUsd ?? 0,
    valueBrl: c.valueBrl ?? null,
  }));

  const avgDays = list.length
    ? round1(list.reduce((s, c) => s + (ms(c.acceptedAt) - ms(c.createdAt)) / DAY, 0) / list.length)
    : null;
  const values = delivered.map((d) => d.valueBrl).filter((v) => v != null);

  const totals = {
    delivered: delivered.length,
    costUsd: round2(sum(delivered.map((d) => d.costUsd))),
    valueBrl: values.length ? round2(sum(values)) : null,
    avgDays,
    rejected: events.filter((e) => e.type === 'reject' && inPeriod(e.at, from, to)).length,
    changes: events.filter((e) => e.type === 'change' && inPeriod(e.at, from, to)).length,
    incidents: contracts.filter((c) => c.kind === 'incident' && inPeriod(c.createdAt, from, to)).length,
  };

  const byArea = new Map();
  const byGoal = new Map();
  for (const d of delivered) {
    bump(byArea, d.area ?? SEM_AREA, d.costUsd);
    if (d.goalId != null && !byGoal.has(d.goalId)) {
      const g = goals.find((x) => x.id === d.goalId);
      byGoal.set(d.goalId, { title: g?.title ?? OBJETIVO_REMOVIDO, delivered: 0, costUsd: 0 });
    }
    if (d.goalId != null) bump(byGoal, d.goalId, d.costUsd);
  }

  return {
    delivered,
    totals,
    byArea: finish(byArea),
    byGoal: finish(byGoal, true),
  };
}

// Uses a Map and Object.fromEntries so keys such as "__proto__" stay plain data.
function bump(map, key, cost) {
  const e = map.get(key) ?? { delivered: 0, costUsd: 0 };
  e.delivered += 1;
  e.costUsd += cost;
  map.set(key, e);
}

function finish(map, keepTitle = false) {
  return Object.fromEntries([...map].map(([k, v]) => {
    const row = keepTitle ? { title: v.title, delivered: v.delivered, costUsd: round2(v.costUsd) } : { delivered: v.delivered, costUsd: round2(v.costUsd) };
    return [k, row];
  }));
}

// Two to four sentences, always. Count first, then the other facts that apply.
function highlights(t, prev) {
  const out = [];
  if (t.delivered === 0) out.push('Nenhum pedido entregue no período.');
  else out.push(`Entregamos ${t.delivered} ${t.delivered === 1 ? 'pedido' : 'pedidos'}, ${comparison(t.delivered, prev.delivered)}.`);
  if (t.avgDays != null) out.push(`O tempo médio de entrega foi de ${fmt(t.avgDays, 1)} ${t.avgDays === 1 ? 'dia' : 'dias'}.`);
  if (t.valueBrl != null) out.push(`Valor estimado entregue: R$ ${fmt(t.valueBrl, 2)}.`);
  if (t.incidents > 0) out.push(`Houve ${t.incidents} ${t.incidents === 1 ? 'incidente' : 'incidentes'} no período.`);
  if (out.length < 2 && t.rejected > 0) out.push(`Houve ${t.rejected} ${t.rejected === 1 ? 'pedido recusado' : 'pedidos recusados'} no período.`);
  if (out.length < 2 && t.changes > 0) out.push(`Houve ${t.changes} ${t.changes === 1 ? 'mudança de escopo' : 'mudanças de escopo'} no período.`);
  if (out.length < 2) out.push(`No período anterior foram entregues ${prev.delivered} ${prev.delivered === 1 ? 'pedido' : 'pedidos'}.`);
  return out;
}

function comparison(cur, prev) {
  const diff = cur - prev;
  if (diff > 0) return `${diff} a mais que no período anterior`;
  if (diff < 0) return `${-diff} a menos que no período anterior`;
  return 'o mesmo número que no período anterior';
}

// pt-BR display: 12.500,00
function fmt(n, d) {
  const [int, frac] = Math.abs(n).toFixed(d).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (n < 0 ? '-' : '') + grouped + (frac !== undefined ? `,${frac}` : '');
}

// CSV numbers: decimal comma, no thousands separator, so spreadsheets read them as numbers.
function csvNum(n, d) {
  return n.toFixed(d).replace('.', ',');
}

function csvField(v) {
  const s = String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toDate(v, name) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) throw httpError(400, `${name} inválido`);
  return d;
}

function inPeriod(iso, from, to) {
  if (iso == null) return false;
  const t = ms(iso);
  return t >= from.getTime() && t < to.getTime();
}

function ms(v) {
  return new Date(v).getTime();
}

function daysBetween(c) {
  if (c.createdAt == null || c.acceptedAt == null) return null;
  return round1((ms(c.acceptedAt) - ms(c.createdAt)) / DAY);
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
