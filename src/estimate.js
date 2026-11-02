// Estimation from history instead of guesses, for every resource AI work consumes:
// hours, tokens and money.
// - calibration: how far each dev agent's estimates drift from reality (actual / estimate)
// - calibrate(): turns a raw estimate into P50/P85/P95 per metric using that agent's history
// - forecast(): Monte Carlo over all open contracts -> project-level range per metric
//
// With few samples we fall back to the team, then to a conservative default, and say so.

export const METRICS = ['hours', 'tokens', 'costUsd'];
const DEFAULT_RATIOS = [0.8, 1, 1.2, 1.5, 2, 3]; // typical overrun spread when we know nothing
export const MIN_SAMPLES = 5;

// Ratios actual/estimate for one metric on delivered work.
export function samples(store, metric, agent) {
  return store.state.contracts
    .filter((c) => c.delivery && c.proposal.estimate?.[metric] > 0 && c.usage?.[metric] > 0)
    .filter((c) => !agent || c.assignee === agent)
    .map((c) => c.usage[metric] / c.proposal.estimate[metric]);
}

function ratiosFor(store, metric, agent) {
  const own = agent ? samples(store, metric, agent) : [];
  if (own.length >= MIN_SAMPLES) return { ratios: own, source: 'agent' };
  const all = samples(store, metric);
  if (all.length >= MIN_SAMPLES) return { ratios: all, source: 'team' };
  return { ratios: DEFAULT_RATIOS, source: 'default' };
}

export function calibration(store) {
  const agents = [...new Set(store.state.contracts.map((c) => c.assignee).filter(Boolean))];
  return Object.fromEntries(agents.map((a) => [a, Object.fromEntries(METRICS.map((m) => {
    const r = samples(store, m, a);
    return [m, { samples: r.length, medianRatio: r.length ? round(pct(r, 50)) : null }];
  }))]));
}

// estimate: { hours?, tokens?, costUsd? }
export function calibrate(store, estimate, agent) {
  const out = {};
  for (const m of METRICS) {
    if (estimate[m] == null) continue;
    const { ratios, source } = ratiosFor(store, m, agent);
    const dist = ratios.map((r) => r * estimate[m]);
    out[m] = { raw: estimate[m], p50: round(pct(dist, 50)), p85: round(pct(dist, 85)), p95: round(pct(dist, 95)), source, samples: source === 'default' ? 0 : ratios.length };
  }
  return out;
}

const OPEN = ['negotiating', 'agreed', 'building', 'delivered', 'escalated'];

// Project forecast per metric: what is left to consume across open contracts.
// Already-spent usage is subtracted; a contract never goes below zero remaining.
// Calendar hours divide effort by the number of agents working in parallel.
export function forecast(store, { runs = 5000, parallel = 1, rng = Math.random } = {}) {
  const open = store.state.contracts.filter((c) => OPEN.includes(c.state));
  const result = { openContracts: open.length, parallel: Math.max(1, parallel), metrics: {} };
  for (const m of METRICS) {
    const items = open.filter((c) => c.proposal.estimate?.[m] != null).map((c) => ({
      est: c.proposal.estimate[m],
      spent: c.usage?.[m] ?? 0,
      done: c.state === 'delivered',
      ratios: ratiosFor(store, m, c.assignee).ratios,
    }));
    if (!items.length) continue;
    const totals = [];
    for (let i = 0; i < runs; i++) {
      let t = 0;
      for (const it of items) if (!it.done) t += Math.max(0, it.est * it.ratios[Math.floor(rng() * it.ratios.length)] - it.spent);
      totals.push(t);
    }
    result.metrics[m] = {
      remaining: { p50: round(pct(totals, 50)), p85: round(pct(totals, 85)), p95: round(pct(totals, 95)) },
      spent: round(open.reduce((s, c) => s + (c.usage?.[m] ?? 0), 0)),
      unestimated: open.filter((c) => c.proposal.estimate?.[m] == null).map((c) => c.id),
    };
  }
  const h = result.metrics.hours?.remaining;
  if (h) result.calendarHours = { p50: round(h.p50 / result.parallel), p85: round(h.p85 / result.parallel), p95: round(h.p95 / result.parallel) };
  if (Object.values(result.metrics).some((x) => x.unestimated.length))
    result.note = 'lower bound: some open contracts have no estimate for some metrics';
  return result;
}

function pct(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (q / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const round = (n) => Math.round(n * 100) / 100;
