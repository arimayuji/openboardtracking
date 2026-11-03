import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';

const human = { role: 'human', agent: 'ana@acme.com' };
const dev = { role: 'dev', agent: 'dev-a' };

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

async function listedNames(app, actor) {
  const body = await (await rpc(app, 'tools/list', {}, actor)).json();
  return body.result.tools.map((t) => t.name);
}

async function criar(app, titulo, extra = {}) {
  const r = await tool(app, 'criar_pedido', {
    titulo,
    descricao: `Pedido ${titulo}`,
    criterios: [`${titulo} funciona`],
    ...extra,
  });
  assert.notEqual(r.isError, true, textOf(r));
  return r.structuredContent.id;
}

test('tools/list: client gaps tools go to human only, dev gaps tools go to dev only', async () => {
  const { app } = setup();
  const humanNames = await listedNames(app, human);
  for (const name of ['dividir_pedido', 'adicionar_dependencia', 'relatorio']) {
    assert.ok(humanNames.includes(name), `${name} missing for human`);
  }
  assert.ok(!humanNames.includes('dividir_contrato'));
  assert.ok(!humanNames.includes('ranking'));

  const devNames = await listedNames(app, dev);
  for (const name of ['dividir_contrato', 'ranking']) {
    assert.ok(devNames.includes(name), `${name} missing for dev`);
  }
  for (const name of ['dividir_pedido', 'adicionar_dependencia', 'relatorio']) {
    assert.ok(!devNames.includes(name), `${name} leaked to dev`);
  }
});

test('tools/list: criar_pedido takes valor as an integer 1..5 and valor_reais as a number', async () => {
  const { app } = setup();
  const tools = (await (await rpc(app, 'tools/list', {}, human)).json()).result.tools;
  const criar = tools.find((t) => t.name === 'criar_pedido');
  assert.equal(criar.inputSchema.properties.valor.type, 'integer');
  assert.equal(criar.inputSchema.properties.valor.minimum, 1);
  assert.equal(criar.inputSchema.properties.valor.maximum, 5);
  assert.equal(criar.inputSchema.properties.valor_reais.type, 'number');
  assert.ok(!criar.inputSchema.required.includes('valor'));
});

test('criar_pedido with valor and valor_reais stores valueScore and valueBrl', async () => {
  const { app, store } = setup();
  const id = await criar(app, 'Relatório de faltas', { valor: 4, valor_reais: 1500 });
  const c = store.get(id);
  assert.equal(c.valueScore, 4);
  assert.equal(c.valueBrl, 1500);
});

test('criar_pedido with valor 7 is refused', async () => {
  const { app } = setup();
  const r = await tool(app, 'criar_pedido', {
    titulo: 'Muito valor',
    descricao: 'x',
    criterios: ['algo'],
    valor: 7,
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /entre 1 e 5/);
});

test('dividir_pedido creates two child requests under the parent', async () => {
  const { app, store } = setup();
  const id = await criar(app, 'Painel grande');
  const r = await tool(app, 'dividir_pedido', {
    id,
    partes: [
      { titulo: 'Parte A', criterios: ['A funciona'] },
      { titulo: 'Parte B', criterios: ['B funciona'] },
    ],
  });
  assert.notEqual(r.isError, true, textOf(r));
  assert.match(textOf(r), /^Pedido dividido em 2 partes:/);
  assert.match(textOf(r), /• Parte A \(\w+\)/);
  assert.equal(store.get(id).childIds.length, 2);
  for (const childId of store.get(id).childIds) {
    assert.equal(store.get(childId).parentId, id);
  }
});

test('dividir_pedido with a single part is refused', async () => {
  const { app, store } = setup();
  const id = await criar(app, 'Pedido único');
  const r = await tool(app, 'dividir_pedido', {
    id,
    partes: [{ titulo: 'Sozinha', criterios: ['funciona'] }],
  });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /pelo menos 2/);
  assert.equal(store.get(id).childIds, undefined);
});

test('adicionar_dependencia stores dependsOn and reports the blocker', async () => {
  const { app, store } = setup();
  const base = await criar(app, 'Base');
  const next = await criar(app, 'Depois');
  const r = await tool(app, 'adicionar_dependencia', { id: next, depende_de: base });
  assert.notEqual(r.isError, true, textOf(r));
  assert.match(textOf(r), /^Depois agora depende de outro pedido\./m);
  assert.match(textOf(r), /Ainda bloqueado por: Base\./);
  assert.deepEqual(store.get(next).dependsOn, [base]);
});

test('adicionar_dependencia refuses a circular dependency in Portuguese', async () => {
  const { app } = setup();
  const a = await criar(app, 'Primeiro');
  const b = await criar(app, 'Segundo');
  const first = await tool(app, 'adicionar_dependencia', { id: b, depende_de: a });
  assert.notEqual(first.isError, true);
  const r = await tool(app, 'adicionar_dependencia', { id: a, depende_de: b });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), 'Isso criaria uma dependência circular.');
});

test('relatorio returns the highlights and the Entregues line', async () => {
  const { app } = setup();
  await criar(app, 'Algo qualquer');
  const r = await tool(app, 'relatorio', { de: '2026-01-01', ate: '2026-12-31' });
  assert.notEqual(r.isError, true, textOf(r));
  assert.match(textOf(r), /Entregues: \d+ · Custo: US\$ \d+\.\d{2}/);
  assert.equal(typeof r.structuredContent.totals.delivered, 'number');
  assert.ok(Array.isArray(r.structuredContent.highlights));
});

test('ranking lists a request after the dev proposes an estimate', async () => {
  const { app } = setup();
  const id = await criar(app, 'Relatório por área', { valor: 5 });
  const proposed = await tool(app, 'propor', { id, horas: 3, plano: 'Tela', mensagem: 'ok' }, dev);
  assert.notEqual(proposed.isError, true, textOf(proposed));
  const r = await tool(app, 'ranking', {}, dev);
  assert.notEqual(r.isError, true, textOf(r));
  assert.match(textOf(r), new RegExp(`• Relatório por área \\(${id}\\) — score [\\d.]+ — `));
  assert.match(textOf(r), /Sem estimativa: \d+\nBloqueados: \d+$/);
});

test('dividir_contrato by dev splits a contract into parts', async () => {
  const { app, store } = setup();
  const id = await criar(app, 'Contrato grande');
  const r = await tool(app, 'dividir_contrato', {
    id,
    partes: [
      { titulo: 'Fase 1', criterios: ['fase 1 pronta'] },
      { titulo: 'Fase 2', criterios: ['fase 2 pronta'] },
    ],
  }, dev);
  assert.notEqual(r.isError, true, textOf(r));
  assert.match(textOf(r), /^Contrato dividido em 2 partes:/);
  assert.equal(store.get(id).childIds.length, 2);
});
