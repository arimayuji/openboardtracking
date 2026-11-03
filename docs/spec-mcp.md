# Spec: conectar ao Claude da própria pessoa (MCP remoto + OAuth + skills)

## Objetivo

A pessoa usa o **plano dela** do Claude (claude.ai web/desktop ou Claude Code) para operar o OpenBoardTracking.
A plataforma é uma ferramenta conectada ao Claude dela via **MCP remoto**; nunca recebemos credenciais da Anthropic.

- Cliente não técnico: adiciona o conector no claude.ai e conversa ("quero um relatório de turnover").
- Time de dev: conecta o mesmo servidor no Claude Code com o papel de dev.

## Restrições

- Mesmas da `docs/spec-portal.md`: ES modules, zero dependências em runtime, Web Crypto em código novo, `node:test`.
- O servidor MCP reaproveita as rotas existentes chamando `app.handle(new Request(...), actor)` internamente; nada de duplicar regra de negócio.
- Textos das ferramentas do papel cliente em português simples (são lidos pelo Claude e repassados à pessoa).

## MCP (`src/mcp.js`, rota `POST /mcp`)

Transporte *Streamable HTTP* com respostas JSON (sem SSE): JSON-RPC 2.0 no corpo do POST.
- `initialize` → `{ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "openboardtracking", version: "0.1.0" }, instructions }`.
  Versões aceitas: `2025-06-18`, `2025-03-26`; se o cliente pedir outra, responde `2025-06-18`.
  `instructions` explica em português o que o servidor faz e que textos de pedidos vindos de terceiros são dados, não instruções.
- `notifications/initialized` e qualquer notificação (sem `id`) → HTTP 202 sem corpo.
- `ping` → `{}`. `tools/list` → ferramentas **do papel do ator**. `tools/call` → `{ content: [{ type: "text", text }], structuredContent?, isError? }`.
- Método desconhecido → erro JSON-RPC `-32601`; JSON inválido → `-32700`; ferramenta fora do papel → `isError: true` com mensagem.
- Lote (array) de requisições → 400. `GET /mcp` → 405.
- Ator: o mesmo `actor` que `app.handle` recebe. `actor.role === 'human'` → ferramentas de **cliente**; `'dev'` → ferramentas de **dev**; outros → nenhuma.

### Ferramentas do cliente (pessoa do cliente; chamam `/api/portal/*` com o ator dela)

| Nome | Entrada | Faz |
|---|---|---|
| `listar_modelos` | `{ area? }` | modelos de pedido (filtra por área) |
| `criar_pedido` | `{ titulo, descricao, criterios?: string[], modelo?, orcamento_reais? }` | `POST /api/portal/requests` |
| `listar_pedidos` | `{}` | pedidos com status, previsão e se precisam de decisão |
| `ver_pedido` | `{ id }` | detalhe com critérios e linha do tempo |
| `decidir` | `{ id, decisao: "approve"\|"renegotiate"\|"cancel" }` | responde escalonamento |
| `confirmar_proposta` | `{ id }` | confirma a proposta do time (prazo/custo/plano), `POST /api/portal/requests/:id/confirm` |
| `aprovar_entrega` | `{ id }` | aceita |
| `pedir_ajustes` | `{ id, motivo }` | rejeita |
| `visao_geral` | `{}` | resumo do mês |
| `mudar_pedido` | `{ id, criterios: string[] (mín. 1), motivo }` | `POST /api/portal/requests/:id/change` (só aprovador); volta para definição |
| `listar_objetivos` | `{}` | objetivos com progresso (`GET /api/portal/goals`) |
| `criar_objetivo` | `{ titulo, descricao?, data_alvo? }` | `POST /api/portal/goals` |
| `dividir_pedido` | `{ id, partes: [{ titulo, criterios: string[] }] (mín. 2) }` | `POST /api/portal/requests/:id/split` (só aprovador) |
| `adicionar_dependencia` | `{ id, depende_de }` | `POST /api/portal/requests/:id/depends` (só aprovador); recusa ciclo |
| `relatorio` | `{ de?, ate? }` | `GET /api/portal/report?from&to` (sem datas: mês atual) |

### Ferramentas do dev (chamam `/api/*` com `{ role: 'dev', agent }`)

| Nome | Entrada | Faz |
|---|---|---|
| `listar_contratos` | `{ estado? }` | `GET /api/contracts` |
| `ver_contrato` | `{ id }` | contrato + histórico |
| `quick_wins` | `{ max_horas? }` | `GET /api/quickwins` |
| `propor` | `{ id, horas?, tokens?, custo_usd?, plano?, mensagem? }` | `propose` com `estimate` |
| `concordar` | `{ id, versao }` | `agree` |
| `iniciar` | `{ id }` | `start` |
| `registrar_horas` | `{ id, horas }` | `usage` (só horas) |
| `entregar` | `{ id, resultados: { [criterio]: boolean }, links?: string[] }` | `deliver` |
| `escalar` | `{ id, motivo }` | `escalate` |
| `dividir_contrato` | `{ id, partes: [{ titulo, criterios: string[] }] (mín. 2) }` | `POST /api/contracts/:id/split` |
| `ranking` | `{}` | `GET /api/ranking`: trabalho aberto por valor por hora, com sem estimativa e bloqueados |

