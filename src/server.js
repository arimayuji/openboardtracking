import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Contracts, pickMetrics } from './contract.js';
import { flow } from './flow.js';
import { Webhooks } from './webhooks.js';
import { handleGithub, verifySignature } from './github.js';
import { calibration, calibrate, forecast } from './estimate.js';

const store = new Contracts(process.env.BOARD_FILE ?? 'board.json');
const hooks = new Webhooks(store);
const html = new URL('../public/index.html', import.meta.url);

// Actor identity: x-role (client | dev | human) + x-agent (free-form name).
// NOTE: header-based identity is for local MVP use only; add real auth before exposing it.
const routes = [
  ['POST', /^\/api\/integrations\/github$/, () => null], // handled above with the raw body
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
  ['GET', /^\/api\/config$/, () => store.config],
  ['POST', /^\/api\/config$/, (_, b, a) => store.updateConfig(b, a)],
  ['GET', /^\/api\/webhooks$/, () => hooks.list()],
  ['POST', /^\/api\/webhooks$/, (_, b, a) => hooks.add(b, a)],
  ['DELETE', /^\/api\/webhooks\/(\w+)$/, ([id], _, a) => hooks.remove(id, a)],
  ['GET', /^\/api\/webhooks\/deliveries$/, () => hooks.deliveries()],
  ['GET', /^\/api\/summary$/, (_, q) => store.summary(Number(q.get?.('hours') ?? 24))],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(readFileSync(html));
  }
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    for (const [method, re, fn] of routes) {
      const m = url.pathname.match(re);
      if (req.method !== method || !m) continue;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (url.pathname === '/api/integrations/github') {
        verifySignature(raw, req.headers['x-hub-signature-256'], process.env.GITHUB_WEBHOOK_SECRET);
        return send(200, handleGithub(store, req.headers['x-github-event'], JSON.parse(raw)));
      }
      const body = raw ? JSON.parse(raw) : {};
      const actor = { role: req.headers['x-role'] ?? 'human', agent: req.headers['x-agent'] ?? 'anonymous' };
      const arg = method === 'GET' && m.length === 1 ? url.searchParams : body;
      return send(200, fn(m.slice(1), arg, actor));
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(e.status ?? (e instanceof SyntaxError ? 400 : 500), { error: e.message });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`openboardtracking on http://localhost:${port}`));
