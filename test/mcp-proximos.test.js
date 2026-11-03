import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';

const human = { role: 'human', agent: 'ana@acme.com' };
const bia = { role: 'human', agent: 'bia@acme.com' };
const dev = { role: 'dev', agent: 'dev-a' };
const client = { role: 'client', agent: 'ana@acme.com' };
const admin = { role: 'human', agent: 'admin' };
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

const post = (app, body, actor = human) => app.handle(new Request('http://x/mcp', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
}), actor);

let nextId = 1;
const rpc = (app, method, params, actor = human) => post(app, { jsonrpc: '2.0', id: nextId++, method, params }, actor);

async function tool(app, name, args = {}, actor = human) {
  const res = await rpc(app, 'tools/call', { name, arguments: args }, actor);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.result, `expected result, got ${JSON.stringify(body)}`);
  return body.result;
}

const textOf = (result) => result.content[0].text;

// Request taken to building through the MCP tools (client agreement goes through the store, as in mcp.test.js).
async function buildingRequest(app, store) {
  const created = await tool(app, 'criar_pedido', {
    titulo: 'Painel de horas',
    descricao: 'Painel simples',
    criterios: ['O painel mostra as horas por semana'],
  });
  const id = created.structuredContent.id;
  const proposed = await tool(app, 'propor', { id, horas: 2, plano: 'Tela', mensagem: 'ok' }, dev);
  store.agree(id, { version: proposed.structuredContent.proposal.version }, client);
  await tool(app, 'concordar', { id, versao: proposed.structuredContent.proposal.version }, dev);
  const started = await tool(app, 'iniciar', { id }, dev);
  assert.equal(started.structuredContent.state, 'building');
  return id;
}

test('tools/list: the three new tools are offered to human and none to dev', async () => {
  const { app } = setup();
  const newTools = ['mudar_pedido', 'listar_objetivos', 'criar_objetivo'];
  const humanNames = (await (await rpc(app, 'tools/list', {}, human)).json()).result.tools.map((t) => t.name);
  for (const name of newTools) assert.ok(humanNames.includes(name), `${name} missing for human`);
  const devNames = (await (await rpc(app, 'tools/list', {}, dev)).json()).result.tools.map((t) => t.name);
  for (const name of newTools) assert.ok(!devNames.includes(name), `${name} leaked to dev`);
});

test('tools/list: criar_pedido accepts an optional objetivo, and mudar_pedido is destructive', async () => {
  const { app } = setup();
  const tools = (await (await rpc(app, 'tools/list', {}, human)).json()).result.tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.criar_pedido.inputSchema.properties.objetivo.type, 'string');
  assert.ok(!byName.criar_pedido.inputSchema.required.includes('objetivo'));
  assert.equal(byName.mudar_pedido.annotations.destructiveHint, true);
  assert.equal(byName.listar_objetivos.annotations.readOnlyHint, true);
});

test('criar_objetivo then listar_objetivos shows the goal with 0 de 0', async () => {
  const { app } = setup();
  const created = await tool(app, 'criar_objetivo', { titulo: 'Reduzir turnover', descricao: 'Mais retenção' });
  assert.notEqual(created.isError, true);
  assert.match(textOf(created), /^Objetivo criado: Reduzir turnover \(\w+\)\.$/);
  assert.equal(created.structuredContent.goal.title, 'Reduzir turnover');

  const list = await tool(app, 'listar_objetivos');
  assert.match(textOf(list), /• Reduzir turnover \(\w+\) — 0 de 0 entregues \(0%\)/);
  assert.equal(list.structuredContent.items.length, 1);
});

test('listar_objetivos with no goals says so', async () => {
  const { app } = setup();
  const list = await tool(app, 'listar_objetivos');
  assert.equal(textOf(list), 'Nenhum objetivo ainda.');
  assert.deepEqual(list.structuredContent, { items: [] });
});

test('criar_pedido with objetivo stores goalId and the goal counts it', async () => {
  const { app, store } = setup();
  const goal = await tool(app, 'criar_objetivo', { titulo: 'Fechar mês sem retrabalho' });
  const goalId = goal.structuredContent.goal.id;
  const created = await tool(app, 'criar_pedido', {
    titulo: 'Relatório',
    descricao: 'Mensal',
    criterios: ['O relatório existe'],
    objetivo: goalId,
  });
  assert.notEqual(created.isError, true);
  assert.equal(store.get(created.structuredContent.id).goalId, goalId);

  const list = await tool(app, 'listar_objetivos');
  assert.match(textOf(list), /0 de 1 entregues \(0%\)/);
});

test('criar_pedido with an unknown objetivo is isError with the store message', async () => {
  const { app } = setup();
  const result = await tool(app, 'criar_pedido', {
    titulo: 'a', descricao: 'b', criterios: ['c'], objetivo: 'nao-existe',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /objetivo não encontrado/);
});

test('mudar_pedido on a building request returns the text and the store shows negotiating', async () => {
  const { app, store } = setup();
  const id = await buildingRequest(app, store);
  const result = await tool(app, 'mudar_pedido', {
    id,
    criterios: ['O painel mostra as horas por semana e por pessoa'],
    motivo: 'O time pediu mais detalhe',
  });
  assert.notEqual(result.isError, true);
  assert.equal(textOf(result), 'Mudança registrada: Painel de horas. O pedido voltou para definição e o time fará uma nova proposta.');
  assert.equal(store.get(id).state, 'negotiating');
  assert.equal(store.get(id).changes.length, 1);
  assert.equal(store.get(id).changes[0].reason, 'O time pediu mais detalhe');
});

test('mudar_pedido by a human who is not an approver is isError with the Portuguese approver message', async () => {
  const { app, store } = setup();
  const id = await buildingRequest(app, store);
  store.updateConfig({ portal: { approvers: ['ana@acme.com'] } }, admin);
  const result = await tool(app, 'mudar_pedido', { id, criterios: ['Novo critério'], motivo: 'x' }, bia);
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Só aprovadores podem fazer isso. Peça para ana@acme.com aprovar.');
  assert.equal(store.get(id).state, 'building');
});

test('mudar_pedido without criterios is isError', async () => {
  const { app } = setup();
  const created = await tool(app, 'criar_pedido', { titulo: 'a', descricao: 'b', criterios: ['c'] });
  const result = await tool(app, 'mudar_pedido', { id: created.structuredContent.id, motivo: 'x' });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), 'Campo obrigatório ausente: criterios.');
});

test('mudar_pedido with an empty criterios list is isError', async () => {
  const { app } = setup();
  const created = await tool(app, 'criar_pedido', { titulo: 'a', descricao: 'b', criterios: ['c'] });
  const result = await tool(app, 'mudar_pedido', { id: created.structuredContent.id, criterios: [], motivo: 'x' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /pelo menos 1 item/);
});

test('mudar_pedido on a request still in negotiation is isError with the plain message', async () => {
  const { app } = setup();
  const created = await tool(app, 'criar_pedido', { titulo: 'a', descricao: 'b', criterios: ['c'] });
  const result = await tool(app, 'mudar_pedido', {
    id: created.structuredContent.id, criterios: ['novo'], motivo: 'x',
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /não está numa etapa/);
});
