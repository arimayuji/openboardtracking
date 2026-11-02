// Estimation from history instead of guesses.
// - calibration: how far each dev agent's estimates drift from reality (actual / estimate)
// - calibrate(): turns a raw estimate into P50/P85/P95 using that agent's history
// - forecast(): Monte Carlo over all open contracts -> project-level range
//
// With few samples we fall back to a conservative default distribution, and say so.

const DEFAULT_RATIOS = [0.8, 1, 1.2, 1.5, 2, 3]; // typical overrun spread when we know nothing
export const MIN_SAMPLES = 5;

// Completed contracts with both an estimate and an actual.
export function samples(store, agent) {
  return store.state.contracts
    .filter((c) => c.delivery?.actualHours != null && c.proposal.estimateHours > 0)
    .filter((c) => !agent || c.assignee === agent)
    .map((c) => c.delivery.actualHours / c.proposal.estimateHours);
}

function ratiosFor(store, agent) {
  const own = samples(store, agent);
  if (own.length >= MIN_SAMPLES) return { ratios: own, source: 'agent' };
  const all = samples(store);
  if (all.length >= MIN_SAMPLES) return { ratios: all, source: 'team' };
  return { ratios: DEFAULT_RATIOS, source: 'default' };
}

export function calibration(store) {
  const agents = [...new Set(store.state.contracts.map((c) => c.assignee).filter(Boolean))];
  return Object.fromEntries(agents.map((a) => {
    const r = samples(store, a);
    return [a, { samples: r.length, medianRatio: r.length ? round(pct(r, 50)) : null }];
  }));
}

export function calibrate(store, estimateHours, agent) {
  const { ratios, source } = ratiosFor(store, agent);
  const dist = ratios.map((r) => r * estimateHours);
  return { raw: estimateHours, p50: round(pct(dist, 50)), p85: round(pct(dist, 85)), p95: round(pct(dist, 95)), source, samples: ratios === DEFAULT_RATIOS ? 0 : ratios.length };
}

const OPEN = ['negotiating', 'agreed', 'building', 'delivered', 'escalated'];

// Project forecast: simulate total remaining effort, then convert to calendar
// time using the number of agents working in parallel.
export function forecast(store, { runs = 5000, parallel = 1, rng = Math.random } = {}) {
  const open = store.state.contracts.filter((c) => OPEN.includes(c.state));
  const unestimated = open.filter((c) => c.proposal.estimateHours == null).map((c) => c.id);
  const items = open.filter((c) => c.proposal.estimateHours != null).map((c) => ({
    est: c.proposal.estimateHours,
    ratios: ratiosFor(store, c.assignee).ratios,
    // remaining fraction: delivered work is basically done
    remaining: c.state === 'delivered' ? 0.1 : 1,
  }));
  const totals = [];
  for (let i = 0; i < runs; i++) {
    let t = 0;
    for (const it of items) t += it.est * it.remaining * it.ratios[Math.floor(rng() * it.ratios.length)];
    totals.push(t);
  }
  const p = (q) => (totals.length ? round(pct(totals, q)) : 0);
  const effort = { p50: p(50), p85: p(85), p95: p(95) };
  const k = Math.max(1, parallel);
  return {
    openContracts: open.length,
    estimated: items.length,
    unestimated, // not in the numbers: forecast is a lower bound while this is non-empty
    effortHours: effort,
    calendarHours: { p50: round(effort.p50 / k), p85: round(effort.p85 / k), p95: round(effort.p95 / k) },
    parallel: k,
    note: unestimated.length ? 'lower bound: some open contracts have no estimate yet' : undefined,
  };
}

function pct(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (q / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const round = (n) => Math.round(n * 10) / 10;
