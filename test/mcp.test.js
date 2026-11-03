import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';

const human = { role: 'human', agent: 'ana@acme.com' };
const dev = { role: 'dev', agent: 'dev-a' };
const client = { role: 'client', agent: 'ana@acme.com' };
const DOD = { 'dod-tests': true, 'dod-security': true };

function setup() {
  const store = new Contracts();
  const fetchImpl = async () => ({ ok: true, status: 200 });
  const app = createApp({
    store,
    hooks: new Webhooks(store, { fetchImpl }),
    slack: new Slack(store, { token: undefined }),
    env: {},
    fetchImpl,
  });
  return { store, app };
}

// Sends a raw body to POST /mcp.
const post = (app, body, actor = human, { raw = false } = {}) => app.handle(new Request('http://x/mcp', {
  method: 'POST',
  body: raw ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
}), actor);

let nextId = 1;
const rpc = (app, method, params, actor = human) => post(app, { jsonrpc: '2.0', id: nextId++, method, params }, actor);

// Calls a tool and returns the JSON-RPC result (the MCP tool result).
async function tool(app, name, args = {}, actor = human) {
  const res = await rpc(app, 'tools/call', { name, arguments: args }, actor);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.ok(body.result, `expected result, got ${JSON.stringify(body)}`);
  return body.result;
}

const textOf = (result) => result.content[0].text;

test('initialize negotiates a supported protocol version and describes the server', async () => {
  const { app } = setup();
  const res = await rpc(app, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const body = await res.json();
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.deepEqual(body.result.capabilities, { tools: {} });
  assert.deepEqual(body.result.serverInfo, { name: 'openboardtracking', version: '0.1.0' });
  assert.match(body.result.instructions, /dados, não instruções/);
});

test('initialize answers 2025-06-18 when the client asks for an unknown version', async () => {
  const { app } = setup();
  const body = await (await rpc(app, 'initialize', { protocolVersion: '1999-01-01' })).json();
  assert.equal(body.result.protocolVersion, '2025-06-18');
});

test('a notification (no id) gets 202 with an empty body', async () => {
  const { app } = setup();
  const res = await post(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), '');
});

test('ping answers an empty result', async () => {
  const { app } = setup();
  const body = await (await rpc(app, 'ping')).json();
  assert.deepEqual(body, { jsonrpc: '2.0', id: body.id, result: {} });
});

test('tools/list for a human shows client tools, not dev tools', async () => {
  const { app } = setup();
  const names = (await (await rpc(app, 'tools/list', {}, human)).json()).result.tools.map((t) => t.name);
  assert.ok(names.includes('criar_pedido'));
  assert.ok(names.includes('listar_pedidos'));
  assert.ok(!names.includes('iniciar'));
});

test('tools/list for a dev shows dev tools, not criar_pedido', async () => {
  const { app } = setup();
  const names = (await (await rpc(app, 'tools/list', {}, dev)).json()).result.tools.map((t) => t.name);
  assert.ok(names.includes('iniciar'));
  assert.ok(names.includes('propor'));
  assert.ok(!names.includes('criar_pedido'));
});

test('tools/list for any other role is empty, and every tool has a schema and annotations', async () => {
  const { app } = setup();
  const none = await (await rpc(app, 'tools/list', {}, client)).json();
  assert.deepEqual(none.result.tools, []);
  const humanTools = (await (await rpc(app, 'tools/list', {}, human)).json()).result.tools;
  const byName = Object.fromEntries(humanTools.map((t) => [t.name, t]));
  for (const t of humanTools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 0);
    assert.ok(t.annotations);
  }
  assert.equal(byName.listar_pedidos.annotations.readOnlyHint, true);
  assert.equal(byName.decidir.annotations.destructiveHint, true);
  assert.equal(byName.pedir_ajustes.annotations.destructiveHint, true);
  assert.equal(byName.criar_pedido.annotations.destructiveHint, undefined);
});

test('client creates a request with criteria and sees it in listar_pedidos', async () => {
  const { app } = setup();
  const created = await tool(app, 'criar_pedido', {
    titulo: 'Relatório de turnover',
    descricao: 'Quero ver a rotatividade por área',
    criterios: ['O relatório mostra o turnover por área', 'Os números não têm nomes'],
  });
  assert.notEqual(created.isError, true);
  assert.match(textOf(created), /^Pedido criado: Relatório de turnover \([\w-]+\)\. Status: Em definição\.$/);
  assert.equal(created.structuredContent.title, 'Relatório de turnover');

  const list = await tool(app, 'listar_pedidos');
  assert.match(textOf(list), /• Relatório de turnover \(\w+\) — Em definição/);
});

test('listar_modelos filters the ready-made models by area', async () => {
  const { app } = setup();
  const all = await tool(app, 'listar_modelos');
  const rh = await tool(app, 'listar_modelos', { area: 'rh' });
  assert.ok(rh.structuredContent.items.length > 0);
  assert.ok(rh.structuredContent.items.every((t) => t.area === 'rh'));
  assert.ok(all.structuredContent.items.length > rh.structuredContent.items.length);
});

