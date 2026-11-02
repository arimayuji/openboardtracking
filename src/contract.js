// Core domain: client agent and dev agent negotiate a contract per intent.
// Each role may only perform the transitions it owns. Humans are the exception
// path (escalation), not the bridge.
//
// Capacity is measured in what AI work actually consumes: hours, tokens and money.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { calibrate } from './estimate.js';

export const ROLES = ['client', 'dev', 'human'];
export const STATES = ['negotiating', 'agreed', 'building', 'delivered', 'accepted', 'rejected', 'escalated'];
export const METRICS = ['hours', 'tokens', 'costUsd'];
export const MAX_ROUNDS = 5;

// Organization-wide settings, owned by humans.
// wip: limits on work in progress. For agents the scarce resources are
//   parallel execution and human attention, so escalations also count.
// dod: Definition of Done applied to every contract on top of the client's
//   criteria. Snapshotted per contract when it is created.
export const DEFAULT_CONFIG = {
  wip: { building: 5, perAgent: 2, escalated: 3 },
  dod: [
    { id: 'dod-tests', text: 'automated tests pass' },
    { id: 'dod-security', text: 'no known vulnerabilities introduced' },
  ],
};

// action -> roles allowed and states it can run from
const RULES = {
  propose:  { roles: ['client', 'dev'], from: ['negotiating'] },
  agree:    { roles: ['client', 'dev'], from: ['negotiating'] },
  start:    { roles: ['dev'],           from: ['agreed'] },
  usage:    { roles: ['dev'],           from: ['building'] },
  deliver:  { roles: ['dev'],           from: ['building'] },
  accept:   { roles: ['client'],        from: ['delivered'] },
  reject:   { roles: ['client'],        from: ['delivered'] },
  escalate: { roles: ['client', 'dev'], from: ['negotiating', 'agreed', 'building', 'delivered'] },
  resolve:  { roles: ['human'],         from: ['escalated'] },
};

export class Contracts {
  constructor(file = null, config = {}) {
    this.file = file;
    this.state = { contracts: [], events: [], config: { ...structuredClone(DEFAULT_CONFIG), ...config } };
    if (file && existsSync(file)) this.state = JSON.parse(readFileSync(file, 'utf8'));
    this.state.config ??= structuredClone(DEFAULT_CONFIG);
  }

  get config() { return this.state.config; }

  // Only humans change organization rules.
  updateConfig({ wip, dod }, actor) {
    if (actor.role !== 'human') throw httpError(403, 'only human can change wip limits or definition of done');
    if (wip) this.config.wip = { ...this.config.wip, ...wip };
    if (dod) {
      if (!Array.isArray(dod)) throw httpError(400, 'dod must be a list');
      this.config.dod = dod.map((d, i) => (typeof d === 'string' ? { id: `dod-${i + 1}`, text: d } : d));
    }
    this.state.events.push({ id: randomUUID(), type: 'config', contractId: null, role: actor.role, agent: actor.agent, data: { wip, dod }, at: now() });
    this.save();
    return this.config;
  }

  save() { if (this.file) writeFileSync(this.file, JSON.stringify(this.state, null, 2)); }

  log(type, c, actor, data = {}) {
    this.state.events.push({ id: randomUUID(), type, contractId: c.id, role: actor.role, agent: actor.agent, data, at: now() });
    c.updatedAt = now();
  }

  get(id) {
    const c = this.state.contracts.find((c) => c.id === id);
    if (!c) throw httpError(404, `contract ${id} not found`);
    return c;
  }

  list(filter = {}) {
    return this.state.contracts.filter((c) => Object.entries(filter).every(([k, v]) => v === undefined || c[k] === v));
  }

  guard(c, action, actor) {
    const rule = RULES[action];
    if (!ROLES.includes(actor.role)) throw httpError(401, `unknown role ${actor.role}`);
    if (!rule.roles.includes(actor.role)) throw httpError(403, `role ${actor.role} cannot ${action}`);
    if (!rule.from.includes(c.state)) throw httpError(409, `cannot ${action} from state ${c.state}`);
  }

  // Client agent opens an intent. It owns "what", "why" and "how much it is worth".
  // budget: any subset of { hours, tokens, costUsd }.
  createIntent({ title, goal = '', criteria = [], priority = 2, budget = {}, irreversible = false }, actor) {
    if (actor.role !== 'client') throw httpError(403, 'only client can create intents');
    if (!title) throw httpError(400, 'title is required');
    if (!criteria.length) throw httpError(400, 'at least one acceptance criterion is required');
    const c = {
      id: randomUUID().slice(0, 8), title, goal, priority: Number(priority), budget: pickMetrics(budget), irreversible,
      state: 'negotiating', rounds: 0,
      dod: structuredClone(this.config.dod),
      proposal: { version: 1, by: 'client', criteria: normCriteria(criteria), estimate: {}, calibrated: null, plan: '' },
      usage: emptyUsage(), agreedBy: [], delivery: null, escalation: null, createdAt: now(), updatedAt: now(),
    };
    this.state.contracts.push(c);
    this.log('intent', c, actor, { title });
    this.save();
    return c;
  }

