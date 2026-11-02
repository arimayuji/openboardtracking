// Flow metrics (Kanban): how work actually moves, from the event log.
// - cycle time: start -> accepted
// - lead time: intent created -> accepted
// - throughput: accepted per day
// - WIP aging: how long each open contract has been in its current state;
//   flagged as stale when it passes the P85 cycle time (or a fallback).

const DAY = 864e5;
const HOUR = 3600e3;
const STALE_FALLBACK_HOURS = 24;

export function flow(store, { days = 7, nowMs = Date.now() } = {}) {
  const accepted = store.state.contracts.filter((c) => c.state === 'accepted' && c.acceptedAt);
  const cycle = accepted.filter((c) => c.startedAt).map((c) => (Date.parse(c.acceptedAt) - Date.parse(c.startedAt)) / HOUR);
  const lead = accepted.map((c) => (Date.parse(c.acceptedAt) - Date.parse(c.createdAt)) / HOUR);

  const since = nowMs - days * DAY;
  const recent = accepted.filter((c) => Date.parse(c.acceptedAt) >= since).length;

  const cycleP85 = cycle.length ? pct(cycle, 85) : null;
  const staleAfter = cycleP85 ?? STALE_FALLBACK_HOURS;
  const open = store.state.contracts.filter((c) => !['accepted', 'rejected'].includes(c.state));
  const aging = open.map((c) => {
    const enteredAt = lastStateChange(store, c);
    const ageHours = round((nowMs - Date.parse(enteredAt)) / HOUR);
    return { id: c.id, title: c.title, state: c.state, assignee: c.assignee ?? null, ageHours, stale: ageHours > staleAfter };
  }).sort((a, b) => b.ageHours - a.ageHours);

  return {
    cycleTimeHours: dist(cycle),
    leadTimeHours: dist(lead),
    throughput: { days, accepted: recent, perDay: round(recent / days) },
    wip: Object.fromEntries(['negotiating', 'agreed', 'building', 'delivered', 'escalated'].map((s) => [s, open.filter((c) => c.state === s).length])),
    limits: store.config.wip,
    staleAfterHours: round(staleAfter),
    aging,
    stale: aging.filter((a) => a.stale).map((a) => a.id),
  };
}

// Time the contract entered its current state, from the event log.
const STATE_EVENTS = new Set(['intent', 'agreed', 'start', 'deliver', 'reject', 'escalated', 'resolve', 'accept']);
function lastStateChange(store, c) {
  const evs = store.state.events.filter((e) => e.contractId === c.id && STATE_EVENTS.has(e.type));
  return evs.length ? evs[evs.length - 1].at : c.createdAt;
}

function dist(a) {
  return a.length ? { samples: a.length, p50: round(pct(a, 50)), p85: round(pct(a, 85)), p95: round(pct(a, 95)) } : { samples: 0 };
}
function pct(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  const i = (q / 100) * (s.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const round = (n) => Math.round(n * 100) / 100;
