# Spec: dividir pedidos, dependências, valor por pedido e relatório por período

Restrições: as mesmas de `docs/spec-portal.md` (ES modules, zero dependências em runtime, `node:test`, textos para o cliente em português simples).

## 1. Dividir pedidos grandes e dependências (núcleo, `src/contract.js`)

- `splitContract(id, { parts: [{ title, criteria: string[], goal? }] }, actor)`: papéis `client` ou `dev`; o contrato precisa estar em `negotiating` ou `agreed` e não ter filhos.
  Cria um contrato filho por parte (mínimo 2) com `parentId`, herdando `area`, `sensitive`, `goalId`, `kind`, `priority`, `budget` vazio e o `source` do pai.
  O pai ganha `childIds` e volta para `negotiating` com `agreedBy = []`. Evento `split` no pai e `intent` em cada filho.
- Contrato com filhos (pai) **não pode** ser iniciado (`start` → 409 "Este pedido foi dividido; trabalhe nas partes.").
- Quando todos os filhos ficam `accepted`, o pai fica `accepted` automaticamente (evento `accept` com `data.auto: true`, `acceptedAt`).
- `addDependency(id, dependsOnId, actor)` (`client` ou `dev`): ambos existem; não pode depender de si mesmo; recusa ciclo (400 "Isso criaria uma dependência circular."); guarda em `c.dependsOn` (sem duplicar). `removeDependency(id, dependsOnId, actor)`.
- `blockers(id)` → ids das dependências que ainda não estão `accepted`. `start` recusa enquanto houver bloqueios (409 "Este pedido depende de outros que ainda não foram entregues.").

## 2. Valor por pedido

- `createIntent`/`createContract` aceitam `valueScore` (inteiro 1 a 5; fora disso → 400) e `valueBrl` (número ≥ 0, opcional). Guardados no contrato.
- `src/ranking.js`: `ranking(store)` ordena o trabalho aberto (`negotiating`, `agreed`) **sem bloqueios e sem filhos**:
  `score = valueScore / max(0.5, p85Horas)` (p85 calibrado; sem estimativa → `null`, vai para o fim, em `needsEstimate`).
  Sem `valueScore`, usa 3. Cada item: `{ id, title, valueScore, valueBrl, p85Hours, score, reason }` com `reason` em português ("Alto valor e rápido de fazer", "Alto valor, mas grande: considere dividir", "Baixo valor para o esforço").
  Itens bloqueados vão em `blocked` com os ids que bloqueiam. Retorno `{ ranked, needsEstimate, blocked }`.
- `quickWins` passa a desempatar por `valueScore` (maior primeiro) depois da prioridade.

## 3. Relatório por período (`src/report.js`)

`report(store, { from, to })` (datas ISO; padrão: mês corrente em UTC) e `comparePeriods` interno com o período anterior de mesmo tamanho:

```js
{ from, to,
  delivered: [{ id, title, area, goalId, deliveredAt, days, costUsd, valueBrl }],
  totals: { delivered, costUsd, valueBrl, avgDays, rejected, changes, incidents },
  byArea: { [area]: { delivered, costUsd } }, byGoal: { [goalId]: { title, delivered, costUsd } },
  previous: { delivered, costUsd, avgDays },
  highlights: [string] }   // 2 a 4 frases em português: "Entregamos 12 pedidos, 3 a mais que no período anterior."
```
`days` = dias corridos de `createdAt` a `acceptedAt` (1 casa). `changes` = eventos `change`; `incidents` = contratos `kind: incident` criados no período. Valores em R$ convertidos pela cotação (`config.fx.usdToBrl`) quando houver, no portal.
`reportCsv(report)` → CSV (`;` como separador, cabeçalho em português) dos entregues.

## 4. Portal e MCP

- Portal:
  - `POST /api/portal/requests/:id/split` `{ parts }`;
  - `POST /api/portal/requests/:id/depends` `{ dependsOn }` e `DELETE /api/portal/requests/:id/depends/:other`;
  - `valueScore`/`valueBrl` em `POST /api/portal/requests`;
  - `GET /api/portal/report?from&to` e `GET /api/portal/report.csv?from&to`.
  - Dividir e dependências exigem aprovador.
  - `ClientView` ganha `parentId`, `childIds`, `dependsOn`, `blockedBy` (títulos dos bloqueios), `valueScore`, `valueBrl`.
- Time técnico: `GET /api/ranking`.
- Tela:
  - no Novo pedido, campo "Quanto isso vale para você?" (Baixo, Médio-baixo, Médio, Alto, Muito alto) e "Valor estimado (R$)" opcional;
  - no detalhe, "Dividir em partes" e "Depende de…" (selecionar outros pedidos), mostrando partes e bloqueios;
  - aba "Relatório" com o período (mês atual, mês anterior, trimestre, personalizado), destaques, números, comparação e botão "Baixar planilha".
- MCP:
  - cliente: `dividir_pedido`, `adicionar_dependencia`, `relatorio`; `valor` (1 a 5) e `valor_reais` em `criar_pedido`;
  - dev: `dividir_contrato`, `ranking`.

## Critérios de pronto

`npm test` verde, com testes novos de cada parte; fluxo testado no servidor Node; telas sem erro no navegador.