  // Either side revises the proposal. Boundaries: client owns criteria,
  // dev owns estimate (hours/tokens/cost) and plan.
  propose(id, { criteria, estimate, plan, message = '' }, actor) {
    const c = this.get(id);
    this.guard(c, 'propose', actor);
    const p = { ...c.proposal };
    if (actor.role === 'client') {
      if (estimate !== undefined || plan !== undefined) throw httpError(403, 'client cannot set estimate or plan');
      if (criteria) p.criteria = normCriteria(criteria);
    } else {
      if (criteria) throw httpError(403, 'dev cannot change acceptance criteria; send a message to contest them');
      if (estimate !== undefined) {
        p.estimate = pickMetrics(estimate);
        p.calibrated = calibrate(this, p.estimate, actor.agent);
      }
      if (plan !== undefined) p.plan = plan;
    }
    p.version += 1;
    p.by = actor.role;
    c.proposal = p;
    c.agreedBy = [];
    c.rounds += 1;
    this.log('proposal', c, actor, { version: p.version, message });
    // Budget is checked against the calibrated P85, not the raw guess.
    const over = overBudget(c.budget, p.calibrated, (m) => p.calibrated[m].p85);
    if (over) return this.escalateInternal(c, `P85 ${over.metric} ${over.value} (raw ${p.estimate[over.metric]}) exceeds budget ${over.limit}`);
    if (c.rounds > MAX_ROUNDS) return this.escalateInternal(c, `no agreement after ${MAX_ROUNDS} rounds`);
    this.save();
    return c;
  }

  // Both roles must agree on the same proposal version.
  agree(id, { version }, actor) {
    const c = this.get(id);
    this.guard(c, 'agree', actor);
    if (version !== c.proposal.version) throw httpError(409, `stale version ${version}, current is ${c.proposal.version}`);
    if (!Object.keys(c.proposal.estimate).length) throw httpError(409, 'dev must provide an estimate before agreement');
    if (!c.agreedBy.includes(actor.role)) c.agreedBy.push(actor.role);
    this.log('agree', c, actor, { version });
    if (c.agreedBy.includes('client') && c.agreedBy.includes('dev')) {
      c.state = 'agreed';
      this.log('agreed', c, actor, { version });
    }
    this.save();
    return c;
  }

  start(id, actor) {
    const c = this.get(id);
    this.guard(c, 'start', actor);
    this.checkWip(actor.agent);
    c.state = 'building';
    c.assignee = actor.agent;
    c.startedAt = now();
    this.log('start', c, actor);
    this.save();
    return c;
  }

  // Pulling new work is blocked while the system is saturated:
  // too much in execution, too much on one agent, or humans with a backlog of escalations.
  checkWip(agent) {
    const { building, perAgent, escalated } = this.config.wip;
    const inBuild = this.list({ state: 'building' });
    if (building != null && inBuild.length >= building) throw httpError(409, `WIP limit: ${building} contracts already building`);
    if (perAgent != null && inBuild.filter((c) => c.assignee === agent).length >= perAgent)
      throw httpError(409, `WIP limit: agent ${agent} already has ${perAgent} contracts building`);
    const esc = this.list({ state: 'escalated' }).length;
    if (escalated != null && esc >= escalated)
      throw httpError(409, `WIP limit: ${esc} escalations waiting for humans; resolve them before starting new work`);
  }

  // Dev agent reports consumption while it works (increments).
  // { hours, tokensIn, tokensOut, costUsd, model, toolCalls }
  // Burning past the budget escalates immediately instead of at the end.
  reportUsage(id, report, actor) {
    const c = this.get(id);
    this.guard(c, 'usage', actor);
    addUsage(c.usage, report);
    this.log('usage', c, actor, report);
    const over = overBudget(c.budget, c.usage, (m) => c.usage[m]);
    if (over) return this.escalateInternal(c, `spent ${over.metric} ${round(over.value)} exceeds budget ${over.limit}`, null, actor);
    this.save();
    return c;
  }

  // Dev delivers with evidence for each criterion and optional final usage increment.
  deliver(id, { results = {}, links = [], usage }, actor) {
    const c = this.get(id);
    this.guard(c, 'deliver', actor);
    if (usage) { addUsage(c.usage, usage); this.log('usage', c, actor, usage); }
    // No hours reported at all: fall back to wall-clock since start.
    if (!c.usage.hours) c.usage.hours = round((Date.now() - Date.parse(c.startedAt ?? c.updatedAt)) / 3600e3);
    c.delivery = { results, links, at: now() };
    c.state = 'delivered';
    this.log('deliver', c, actor, { links });
    this.save();
    return c;
  }