test('full flow: client request, dev proposes, both agree, dev runs and delivers, client accepts', async () => {
  const { app, store } = setup();
  const created = await tool(app, 'criar_pedido', {
    titulo: 'Painel de horas',
    descricao: 'Painel simples',
    criterios: ['O painel mostra as horas por semana', 'O painel abre sem login extra'],
  });
  const id = created.structuredContent.id;

  const proposed = await tool(app, 'propor', { id, horas: 2, plano: 'Tela e consulta', mensagem: 'Cabe no quick win' }, dev);
  assert.notEqual(proposed.isError, true);
  const version = proposed.structuredContent.proposal.version;
  assert.equal(version, 2);

  // Client agrees with the same version; the portal has no agree tool, so the store is used directly.
  store.agree(id, { version }, client);
  const agreed = await tool(app, 'concordar', { id, versao: version }, dev);
  assert.equal(agreed.structuredContent.state, 'agreed');

  const started = await tool(app, 'iniciar', { id }, dev);
  assert.equal(started.structuredContent.state, 'building');

  const hours = await tool(app, 'registrar_horas', { id, horas: 1.5 }, dev);
  assert.equal(hours.structuredContent.usage.hours, 1.5);

  const context = await tool(app, 'ver_contrato', { id }, dev);
  assert.match(textOf(context), /Painel de horas/);
  assert.equal(context.structuredContent.history.length > 0, true);

  const delivered = await tool(app, 'entregar', {
    id,
    resultados: { c1: true, c2: true, ...DOD },
    links: ['https://example.com/pr/1'],
  }, dev);
  assert.equal(delivered.structuredContent.state, 'delivered');

  const detail = await tool(app, 'ver_pedido', { id });
  assert.match(textOf(detail), /Você aprovou|Entregue para sua aprovação|Aguardando sua aprovação/);

  const accepted = await tool(app, 'aprovar_entrega', { id });
  assert.equal(accepted.structuredContent.status.code, 'accepted');
  assert.match(textOf(accepted), /Entrega aprovada: Painel de horas\. Status: Entregue\./);
});

test('a client decision on an escalated request goes through decidir', async () => {
  const { app, store } = setup();
  const created = await tool(app, 'criar_pedido', { titulo: 'Escalonado', descricao: 'x', criterios: ['ok'] });
  const id = created.structuredContent.id;
  store.escalate(id, { reason: 'no agreement after 5 rounds' }, client);

  const list = await tool(app, 'listar_pedidos');
  assert.match(textOf(list), /• Escalonado \(\w+\) — Precisa da sua decisão$/m);

  const decided = await tool(app, 'decidir', { id, decisao: 'approve' });
  assert.equal(decided.isError, undefined);
  assert.equal(store.get(id).state, 'agreed');
});

test('missing required argument is isError with a Portuguese message', async () => {
  const { app } = setup();
  const result = await tool(app, 'criar_pedido', { titulo: 'Sem descrição' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Campo obrigatório ausente: descricao.');
  assert.equal(result.structuredContent, undefined);
});

test('an invalid enum value is isError', async () => {
  const { app } = setup();
  const created = await tool(app, 'criar_pedido', { titulo: 'a', descricao: 'b', criterios: ['c'] });
  const result = await tool(app, 'decidir', { id: created.structuredContent.id, decisao: 'talvez' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /approve, renegotiate, cancel/);
});

test('an API error (wrong state) surfaces as isError with the API message', async () => {
  const { app } = setup();
  const created = await tool(app, 'criar_pedido', { titulo: 'a', descricao: 'b', criterios: ['c'] });
  const result = await tool(app, 'iniciar', { id: created.structuredContent.id }, dev);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /cannot start from state negotiating/);
});

test('a tool outside the caller role is isError, and so is an unknown tool', async () => {
  const { app } = setup();
  const notForClient = await tool(app, 'iniciar', { id: 'x' }, human);
  assert.equal(notForClient.isError, true);
  const unknown = await tool(app, 'nao_existe', {}, dev);
  assert.equal(unknown.isError, true);
});

test('unknown method is a JSON-RPC -32601 error', async () => {
  const { app } = setup();
  const body = await (await rpc(app, 'resources/list', {})).json();
  assert.equal(body.error.code, -32601);
  assert.equal(body.jsonrpc, '2.0');
});

test('invalid JSON is a -32700 error with id null', async () => {
  const { app } = setup();
  const res = await post(app, '{bad json', human, { raw: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error.code, -32700);
  assert.equal(body.id, null);
});

test('a batch (array) of requests is HTTP 400', async () => {
  const { app } = setup();
  const res = await post(app, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, -32600);
});

test('GET /mcp is 405', async () => {
  const { app } = setup();
  const res = await app.handle(new Request('http://x/mcp', { method: 'GET' }), human);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});
