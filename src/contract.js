// Core domain: client agent and dev agent negotiate a contract per intent.
// Each role may only perform the transitions it owns. Humans are the exception
// path (escalation), not the bridge.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const ROLES = ['client', 'dev', 'human'];
export const STATES = ['negotiating', 'agreed', 'building', 'delivered', 'accepted', 'rejected', 'escalated'];
export const MAX_ROUNDS = 5;

// action -> roles allowed and states it can run from
const RULES = {
  propose:  { roles: ['client', 'dev'], from: ['negotiating'] },
  agree:    { roles: ['client', 'dev'], from: ['negotiating'] },
  start:    { roles: ['dev'],           from: ['agreed'] },
  deliver:  { roles: ['dev'],           from: ['building'] },
  accept:   { roles: ['client'],        from: ['delivered'] },
  reject:   { roles: ['client'],        from: ['delivered'] },
  escalate: { roles: ['client', 'dev'], from: ['negotiating', 'agreed', 'building', 'delivered'] },
  resolve:  { roles: ['human'],         from: ['escalated'] },
};

export class Contracts {
  constructor(file = null) {
    this.file = file;
    this.state = { contracts: [], events: [] };
    if (file && existsSync(file)) this.state = JSON.parse(readFileSync(file, 'utf8'));
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

  // Client agent opens an intent. It owns "what" and "why".
  createIntent({ title, goal = '', criteria = [], priority = 2, budgetHours = null, irreversible = false }, actor) {
    if (actor.role !== 'client') throw httpError(403, 'only client can create intents');
    if (!title) throw httpError(400, 'title is required');
    if (!criteria.length) throw httpError(400, 'at least one acceptance criterion is required');
    const c = {
      id: randomUUID().slice(0, 8), title, goal, priority: Number(priority), budgetHours, irreversible,
      state: 'negotiating', rounds: 0,
      proposal: { version: 1, by: 'client', criteria: normCriteria(criteria), estimateHours: null, plan: '' },
      agreedBy: [], delivery: null, escalation: null, createdAt: now(), updatedAt: now(),
    };
    this.state.contracts.push(c);
    this.log('intent', c, actor, { title });
    this.save();
    return c;
  }

  // Either side revises the proposal. Boundaries: client owns criteria,
  // dev owns estimate and plan.
  propose(id, { criteria, estimateHours, plan, message = '' }, actor) {
    const c = this.get(id);
    this.guard(c, 'propose', actor);
    const p = { ...c.proposal };
    if (actor.role === 'client') {
      if (estimateHours !== undefined || plan !== undefined) throw httpError(403, 'client cannot set estimate or plan');
      if (criteria) p.criteria = normCriteria(criteria);
    } else {
      if (criteria) throw httpError(403, 'dev cannot change acceptance criteria; send a message to contest them');
      if (estimateHours !== undefined) p.estimateHours = Number(estimateHours);
      if (plan !== undefined) p.plan = plan;
    }
    p.version += 1;
    p.by = actor.role;
    c.proposal = p;
    c.agreedBy = [];
    c.rounds += 1;
    this.log('proposal', c, actor, { version: p.version, message });
    if (c.budgetHours != null && p.estimateHours > c.budgetHours)
      return this.escalateInternal(c, `estimate ${p.estimateHours}h exceeds budget ${c.budgetHours}h`);
    if (c.rounds > MAX_ROUNDS)
      return this.escalateInternal(c, `no agreement after ${MAX_ROUNDS} rounds`);
    this.save();
    return c;
  }

  // Both roles must agree on the same proposal version.
  agree(id, { version }, actor) {
    const c = this.get(id);
    this.guard(c, 'agree', actor);
    if (version !== c.proposal.version) throw httpError(409, `stale version ${version}, current is ${c.proposal.version}`);
    if (c.proposal.estimateHours == null) throw httpError(409, 'dev must provide an estimate before agreement');
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
    c.state = 'building';
    c.assignee = actor.agent;
    this.log('start', c, actor);
    this.save();
    return c;
  }

  // Dev delivers with evidence for each criterion (e.g. test results, PR url).
  deliver(id, { results = {}, links = [] }, actor) {
    const c = this.get(id);
    this.guard(c, 'deliver', actor);
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
    const failing = c.proposal.criteria.filter((k) => c.delivery?.results?.[k.id] !== true).map((k) => k.id);
    if (failing.length) throw httpError(409, `criteria not passing: ${failing.join(', ')}`);
    if (c.irreversible) return this.escalateInternal(c, 'irreversible change requires human approval', 'accept');
    c.state = 'accepted';
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

  // Human decides: approve (continue/finish), or send back to negotiation.
  resolve(id, { decision, budgetHours }, actor) {
    const c = this.get(id);
    this.guard(c, 'resolve', actor);
    const { fromState, pending } = c.escalation;
    if (decision === 'approve') {
      if (pending === 'accept') c.state = 'accepted';
      else if (fromState === 'negotiating') { c.state = 'agreed'; c.agreedBy = ['client', 'dev']; }
      else c.state = fromState;
    } else if (decision === 'renegotiate') {
      c.state = 'negotiating';
      c.rounds = 0;
      c.agreedBy = [];
    } else if (decision === 'cancel') {
      c.state = 'rejected';
    } else throw httpError(400, 'decision must be approve, renegotiate or cancel');
    if (budgetHours !== undefined) c.budgetHours = budgetHours;
    this.log('resolve', c, actor, { decision });
    c.escalation = null;
    this.save();
    return c;
  }

  history(id) { return this.state.events.filter((e) => e.contractId === id); }

  // Replaces standup / review: derived from events.
  summary(hours = 24) {
    const since = Date.now() - hours * 3600e3;
    const recent = this.state.events.filter((e) => Date.parse(e.at) >= since);
    return {
      since: new Date(since).toISOString(),
      counts: Object.fromEntries(STATES.map((s) => [s, this.list({ state: s }).length])),
      needsHuman: this.list({ state: 'escalated' }).map((c) => ({ id: c.id, title: c.title, reason: c.escalation.reason })),
      accepted: [...new Set(recent.filter((e) => e.type === 'accept' || (e.type === 'resolve' && this.get(e.contractId).state === 'accepted')).map((e) => e.contractId))],
      activity: recent.length,
    };
  }
}

const now = () => new Date().toISOString();
const normCriteria = (list) => list.map((k, i) => (typeof k === 'string' ? { id: `c${i + 1}`, text: k } : k));
export function httpError(status, message) { return Object.assign(new Error(message), { status }); }