  // Acceptance is mechanical: every criterion must have passed.
  accept(id, actor) {
    const c = this.get(id);
    this.guard(c, 'accept', actor);
    // Client criteria and the organization's Definition of Done must all pass.
    const checks = [...c.proposal.criteria, ...(c.dod ?? [])];
    const failing = checks.filter((k) => c.delivery?.results?.[k.id] !== true).map((k) => k.id);
    if (failing.length) throw httpError(409, `criteria not passing: ${failing.join(', ')}`);
    if (c.irreversible) return this.escalateInternal(c, 'irreversible change requires human approval', 'accept');
    c.state = 'accepted';
    c.acceptedAt = now();
    this.log('accept', c, actor);
    this.save();
    return c;
  }

  reject(id, { reason = '' }, actor) {
    const c = this.get(id);
    this.guard(c, 'reject', actor);
    c.state = 'building';
    this.log('reject', c, actor, { reason });
    this.save();
    return c;
  }

  escalate(id, { reason = '' }, actor) {
    const c = this.get(id);
    this.guard(c, 'escalate', actor);
    return this.escalateInternal(c, reason || `escalated by ${actor.role}`, null, actor);
  }

  escalateInternal(c, reason, pending = null, actor = { role: 'system', agent: 'system' }) {
    c.escalation = { reason, fromState: c.state, pending, at: now() };
    c.state = 'escalated';
    this.log('escalated', c, actor, { reason });
    this.save();
    return c;
  }

  // Human decides: approve (continue/finish), renegotiate, or cancel.
  // May raise the budget at the same time.
  resolve(id, { decision, budget }, actor) {
    const c = this.get(id);
    this.guard(c, 'resolve', actor);
    const { fromState, pending } = c.escalation;
    if (decision === 'approve') {
      if (pending === 'accept') { c.state = 'accepted'; c.acceptedAt = now(); }
      else if (fromState === 'negotiating') { c.state = 'agreed'; c.agreedBy = ['client', 'dev']; }
      else c.state = fromState;
    } else if (decision === 'renegotiate') {
      c.state = 'negotiating';
      c.rounds = 0;
      c.agreedBy = [];
    } else if (decision === 'cancel') {
      c.state = 'rejected';
    } else throw httpError(400, 'decision must be approve, renegotiate or cancel');
    if (budget) c.budget = { ...c.budget, ...pickMetrics(budget) };
    this.log('resolve', c, actor, { decision, budget });
    c.escalation = null;
    this.save();
    return c;
  }

  history(id) { return this.state.events.filter((e) => e.contractId === id); }

  // Replaces status meetings: derived from events.
  summary(hours = 24) {
    const since = Date.now() - hours * 3600e3;
    const recent = this.state.events.filter((e) => Date.parse(e.at) >= since);
    const spend = emptyUsage();
    for (const e of recent) if (e.type === 'usage') addUsage(spend, e.data);
    const accepted = this.list({ state: 'accepted' });
    const totalCost = accepted.reduce((s, c) => s + c.usage.costUsd, 0);
    return {
      since: new Date(since).toISOString(),
      counts: Object.fromEntries(STATES.map((s) => [s, this.list({ state: s }).length])),
      needsHuman: this.list({ state: 'escalated' }).map((c) => ({ id: c.id, title: c.title, reason: c.escalation.reason })),
      acceptedRecently: [...new Set(recent.filter((e) => e.type === 'accept' || (e.type === 'resolve' && this.get(e.contractId).state === 'accepted')).map((e) => e.contractId))],
      spendInWindow: spend,
      // The AI-native "velocity": what one accepted outcome costs.
      costPerAcceptedUsd: accepted.length ? round(totalCost / accepted.length) : null,
    };
  }
}

function emptyUsage() {
  return { hours: 0, tokens: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, toolCalls: 0, byModel: {} };
}

function addUsage(u, r = {}) {
  const tin = num(r.tokensIn), tout = num(r.tokensOut);
  const tokens = num(r.tokens) || tin + tout;
  u.hours = round(u.hours + num(r.hours));
  u.tokensIn += tin;
  u.tokensOut += tout;
  u.tokens += tokens;
  u.costUsd = round(u.costUsd + num(r.costUsd), 4);
  u.toolCalls += num(r.toolCalls);
  if (r.model) {
    const m = (u.byModel[r.model] ??= { tokens: 0, costUsd: 0 });
    m.tokens += tokens;
    m.costUsd = round(m.costUsd + num(r.costUsd), 4);
  }
}

// First metric where value(metric) is above the budget limit, if any.
function overBudget(budget, source, value) {
  if (!source) return null;
  for (const metric of METRICS) {
    if (budget[metric] == null || source[metric] == null) continue;
    const v = value(metric);
    if (v > budget[metric]) return { metric, value: v, limit: budget[metric] };
  }
  return null;
}

export function pickMetrics(o = {}) {
  return Object.fromEntries(METRICS.filter((m) => o[m] != null).map((m) => [m, Number(o[m])]));
}

const num = (v) => Number(v) || 0;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const now = () => new Date().toISOString();
const normCriteria = (list) => list.map((k, i) => (typeof k === 'string' ? { id: `c${i + 1}`, text: k } : k));
export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
