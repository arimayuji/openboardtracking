import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Board } from './board.js';

const board = new Board(process.env.BOARD_FILE ?? 'board.json');
const html = new URL('../public/index.html', import.meta.url);

const routes = [
  ['GET', /^\/api\/tasks$/, (_, q) => board.list({ column: q.get('column') ?? undefined, assignee: q.get('assignee') ?? undefined })],
  ['POST', /^\/api\/tasks$/, (_, __, b, actor) => board.create(b, actor)],
  ['GET', /^\/api\/tasks\/(\w+)$/, ([id]) => board.get(id)],
  ['POST', /^\/api\/tasks\/(\w+)\/move$/, ([id], _, b, actor) => board.move(id, b.column, actor)],
  ['POST', /^\/api\/tasks\/(\w+)\/notes$/, ([id], _, b, actor) => board.note(id, b.text, actor)],
  ['POST', /^\/api\/claim$/, (_, __, ___, actor) => board.claimNext(actor)],
  ['GET', /^\/api\/standup$/, (_, q) => board.standup(Number(q.get('hours') ?? 24))],
  ['GET', /^\/api\/metrics$/, () => board.metrics()],
  ['GET', /^\/api\/events$/, () => board.state.events.slice(-200)],
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
      const body = raw ? JSON.parse(raw) : {};
      const actor = req.headers['x-actor'] ?? 'human';
      return send(200, fn(m.slice(1), url.searchParams, body, actor));
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(e.status ?? 500, { error: e.message });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`openboardtracking on http://localhost:${port}`));
