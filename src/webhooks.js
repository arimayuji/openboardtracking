// Outbound webhooks: the base for every integration (chat, email, other tools).
// Each subscription receives the events it asked for, signed with HMAC-SHA256
// so the receiver can verify they came from this server.
import { createHmac, randomUUID } from 'node:crypto';
import { httpError } from './contract.js';

const MAX_ATTEMPTS = 3;
const LOG_SIZE = 50;

export class Webhooks {
  constructor(store, { fetchImpl = globalThis.fetch, backoffMs = 1000 } = {}) {
    this.store = store;
    this.fetch = fetchImpl;
    this.backoffMs = backoffMs;
    store.state.webhooks ??= [];
    store.state.deliveries ??= [];
    store.onEvent((ev) => this.dispatch(ev));
  }

  // Only humans manage where data is sent: it leaves the platform.
  add({ url, events = ['*'], secret }, actor) {
    if (actor.role !== 'human') throw httpError(403, 'only human can manage webhooks');
    if (!/^https?:\/\//.test(url ?? '')) throw httpError(400, 'url must be http(s)');
    if (!secret) throw httpError(400, 'secret is required to sign deliveries');
    const hook = { id: randomUUID().slice(0, 8), url, events, secret, createdAt: new Date().toISOString() };
    this.store.state.webhooks.push(hook);
    this.store.save();
    return redact(hook);
  }

  remove(id, actor) {
    if (actor.role !== 'human') throw httpError(403, 'only human can manage webhooks');
    const before = this.store.state.webhooks.length;
    this.store.state.webhooks = this.store.state.webhooks.filter((h) => h.id !== id);
    if (this.store.state.webhooks.length === before) throw httpError(404, `webhook ${id} not found`);
    this.store.save();
    return { removed: id };
  }

  list() { return this.store.state.webhooks.map(redact); }

  deliveries() { return this.store.state.deliveries; }

  // Fire-and-forget: never blocks the action that produced the event.
  dispatch(ev) {
    const hooks = this.store.state.webhooks.filter((h) => h.events.includes('*') || h.events.includes(ev.type));
    return Promise.all(hooks.map((h) => this.send(h, ev)));
  }

  async send(hook, ev) {
    const body = JSON.stringify(ev);
    const signature = 'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex');
    let status = null, error = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-obt-event': ev.type, 'x-obt-signature-256': signature, 'x-obt-delivery': ev.id },
          body,
        });
        status = res.status;
        error = null;
        if (res.ok) break;
      } catch (e) {
        error = e.message;
      }
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, this.backoffMs * 2 ** (attempt - 1)));
    }
    this.store.state.deliveries.push({ hook: hook.id, event: ev.id, type: ev.type, status, error, at: new Date().toISOString() });
    this.store.state.deliveries = this.store.state.deliveries.slice(-LOG_SIZE);
    this.store.save();
  }
}

const redact = ({ secret, ...h }) => ({ ...h, secret: secret ? '***' : null });
