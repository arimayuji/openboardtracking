# Spec: Portal do Cliente hospedado na Cloudflare + importação de histórico

## Objetivo

Levar o OpenBoardTracking a clientes **não técnicos** (RH, mercado financeiro, saúde, direito, economia):
uma tela hospedada onde a pessoa pede o que precisa em português simples, acompanha custo e previsão,
decide exceções em um clique e vê o valor entregue. E permitir **importar projetos e tarefas passados**
para a estimativa já nascer calibrada.

## Restrições

- JavaScript ES modules, **sem dependências npm em runtime** (o Worker pode usar só `wrangler` como devDependency).
- O núcleo (`src/contract.js`, `src/estimate.js`, `src/flow.js`, `src/intake.js`, etc.) roda em Node e em Cloudflare Workers.
  Nada de `node:fs`, `node:http` ou `Buffer` em código compartilhado. `node:crypto` só onde já existe (integrações); código novo usa Web Crypto (`crypto.subtle`).
- Testes com `node:test` (`npm test`). Todo módulo novo tem teste.
- Textos para o cliente em **português do Brasil**, sem jargão: nada de "PR", "token", "WIP", "building", "DoD" na tela do cliente.
- `new Contracts(storage, config)`: `storage` é `null` ou `{ state?, persist?(state) }`. Node usa `fileStore(path)` (`src/file-store.js`).

## Arquitetura

```
Navegador (cliente) ──► Cloudflare Access (login por e-mail/SSO) ──► Worker
Agentes ─────────────── Authorization: Bearer <token> ─────────────► Worker
Worker: autentica, descobre o tenant, encaminha ao Durable Object TenantBoard(tenant)
TenantBoard: mantém Contracts em memória, persiste em ctx.storage, responde via app.handle(Request)
```

- **`src/app.js`**: roteador no estilo Fetch API, usado pelo Node e pelo Worker:
  `createApp({ store, hooks, slack, env, fetchImpl })` retorna `{ handle(request, actor) => Promise<Response> }`.
  `actor` = `{ role, agent }` já autenticado por quem chama (Node: headers `x-role`/`x-agent`, só local; Worker: Access/tokens).
  Contém **todas** as rotas atuais de `src/server.js` (inclusive integrações com assinatura e `/proxy/...`).
- **`src/server.js`** vira só o adaptador Node: converte `IncomingMessage` em `Request`, chama `app.handle`, escreve a `Response` (com streaming).
- **Tenant**: um Durable Object por cliente (isolamento total de dados).
- **Configuração de tenants** (secret `TENANTS`, JSON):
  ```json
  { "acme": { "members": ["ana@acme.com", "@acme.com"], "admins": ["ti@acme.com"],
              "agentTokens": [{ "sha256": "<hex do token>", "role": "dev", "agent": "dev-1" }] } }
  ```
  `members` aceita e-mail exato ou domínio (`@acme.com`) e só acessam `/api/portal/*`; `admins` (e-mails exatos) acessam a API completa do tenant. Um e-mail pertencendo a mais de um tenant escolhe por `?tenant=`.

## API do portal (`/api/portal/*`, só usuários humanos autenticados do tenant)

O usuário do portal age como `client` ao pedir/aceitar e como `human` ao decidir escalonamentos; o `agent` registrado é o e-mail.

| Método | Rota | Corpo | Resposta |
|---|---|---|---|
| GET | `/api/portal/me` | | `{ email, tenant }` |
| GET | `/api/portal/templates` | | `Template[]` |
| GET | `/api/portal/overview` | | `Overview` |
| GET | `/api/portal/requests` | | `ClientView[]` |
| GET | `/api/portal/requests/:id` | | `ClientView & { timeline: {at, text}[] }` |
| POST | `/api/portal/requests` | `{ title, description, criteria?: string[], templateId?, budgetBrl? }` | `ClientView` |
| POST | `/api/portal/requests/:id/decision` | `{ decision: "approve"\|"renegotiate"\|"cancel" }` | `ClientView` |
| POST | `/api/portal/requests/:id/confirm` | `{ version? }` | `ClientView` (cliente confirma a proposta do time) |
| POST | `/api/portal/requests/:id/accept` | | `ClientView` |
| POST | `/api/portal/requests/:id/reject` | `{ reason }` | `ClientView` |
| POST | `/api/portal/import` | `{ format: "jira"\|"linear"\|"trello"\|"generic", csv, hoursPerPoint? }` | `ImportResult` |

