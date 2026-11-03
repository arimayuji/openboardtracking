// HTTP routing in the Fetch API style: the same code runs in Node (src/server.js)
// and in Cloudflare Workers. No node:http, node:fs or process.env in here.
import { pickMetrics, httpError } from './contract.js';
import { flow } from './flow.js';
import { retro } from './retro.js';
import { handleGithub, verifySignature } from './github.js';
import { verifySlackSignature } from './slack.js';
import { handleSentry, verifySentrySignature } from './sentry.js';
import { handleDatadog, handleMessage, quickWins, verifyIntakeToken } from './intake.js';
import { calibration, calibrate, forecast } from './estimate.js';
import { proxyFetch } from './usage-proxy.js';
import { portalRoutes } from './portal.js';
import { createMcp } from './mcp.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

// `actor` is `{ role, agent }`, already authenticated by the caller, or null.
export function createApp({ store, hooks, slack, env = {}, fetchImpl = globalThis.fetch }) {
  const intakeHandlers = new Map([['datadog', handleDatadog], ['message', handleMessage]]);

  // Integrations authenticate with their own signature or token, not with the actor.
  // Each receives the raw body text and the request headers (lowercase keys).
  const integrations = [
    ['POST', /^\/api\/intake\/(\w+)$/, ([name], raw, headers) => {
      verifyIntakeToken(headers['x-obt-intake-token'], env.INTAKE_TOKEN);
      const handler = intakeHandlers.get(name);
      if (!handler) throw httpError(404, 'not found');
      return handler(store, JSON.parse(raw || '{}'));
    }],
    ['POST', /^\/api\/integrations\/slack\/(events|interactions)$/, async ([kind], raw, headers) => {
      verifySlackSignature(raw, headers, env.SLACK_SIGNING_SECRET);
      return kind === 'events'
        ? slack.handleEvents(JSON.parse(raw))
        : slack.handleInteraction(JSON.parse(new URLSearchParams(raw).get('payload') ?? '{}'));
    }],
    ['POST', /^\/api\/integrations\/sentry$/, (_, raw, headers) => {
      verifySentrySignature(raw, headers['sentry-hook-signature'], env.SENTRY_CLIENT_SECRET);
      return handleSentry(store, headers['sentry-hook-resource'], JSON.parse(raw));
    }],
    ['POST', /^\/api\/integrations\/github$/, (_, raw, headers) => {
      verifySignature(raw, headers['x-hub-signature-256'], env.GITHUB_WEBHOOK_SECRET);
      return handleGithub(store, headers['x-github-event'], JSON.parse(raw));
    }],
  ];

  // Normal routes: fn(params, body-or-query, actor). GET routes without params get the query string.
  const routes = [
    ...portalRoutes(store),
    ['POST', /^\/api\/slack\/digest$/, (_, __, a) => {
      if (a.role !== 'human') throw httpError(403, 'only human can send the digest');
      return slack.sendDigest();
    }],
    ['GET', /^\/api\/quickwins$/, (_, q) => quickWins(store, { maxHours: Number(q.get('maxHours') ?? 2) })],
    ['GET', /^\/api\/contracts$/, (_, q) => store.list({ state: q.get('state') ?? undefined })],
    ['POST', /^\/api\/contracts$/, (_, b, a) => store.createIntent(b, a)],
    ['GET', /^\/api\/contracts\/(\w+)$/, ([id]) => store.get(id)],
    ['GET', /^\/api\/contracts\/(\w+)\/history$/, ([id]) => store.history(id)],
    ['POST', /^\/api\/contracts\/(\w+)\/propose$/, ([id], b, a) => store.propose(id, b, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/agree$/, ([id], b, a) => store.agree(id, b, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/start$/, ([id], _, a) => store.start(id, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/usage$/, ([id], b, a) => store.reportUsage(id, b, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/deliver$/, ([id], b, a) => store.deliver(id, b, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/accept$/, ([id], _, a) => store.accept(id, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/reject$/, ([id], b, a) => store.reject(id, b, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/escalate$/, ([id], b, a) => store.escalate(id, b, a)],
    ['POST', /^\/api\/contracts\/(\w+)\/resolve$/, ([id], b, a) => store.resolve(id, b, a)],
    ['GET', /^\/api\/forecast$/, (_, q) => forecast(store, { parallel: Number(q.get('parallel') ?? 1) })],
    ['GET', /^\/api\/calibration$/, () => calibration(store)],
    ['GET', /^\/api\/calibrate$/, (_, q) => calibrate(store, pickMetrics(Object.fromEntries(q)), q.get('agent') ?? undefined)],
    ['GET', /^\/api\/flow$/, (_, q) => flow(store, { days: Number(q.get('days') ?? 7) })],
    ['GET', /^\/api\/retro$/, (_, q) => retro(store, { days: Number(q.get('days') ?? 14) })],
    ['GET', /^\/api\/config$/, () => store.config],
    ['POST', /^\/api\/config$/, (_, b, a) => store.updateConfig(b, a)],
    ['GET', /^\/api\/webhooks$/, () => hooks.list()],
    ['POST', /^\/api\/webhooks$/, (_, b, a) => hooks.add(b, a)],
    ['DELETE', /^\/api\/webhooks\/(\w+)$/, ([id], _, a) => hooks.remove(id, a)],
    ['GET', /^\/api\/webhooks\/deliveries$/, () => hooks.deliveries()],
    ['GET', /^\/api\/summary$/, (_, q) => store.summary(Number(q.get?.('hours') ?? 24))],
  ];

  // MCP tools call this same handle with the same actor; /mcp itself is never a tool.
  const mcp = createMcp(handle);

  async function handle(request, actor) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path.startsWith('/proxy/')) return await proxyFetch(store, request, { fetchImpl, env });
      if (path === '/mcp') {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
        return await mcp.handle(request, actor);
      }

      for (const [method, re, fn] of integrations) {
        const m = path.match(re);
        if (request.method !== method || !m) continue;
        const raw = await request.text();
        const headers = Object.fromEntries(request.headers);
        return json(200, await fn(m.slice(1), raw, headers));
      }

      for (const [method, re, fn] of routes) {
        const m = path.match(re);
        if (request.method !== method || !m) continue;
        if (!actor) throw httpError(401, 'authentication required');
        const raw = await request.text();
        const body = raw ? JSON.parse(raw) : {};
        const arg = method === 'GET' && m.length === 1 ? url.searchParams : body;
        return json(200, await fn(m.slice(1), arg, actor));
      }

      return json(404, { error: 'not found' });
    } catch (e) {
      return json(e.status ?? (e instanceof SyntaxError ? 400 : 500), { error: e.message });
    }
  }

  return { handle };
}
