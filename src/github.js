// GitHub integration (inbound webhooks).
//
// Linking: a PR belongs to a contract when its branch, title or body contains
// `obt-<contract id>` (also accepts `obt/<id>` and `obt:<id>`), e.g. branch `obt-1a2b3c4d-login`.
//
// What it does:
// - pull_request opened/edited/synchronize/reopened -> PR link stored as evidence
// - check_suite completed  -> verified result for config.github.suiteCheck (default dod-tests)
// - check_run completed    -> verified result for checks mapped in config.github.checks { "<check name>": "<check id>" }
// - pull_request closed + merged -> contract delivered with the verified results
//
// CI results become "verified": they override what the dev agent claims.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from './contract.js';

const ACTOR = { role: 'integration', agent: 'github' };
const ID_RE = /obt[-/:]([0-9a-f]{8})/i;
const PASS = new Set(['success']);
const FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

export function verifySignature(raw, header, secret) {
  if (!secret) throw httpError(503, 'GITHUB_WEBHOOK_SECRET is not configured');
  if (!header?.startsWith('sha256=')) throw httpError(401, 'missing signature');
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw httpError(401, 'invalid signature');
}

export function handleGithub(store, event, payload) {
  if (event === 'ping') return { ok: true, pong: true };
  if (event === 'pull_request') return onPullRequest(store, payload);
  if (event === 'check_suite' && payload.action === 'completed') return onCheckSuite(store, payload);
  if (event === 'check_run' && payload.action === 'completed') return onCheckRun(store, payload);
  return { ok: true, ignored: event };
}

function onPullRequest(store, { action, pull_request: pr, repository }) {
  const id = contractIdFrom(pr.head?.ref, pr.title, pr.body);
  const c = id && find(store, id);
  if (!c) return { ok: true, ignored: 'no linked contract' };
  const link = { type: 'pr', url: pr.html_url, repo: repository?.full_name, number: pr.number, branch: pr.head?.ref, headSha: pr.head?.sha };
  store.attachLink(c.id, link, ACTOR);
  if (action === 'closed' && pr.merged) {
    store.autoDeliver(c.id, { links: c.links.map((l) => l.url) }, ACTOR);
    return { ok: true, contract: c.id, delivered: c.state === 'delivered' };
  }
  return { ok: true, contract: c.id, linked: pr.html_url };
}

function onCheckSuite(store, { check_suite: suite, repository }) {
  const target = store.config.github.suiteCheck;
  if (!target) return { ok: true, ignored: 'suite mapping disabled' };
  return applyResult(store, suite.head_sha, suite.head_branch, suite.pull_requests, repository?.full_name, target, suite.conclusion, 'check_suite');
}

function onCheckRun(store, { check_run: run, repository }) {
  const target = store.config.github.checks?.[run.name];
  if (!target) return { ok: true, ignored: `check ${run.name} not mapped` };
  return applyResult(store, run.head_sha, run.check_suite?.head_branch, run.pull_requests, repository?.full_name, target, run.conclusion, `check_run:${run.name}`);
}

function applyResult(store, sha, branch, prs = [], repo, checkId, conclusion, source) {
  const ok = PASS.has(conclusion) ? true : FAIL.has(conclusion) ? false : null;
  if (ok === null) return { ok: true, ignored: `conclusion ${conclusion}` };
  const contracts = linkedContracts(store, sha, branch, prs, repo);
  for (const c of contracts) store.setVerified(c.id, checkId, ok, source, ACTOR);
  return { ok: true, contracts: contracts.map((c) => c.id), check: checkId, result: ok };
}

// By head sha of a linked PR, by branch name, or by the PR number.
function linkedContracts(store, sha, branch, prs = [], repo) {
  const numbers = new Set(prs.map((p) => p.number));
  const byLink = store.state.contracts.filter((c) => (c.links ?? []).some((l) => l.type === 'pr' && (l.headSha === sha || (numbers.has(l.number) && (!repo || l.repo === repo)))));
  const fromBranch = contractIdFrom(branch);
  const extra = fromBranch ? [find(store, fromBranch)].filter(Boolean) : [];
  return [...new Set([...byLink, ...extra])];
}

export function contractIdFrom(...texts) {
  for (const t of texts) {
    const m = t && ID_RE.exec(t);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

const find = (store, id) => store.state.contracts.find((c) => c.id === id);