Se `criteria` vier vazio e houver `templateId`, usa os critérios do modelo; se não houver nenhum dos dois, cada linha não vazia de `description` que comece com `-` vira critério; se ainda assim ficar vazio, responde 400 com mensagem em português.
`budgetBrl` é convertido para `budget.costUsd` usando `config.fx.usdToBrl` (definido por humano); sem câmbio configurado, responde 400 explicando.

### Tipos

```ts
Template = { id, area: "rh"|"financas"|"saude"|"direito"|"economia", title, summary,
             description, criteria: string[], sensitive: null | "lgpd" | "sigilo", irreversible: boolean }

ClientView = {
  id, title, area: string|null, createdAt,
  status: { code, label, tone: "neutral"|"progress"|"attention"|"success"|"danger" },
  spent: { usd: number, brl: number|null },
  forecast: { text: string } | null,          // ex.: "Boa chance de ficar pronto em até 2 dias (85%)"
  needsDecision: { question: string, options: { decision, label }[] } | null,
  canAccept: boolean,
  criteria: { text, done: boolean }[]
}

Overview = { deliveredThisMonth, inProgress, waitingYou, spentThisMonth: { usd, brl|null },
             avgDaysToDeliver: number|null, recentDeliveries: { id, title, deliveredAt }[] }

ImportResult = { imported, done, open, skipped: { row, reason }[], calibrationSamples }
```

### Linguagem simples (`src/plain.js`)

Estados → `status`:

| Estado | label | tone |
|---|---|---|
| negotiating | Em definição | neutral |
| agreed | Pronto para começar | neutral |
| building | Em produção | progress |
| delivered | Aguardando sua aprovação | attention |
| escalated | Precisa da sua decisão | attention |
| accepted | Entregue | success |
| rejected | Cancelado | danger |

Motivos de escalonamento viram perguntas (`needsDecision.question`), ex.: orçamento → "O custo previsto passou do orçamento combinado. Quer aprovar mesmo assim, ajustar o pedido ou cancelar?"; irreversível → "Esta entrega mexe em algo que não dá para desfazer. Você autoriza?"; sem acordo → "Não houve acordo sobre o escopo. Quer aprovar a última proposta, rediscutir ou cancelar?"; genérico → "Precisamos da sua decisão: <motivo>".
Previsão: usa o P85 de horas calibrado do contrato (e o já gasto) e escreve em dias úteis de 8h, arredondando para cima ("em até 1 dia", "em até 3 dias"); sem estimativa: `null`.

### Modelos (`src/templates.js`)

Pelo menos 2 por área (10+ no total), por exemplo: RH (onboarding automatizado, relatório de turnover),
finanças (conciliação diária, alerta de risco de posição), saúde (lembrete de consultas, painel de ocupação — `lgpd`),
direito (controle de prazos processuais — `sigilo`, triagem de contratos — `sigilo`), economia (painel de indicadores, relatório de inflação por setor).
Modelos que mexem em dados de produção ou enviam algo a terceiros têm `irreversible: true`.

## Importação de histórico (`src/importers.js`)

`parseCsv(text)` (com aspas, vírgulas e quebras de linha dentro de aspas, BOM) e
`importHistory(store, { format, csv, hoursPerPoint = 4 }, actor)`.

