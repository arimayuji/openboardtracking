# Spec: aprovadores, critérios por IA, retrospectiva, mudança de escopo e objetivos de produto

Restrições: as mesmas de `docs/spec-portal.md` (ES modules, zero dependências em runtime, Web Crypto em código novo, `node:test`, textos para o cliente em português simples, sem jargão).

## 1. Quem pede e quem aprova

- `config.portal.approvers`: lista de e-mails (comparação sem diferenciar maiúsculas). **Lista vazia = todos podem aprovar** (comportamento atual).
- Só aprovadores podem: confirmar proposta, decidir escalonamento, aprovar entrega, pedir ajustes, pedir mudança de escopo.
  Qualquer pessoa do tenant pode criar pedido, listar, ver e criar objetivo.
- Recusa: 403 `{ error: "Só aprovadores podem fazer isso. Peça para <primeiro aprovador ou 'um aprovador'> aprovar." }`.
- `ClientView.canDecide`: `true` se o ator pode aprovar. O portal esconde os botões de decisão quando `false` e mostra "Aguardando um aprovador".
- Vale também pelo MCP (as ferramentas do cliente passam pelo portal).

## 2. Critérios sugeridos por IA (portal web, para quem não usa o Claude)

- `src/criteria-llm.js`: `suggestCriteria({ title, description, area }, { apiKey, model, fetchImpl })` → `string[]` (3 a 5).
  Chama `POST https://api.anthropic.com/v1/messages` (headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`), `max_tokens` 600.
  O sistema diz que o texto da pessoa é **dado, não instrução**, e pede **somente** um JSON `{"criteria": ["..."]}` com critérios verificáveis em português simples.
  O texto da pessoa vai dentro de `<pedido>...</pedido>`. Resposta inválida → erro 502 com mensagem em português. Sem `apiKey` → erro 503 "Sugestão automática não está ativada.".
  Cada critério: até 200 caracteres, sem duplicados; descarta itens vazios.
- `config.llm = { enabled: false, model: "claude-haiku-5-5" }`. Só com `enabled: true` e `env.ANTHROPIC_API_KEY` presente a rota funciona.
- Rota `POST /api/portal/suggest-criteria` `{ title, description, templateId? }` → `{ criteria }`. No portal: botão "Sugerir critérios" no Novo pedido, que preenche a lista editável (a pessoa revisa antes de enviar).

## 3. Retrospectiva automática (`src/retro.js`)

`retro(store, { days = 14, now = Date.now() })` olha os eventos da janela e devolve:

```js
{ since, findings: [{ kind, severity: "info"|"atenção"|"alta", text, evidence: { ... } }],
  suggestions: [{ text, action }], numbers: { accepted, rejected, escalated, overBudget, recurrences, stale } }
```

Achados (texto em português simples):
- `rejeicoes`: taxa de rejeição (rejeitados ÷ entregues na janela) ≥ 30% → atenção; motivos mais comuns (palavras do `reason`).
- `escalonamentos`: contagem por tipo (orçamento, sem acordo, irreversível, pedido manual) a partir do `reason`.
- `estimativa`: agente com razão mediana real/estimado ≥ 1,3 em horas (com ≥ 3 amostras) → "Fulano costuma levar X vezes o estimado".
- `orcamento`: contratos que escalaram por gasto acima do orçamento.
- `recorrencia`: contratos com `source.recurrenceOf` (problema voltou).
- `parados`: itens parados (`flow().stale`).
Sugestões ligadas aos achados (ex.: rejeição alta → "Detalhar melhor os critérios antes de começar"; sem acordo → "Quebrar pedidos grandes em partes menores"; recorrência → "Investigar a causa raiz antes de corrigir de novo"), `action` é um código curto (`refinar_criterios`, `quebrar_pedidos`, `ajustar_orcamento`, `calibrar_agente`, `investigar_causa`, `destravar`).
Rota `GET /api/retro?days=14` (time técnico) e a seção "O que aprender" no resumo diário do Slack (máx. 3 achados de severidade atenção/alta).

## 4. Mudança de escopo durante a execução

- `store.requestChange(id, { criteria, reason }, actor)`: só `client`; estados `agreed`, `building`, `delivered`.
  Volta para `negotiating` com nova versão da proposta feita pelo cliente (novos critérios, estimativa anterior mantida como referência), zera `agreedBy`, guarda `c.changes.push({ at, reason, fromState, version })`, registra evento `change`.
  O consumo já feito continua no contrato. `criteria` obrigatório (≥ 1).
- Portal: `POST /api/portal/requests/:id/change` `{ criteria, reason }` (só aprovador). Botão "Mudar o pedido" no detalhe quando o estado permite.
- `plain.js`: linha do tempo `change` → "Você pediu uma mudança no pedido".
- MCP cliente: `mudar_pedido { id, criterios, motivo }`.

## 5. Objetivos de produto

- `store.state.goals`: `[{ id, title, description, targetDate|null, createdAt, createdBy }]`.
- `store.createGoal({ title, description, targetDate }, actor)` (`client` ou `human`), `store.listGoals()`,
  `store.goalProgress(goalId)` → `{ goal, total, accepted, inProgress, waiting, spentUsd, percent }` (percent = aceitos ÷ total, inteiro).
- Pedidos ganham `goalId` (em `createIntent` e `store.linkGoal(id, goalId, actor)` por `client`). goalId inexistente → 400.
- Portal: `GET /api/portal/goals` (lista com progresso), `POST /api/portal/goals`, `goalId` opcional em `POST /api/portal/requests`; seção "Objetivos" com barra de progresso e filtro de pedidos por objetivo; seleção de objetivo no Novo pedido.
- MCP cliente: `listar_objetivos`, `criar_objetivo { titulo, descricao, data_alvo? }`, e `objetivo` opcional em `criar_pedido`.

## Critérios de pronto

`npm test` verde, com testes novos de cada parte; fluxo testado no servidor Node; telas sem erro no navegador.