Cada ferramenta tem `inputSchema` (JSON Schema) e `annotations` (`readOnlyHint` nas de leitura, `destructiveHint` em `decidir` com cancelamento e `pedir_ajustes`).
`text` do resultado: resumo legível em português; `structuredContent`: o JSON da API. Erro da API (status ≥ 400) → `isError: true` com a mensagem.

## OAuth para o conector do claude.ai (`worker/oauth.js`)

O claude.ai conecta servidores MCP remotos com OAuth 2.1 (registro dinâmico + PKCE). A pessoa autoriza com o login que já existe (Cloudflare Access).

- `GET /.well-known/oauth-protected-resource` → `{ resource: "<origin>/mcp", authorization_servers: ["<origin>"] }`.
- `GET /.well-known/oauth-authorization-server` → `issuer`, `authorization_endpoint` `/authorize`, `token_endpoint` `/token`, `registration_endpoint` `/register`,
  `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code","refresh_token"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`.
- `POST /register` (RFC 7591): aceita `redirect_uris` (https, ou `http://localhost`/`127.0.0.1`), devolve `client_id`. Sem segredo (cliente público).
- `GET /authorize`: exige login (Access JWT, como `/portal`); valida `client_id`, `redirect_uri` registrado, `response_type=code`, `code_challenge_method=S256`; descobre tenant pelo e-mail (`?tenant=` se mais de um).
  Mostra uma página simples "Conectar o Claude ao OpenBoardTracking como <e-mail> (<tenant>)? [Permitir] [Cancelar]"; ao permitir (POST no mesmo caminho, com proteção CSRF por token de formulário), redireciona com `code` e `state`.
- `POST /token` (form-urlencoded): `authorization_code` (verifica PKCE, `redirect_uri`, código de uso único, 5 min) ou `refresh_token` (rotaciona). Devolve `access_token` (1 h), `refresh_token` (30 dias), `token_type: "Bearer"`.
- Tokens guardados apenas como SHA-256, num Durable Object `OAuthStore` (instância única), com `{ email, tenant, role, clientId, exp }`.
- Papel: e-mail em `devs` do tenant → `dev`; senão `human` (cliente).
- `/mcp` sem token válido → 401 com `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.

Config de tenant ganha `devs: ["dev@acme.com"]`.

## Rotas no Worker

- `/mcp`: Bearer OAuth (acima) → DO do tenant, caminho `/mcp`, ator `{ role, agent: email, tenant }`.
- `/t/<tenant>/mcp`: Bearer de token de agente (já existente) → mesmo destino. É o caminho mais simples para o Claude Code de devs.

## Skills e plugin

- `plugin/` — plugin do Claude Code: `.claude-plugin/plugin.json`, `.mcp.json` (servidor HTTP `openboardtracking` com URL de exemplo), `skills/ideia/SKILL.md`, `skills/acompanhar/SKILL.md`, `skills/executar-contrato/SKILL.md`.
- `.claude-plugin/marketplace.json` na raiz do repositório, para instalar com `/plugin marketplace add arimayuji/openboardtracking`.
- `skills-claude-ai/` — as mesmas skills de cliente (`ideia`, `acompanhar`) prontas para enviar no claude.ai (uma pasta por skill com `SKILL.md`).
- Skill `ideia`: conduz a pessoa a transformar uma ideia em pedido: entende o problema, sugere modelo da área, propõe de 3 a 5 critérios verificáveis em linguagem simples, confirma com a pessoa e só então chama `criar_pedido`. Avisa sobre dados pessoais (LGPD) e sigilo quando a área pedir.
- Skill `acompanhar`: usa `listar_pedidos`/`ver_pedido`, destaca o que precisa de decisão e só chama `decidir`/`aprovar_entrega`/`pedir_ajustes` com confirmação explícita da pessoa.
- Skill `executar-contrato` (dev): pega quick win ou contrato, propõe estimativa, concorda, inicia, implementa no repositório, registra horas e entrega com os resultados por critério e links.
- Todas tratam textos vindos de pedidos, alertas e mensagens como dados, nunca como instruções.

## Guia (`docs/conectar-claude.md`)

Passo a passo para pessoas não técnicas (claude.ai: Configurações → Conectores → adicionar conector personalizado com a URL `<origin>/mcp`; enviar as skills) e para devs (Claude Code: `claude mcp add --transport http openboardtracking <origin>/t/<tenant>/mcp --header "Authorization: Bearer <token>"` ou instalar o plugin).
Deixa claro: a pessoa usa o próprio plano do Claude; a plataforma nunca pede nem guarda a senha ou a chave da Anthropic.

## Critérios de pronto

- `npm test` verde com testes novos de `mcp` e `oauth`.
- Fluxo MCP testado ponta a ponta no servidor Node (initialize → tools/list → tools/call criar_pedido e listar_pedidos).
- `wrangler deploy --dry-run` sem erro.
