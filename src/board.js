// Core domain: a kanban board where humans and AI agents pull work.
// Every change is an event. "Rituals" (standup, review, metrics) are derived
// from the event log instead of meetings.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const COLUMNS = ['backlog', 'ready', 'doing', 'review', 'done'];
export const WIP_LIMITS = { doing: 3, review: 3 };

export class Board {
  constructor(file = null) {
    this.file = file;
    this.state = { tasks: [], events: [] };
    if (file && existsSync(file)) this.state = JSON.parse(readFileSync(file, 'utf8'));
  }

  save() {
    if (this.file) writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  log(type, taskId, actor, data = {}) {
    const ev = { id: randomUUID(), type, taskId, actor, data, at: new Date().toISOString() };
    this.state.events.push(ev);
    return ev;
  }

  get(id) {
    const t = this.state.tasks.find((t) => t.id === id);
    if (!t) throw httpError(404, `task ${id} not found`);
    return t;
  }

  list(filter = {}) {
    return this.state.tasks.filter((t) =>
      Object.entries(filter).every(([k, v]) => v === undefined || t[k] === v));
  }

  create({ title, description = '', priority = 2, acceptance = [], tags = [] }, actor = 'human') {
    if (!title) throw httpError(400, 'title is required');
    const t = {
      id: randomUUID().slice(0, 8), title, description, priority: Number(priority),
      acceptance, tags, column: 'backlog', assignee: null, notes: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.state.tasks.push(t);
    this.log('created', t.id, actor, { title });
    this.save();
    return t;
  }

  move(id, column, actor = 'human') {
    if (!COLUMNS.includes(column)) throw httpError(400, `invalid column ${column}`);
    const t = this.get(id);
    const limit = WIP_LIMITS[column];
    if (limit && t.column !== column && this.list({ column }).length >= limit)
      throw httpError(409, `WIP limit reached for ${column} (${limit})`);
    const from = t.column;
    t.column = column;
    t.updatedAt = new Date().toISOString();
    this.log('moved', id, actor, { from, to: column });
    this.save();
    return t;
  }

  // Agents ask for the next piece of work: highest priority (1 = top), oldest first.
  claimNext(agent) {
    const next = this.list({ column: 'ready' })
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    this.move(next.id, 'doing', agent);
    next.assignee = agent;
    this.log('claimed', next.id, agent);
    this.save();
    return next;
  }

  note(id, text, actor = 'human') {
    const t = this.get(id);
    t.notes.push({ actor, text, at: new Date().toISOString() });
    t.updatedAt = new Date().toISOString();
    this.log('note', id, actor, { text });
    this.save();
    return t;
  }

  // Replaces the daily standup.
  standup(hours = 24) {
    const since = Date.now() - hours * 3600e3;
    const recent = this.state.events.filter((e) => Date.parse(e.at) >= since);
    const byActor = {};
    for (const e of recent) (byActor[e.actor] ??= []).push(e);
    const blocked = this.state.tasks.filter((t) => t.tags.includes('blocked'));
    return {
      since: new Date(since).toISOString(),
      actors: Object.fromEntries(Object.entries(byActor).map(([a, evs]) => [a, {
        done: uniq(evs.filter((e) => e.type === 'moved' && e.data.to === 'done').map((e) => e.taskId)),
        started: uniq(evs.filter((e) => e.type === 'claimed' || (e.type === 'moved' && e.data.to === 'doing')).map((e) => e.taskId)),
        notes: evs.filter((e) => e.type === 'note').map((e) => ({ task: e.taskId, text: e.data.text })),
      }])),
      inProgress: this.list({ column: 'doing' }).map(brief),
      blocked: blocked.map(brief),
    };
  }

  // Replaces sprint review / velocity charts.
  metrics() {
    const cycle = [];
    for (const t of this.list({ column: 'done' })) {
      const evs = this.state.events.filter((e) => e.taskId === t.id && e.type === 'moved');
      const start = evs.find((e) => e.data.to === 'doing');
      const end = [...evs].reverse().find((e) => e.data.to === 'done');
      if (start && end) cycle.push((Date.parse(end.at) - Date.parse(start.at)) / 3600e3);
    }
    const weekAgo = Date.now() - 7 * 864e5;
    return {
      counts: Object.fromEntries(COLUMNS.map((c) => [c, this.list({ column: c }).length])),
      throughput7d: this.state.events.filter((e) => e.type === 'moved' && e.data.to === 'done' && Date.parse(e.at) >= weekAgo).length,
      avgCycleHours: cycle.length ? +(cycle.reduce((a, b) => a + b, 0) / cycle.length).toFixed(2) : null,
    };
  }
}

const uniq = (a) => [...new Set(a)];
const brief = (t) => ({ id: t.id, title: t.title, assignee: t.assignee });
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