Mapeamento por formato (cabeçalhos reais das exportações; comparar sem diferenciar maiúsculas):
- **jira**: `Summary`, `Status`, `Original Estimate` (segundos), `Time Spent` (segundos), `Story Points`/`Custom field (Story Points)`, `Created`, `Resolved`, `Assignee`, `Issue Type`.
- **linear**: `Title`, `Status`, `Estimate` (pontos), `Created`, `Completed`, `Assignee`, `Labels`.
- **trello**: `Card Name`, `List Name`, `Labels`, `Due Date`, `Last Activity Date` (sem estimativa; só cria trabalho aberto/feito).
- **generic**: `title`, `status` (`done`/`open`), `estimate_hours`, `actual_hours`, `started_at`, `finished_at`, `assignee`, `kind`.

Regras:
- Concluídos (Jira `Done`/`Closed`/`Resolved`, Linear `Done`/`Completed`/`Canceled` só se tiver `Completed`, Trello lista com "done"/"feito"/"concluído", generic `done`) viram contratos **`accepted`** com `proposal.estimate.hours`, `usage.hours` (real), `startedAt`, `acceptedAt`, `assignee`, `delivery: { imported: true, results: {} }`, `source: { type: "import", format }`. Isso alimenta a calibração (`samples` em `src/estimate.js`).
- Estimativa: horas diretas quando houver; senão pontos × `hoursPerPoint`. Real: tempo gasto; sem tempo gasto, diferença entre início e fim em horas úteis (8h/dia útil).
- Abertos viram contratos `negotiating` com o título e, se houver, estimativa.
- Linhas sem título são puladas com motivo. Importar não dispara WIP nem escalonamento.
- `calibrationSamples` = número de contratos importados que têm estimativa e real (> 0).
- Só `human` importa.

## Worker (`worker/`)

- `worker/index.js`: `export default { fetch }` + `export class TenantBoard` (Durable Object).
- `worker/auth.js`:
  - **Humanos**: header `Cf-Access-Jwt-Assertion`; validar JWT RS256 com as chaves de `https://<TEAM_DOMAIN>/cdn-cgi/access/certs` (cache), `aud` = `ACCESS_AUD`, `exp`; e-mail do claim `email`.
  - **Agentes**: `Authorization: Bearer <token>`; SHA-256 do token comparado com `agentTokens` do tenant.
  - Sem credencial válida: 401. E-mail fora de todos os tenants: 403.
  - Integrações assinadas (`/api/integrations/*`, `/api/intake/*`) entram pelo tenant em `/t/<tenant>/api/...` e continuam validadas por assinatura/token próprio.
- `wrangler.toml`: Worker + Durable Object `TenantBoard` (migração `new_sqlite_classes`), `compatibility_flags = ["nodejs_compat"]`, assets `public/`.
- Páginas: `/` → `public/landing.html` (pública), `/portal` → `public/portal.html` (exige login), `/board` → `public/index.html` (time técnico).

## Telas

- `public/landing.html`: apresentação pública. Proposta em uma frase, como funciona em 3 passos ("Você pede", "Agentes fazem", "Você decide só o que importa"), seções por área com exemplos dos modelos, botão "Entrar".
- `public/portal.html`: início com o `Overview`; lista de pedidos com status colorido por `tone`; "Novo pedido" (escolher modelo ou texto livre, revisar critérios editáveis, orçamento em R$); detalhe com linha do tempo, previsão, critérios marcados e botões de decisão/aceite; aba "Importar histórico" com upload de CSV. Responsivo, tema claro e escuro, sem bibliotecas externas.

## Critérios de pronto

- `npm test` verde, com testes novos para `app`, `plain`, `templates`, `importers`, `auth`.
- `node src/server.js` continua funcionando localmente com todas as rotas atuais.
- `wrangler deploy --dry-run` sem erro (se `wrangler` disponível).
- README com o passo a passo de deploy na Cloudflare e da importação.
