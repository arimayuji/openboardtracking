// Sentry integration (Integration Platform webhooks: "issue" and "event_alert" resources).
//
// - New issue -> bug (level "fatal" -> incident with expedite class of service)
// - Same issue seen again (alert fired) -> occurrence of the open contract
// - Issue resolved in Sentry -> verified result for the "sentry-resolved" criterion
// - Issue unresolved again (regression) -> occurrence + "sentry-resolved" back to false,
//   or new contract marked as recurrence when the previous one was already closed
//
// Every request is checked with the integration's client secret (SENTRY_CLIENT_SECRET).
// Issue titles and culprits come from application errors: stored as data, never instructions.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from './contract.js';
import { findOpen, lastClosed } from './intake.js';

const ACTOR = { role: 'integration', agent: 'sentry' };

export function verifySentrySignature(raw, header, secret) {
  if (!secret) throw httpError(503, 'SENTRY_CLIENT_SECRET is not configured');
  if (!header) throw httpError(401, 'missing sentry signature');
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(String(header));
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw httpError(401, 'invalid sentry signature');
}

export function handleSentry(store, resource, payload) {
  const { action, data = {} } = payload;
  if (resource === 'installation' || resource === 'installation.created') return { ok: true, ignored: 'installation' };
  if (resource === 'issue') return onIssue(store, action, data.issue);
  if (resource === 'event_alert') return onEventAlert(store, data.event);
  return { ok: true, ignored: `resource ${resource}` };
}

function onIssue(store, action, issue) {
  if (!issue?.id) throw httpError(400, 'issue.id is required');
  const fingerprint = `sentry:${issue.id}`;
  const open = findOpen(store, fingerprint);
  if (action === 'created') return open ? occur(store, open, issue) : openIssue(store, issue);
  if (action === 'resolved') {
    if (!open) return { ok: true, ignored: 'no open contract for this issue' };
    store.setVerified(open.id, 'sentry-resolved', true, 'sentry', ACTOR);
    return { ok: true, contract: open.id, resolved: true };
  }
  if (action === 'unresolved') {
    if (!open) return openIssue(store, issue);
    occur(store, open, issue);
    store.setVerified(open.id, 'sentry-resolved', false, 'sentry', ACTOR);
    return { ok: true, contract: open.id, regression: true };
  }
  return { ok: true, ignored: `issue action ${action}` };
}

function onEventAlert(store, event) {
  const issueId = event?.issue_id ?? event?.groupID;
  if (!issueId) throw httpError(400, 'event.issue_id is required');
  const issue = { id: String(issueId), title: event.title, culprit: event.culprit, level: event.level, web_url: event.web_url ?? event.issue_url, project: event.project };
  const open = findOpen(store, `sentry:${issue.id}`);
  return open ? occur(store, open, issue) : openIssue(store, issue);
}

function openIssue(store, issue) {
  const fingerprint = `sentry:${issue.id}`;
  const fatal = issue.level === 'fatal';
  const previous = lastClosed(store, fingerprint);
  const link = issue.web_url ?? issue.permalink ?? null;
  const c = store.openSignal({
    title: `[sentry] ${issue.title ?? issue.shortId ?? issue.id}`.slice(0, 120),
    goal: [issue.culprit ? `Origem: ${issue.culprit}` : '', link ?? '', previous ? `Recorrência do contrato ${previous.id}.` : ''].filter(Boolean).join('\n'),
    kind: fatal ? 'incident' : 'bug',
    classOfService: fatal ? 'expedite' : 'standard',
    priority: fatal ? 1 : issue.level === 'error' ? 2 : 3,
    criteria: [
      'bug reproduced with a failing test',
      'fix deployed',
      { id: 'sentry-resolved', text: 'issue resolved in Sentry', verifiedOnly: true },
    ],
    source: {
      type: 'sentry', fingerprint, link, issueId: String(issue.id), shortId: issue.shortId ?? null,
      project: issue.project?.slug ?? issue.project ?? null, level: issue.level ?? null,
      events: num(issue.count), users: num(issue.userCount), recurrenceOf: previous?.id ?? null,
    },
  }, ACTOR);
  return { ok: true, contract: c.id, opened: true, kind: c.kind };
}

function occur(store, c, issue) {
  store.recordOccurrence(c.id, { issueId: issue.id, level: issue.level }, ACTOR);
  if (issue.count != null) c.source.events = Math.max(c.source.events ?? 0, num(issue.count));
  if (issue.userCount != null) c.source.users = Math.max(c.source.users ?? 0, num(issue.userCount));
  store.save();
  return { ok: true, contract: c.id, occurrences: c.occurrences };
}

const num = (v) => (v == null ? null : Number(v) || 0);
