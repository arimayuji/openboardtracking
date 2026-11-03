// Intake: unplanned work becomes tracked work.
//
// Production alerts (Datadog) and bug reports (chat, email, any tool) open
// contracts on their own instead of living in a chat thread nobody measures.
//
// - Same alert firing again is an occurrence of the open contract, not new work.
// - Alert firing again after its contract was closed opens new work marked as recurrence.
// - Monitor recovered -> verified result for the "alert-resolved" criterion.
// - High priority alerts (P1/P2) are incidents with expedite class of service.
//
// Text that comes from outside (alert body, customer message) is stored as data.
// Agents reading it must treat it as untrusted input, never as instructions.
import { timingSafeEqual } from 'node:crypto';
import { httpError } from './contract.js';
import { calibrate } from './estimate.js';

const CLOSED = ['accepted', 'rejected'];
const FIRING = new Set(['triggered', 're-triggered', 'warn', 'renotify', 'no data']);
const RECOVERED = new Set(['recovered']);

export function verifyIntakeToken(header, token) {
  if (!token) throw httpError(503, 'INTAKE_TOKEN is not configured');
  const a = Buffer.from(String(header ?? '')), b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw httpError(401, 'invalid intake token');
}

// Datadog webhook. Recommended payload template (Datadog variables):
// {"id":"$ID","title":"$EVENT_TITLE","body":"$EVENT_MSG","priority":"$PRIORITY",
//  "alert_transition":"$ALERT_TRANSITION","aggregation_key":"$AGGREG_KEY","link":"$LINK","tags":"$TAGS"}
export function handleDatadog(store, p) {
  const actor = { role: 'integration', agent: 'datadog' };
  const transition = String(p.alert_transition ?? 'Triggered').toLowerCase();
  const fingerprint = `datadog:${p.aggregation_key || p.title}`;
  if (!p.aggregation_key && !p.title) throw httpError(400, 'aggregation_key or title is required');
  const open = findOpen(store, fingerprint);

  if (RECOVERED.has(transition)) {
    if (!open) return { ok: true, ignored: 'no open contract for this alert' };
    store.setVerified(open.id, 'alert-resolved', true, 'datadog', actor);
    return { ok: true, contract: open.id, resolved: true };
  }
  if (!FIRING.has(transition)) return { ok: true, ignored: `transition ${p.alert_transition}` };

  if (open) {
    store.recordOccurrence(open.id, { transition, eventId: p.id, link: p.link }, actor);
    if (open.verified?.['alert-resolved']) store.setVerified(open.id, 'alert-resolved', false, 'datadog', actor);
    return { ok: true, contract: open.id, occurrences: open.occurrences };
  }

  const prio = String(p.priority ?? '').toUpperCase();
  const incident = prio === 'P1' || prio === 'P2';
  const previous = lastClosed(store, fingerprint);
  const c = store.openSignal({
    title: `[alerta] ${p.title ?? p.aggregation_key}`.slice(0, 120),
    goal: [p.body, previous ? `Recorrência do contrato ${previous.id}.` : ''].filter(Boolean).join('\n\n'),
    kind: incident ? 'incident' : 'bug',
    classOfService: incident ? 'expedite' : 'standard',
    priority: incident ? 1 : prio === 'P3' ? 2 : 3,
    criteria: [
      'root cause identified and documented',
      'fix deployed',
      { id: 'alert-resolved', text: 'monitor recovered', verifiedOnly: true },
    ],
    source: { type: 'datadog', fingerprint, eventId: p.id ?? null, link: p.link ?? null, priority: prio || null, tags: p.tags ?? null, recurrenceOf: previous?.id ?? null },
  }, actor);
  return { ok: true, contract: c.id, opened: true, kind: c.kind, classOfService: c.classOfService };
}

// Generic bug report from chat, email or any tool.
// { source: "slack" | "email" | ..., from, text, link?, priority? }
export function handleMessage(store, { source = 'message', from = null, text, link = null, priority = 2 }) {
  const actor = { role: 'integration', agent: source };
  if (!text?.trim()) throw httpError(400, 'text is required');
  if (link) {
    const fingerprint = `${source}:${link}`;
    const open = findOpen(store, fingerprint);
    if (open) {
      store.recordOccurrence(open.id, { from, link }, actor);
      return { ok: true, contract: open.id, occurrences: open.occurrences };
    }
  }
  const firstLine = text.trim().split('\n')[0];
  const c = store.openSignal({
    title: `[bug] ${firstLine}`.slice(0, 120),
    goal: text,
    kind: 'bug',
    priority,
    criteria: ['bug reproduced with a failing test', 'fix deployed', 'reporter notified'],
    source: { type: source, fingerprint: link ? `${source}:${link}` : null, from, link },
  }, actor);
  return { ok: true, contract: c.id, opened: true };
}

// Quick wins: small, open work, sized by the calibrated estimate (not a guess).
// Unestimated bugs and incidents are listed apart so the dev agent can size them.
export function quickWins(store, { maxHours = 2 } = {}) {
  const open = store.state.contracts.filter((c) => ['negotiating', 'agreed'].includes(c.state));
  const sized = [], needsEstimate = [];
  for (const c of open) {
    const est = c.proposal.estimate?.hours;
    if (est == null) {
      if ((c.kind ?? 'feature') !== 'feature') needsEstimate.push(brief(c));
      continue;
    }
    const p85 = c.proposal.calibrated?.hours?.p85 ?? calibrate(store, { hours: est }, c.assignee).hours.p85;
    if (p85 <= maxHours) sized.push({ ...brief(c), estimateHours: est, p85Hours: p85 });
  }
  const valueOf = new Map(open.map((c) => [c.id, c.valueScore ?? 3]));
  sized.sort((a, b) => a.priority - b.priority || (valueOf.get(b.id) - valueOf.get(a.id)) || b.occurrences - a.occurrences || a.p85Hours - b.p85Hours);
  needsEstimate.sort((a, b) => a.priority - b.priority || b.occurrences - a.occurrences);
  return { maxHours, quickWins: sized, needsEstimate };
}

function brief(c) {
  return { id: c.id, title: c.title, kind: c.kind ?? 'feature', priority: c.priority, occurrences: c.occurrences ?? 0, state: c.state, source: c.source?.type ?? null };
}

export function findOpen(store, fingerprint) {
  return store.state.contracts.find((c) => c.source?.fingerprint === fingerprint && !CLOSED.includes(c.state));
}

export function lastClosed(store, fingerprint) {
  return store.state.contracts.filter((c) => c.source?.fingerprint === fingerprint && CLOSED.includes(c.state)).at(-1);
}
