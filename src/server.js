// Node adapter: turns IncomingMessage into a Fetch Request, calls the app, streams the Response back.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { Contracts } from './contract.js';
import { fileStore } from './file-store.js';
import { Webhooks } from './webhooks.js';
import { Slack } from './slack.js';
import { createApp } from './app.js';

const store = new Contracts(fileStore(process.env.BOARD_FILE ?? 'board.json'));
const hooks = new Webhooks(store);
const slack = new Slack(store);
setInterval(() => slack.tick().catch((e) => console.error('digest failed:', e.message)), 10 * 60e3).unref();
const pages = new Map([['/', 'index.html'], ['/portal', 'portal.html'], ['/landing', 'landing.html']]);
const app = createApp({ store, hooks, slack, env: process.env });

// Actor identity: x-role (client | dev | human) + x-agent (free-form name).
// NOTE: header-based identity is for local MVP use only; add real auth before exposing it.
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && pages.has(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(readFileSync(new URL(`../public/${pages.get(url.pathname)}`, import.meta.url)));
    }

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = chunks.length ? Buffer.concat(chunks) : undefined;
    }
    const request = new Request(url, { method: req.method, headers, body });
    const actor = { role: req.headers['x-role'] ?? 'human', agent: req.headers['x-agent'] ?? 'anonymous' };

    const response = await app.handle(request, actor);
    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.writeHead(response.status, outHeaders);
    if (!response.body) return res.end();
    Readable.fromWeb(response.body).pipe(res);
  } catch (e) {
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`openboardtracking on http://localhost:${port}`));
