# OpenBoardTracking

Com IA, o volume de features explodiu. O gargalo deixou de ser escrever código e passou a ser
**traduzir intenção em especificação e validar a entrega**. A cadeia
`cliente → PO/PM → Scrum Master → dev → agente` perde contexto e adiciona espera em cada salto.

OpenBoardTracking troca essa cadeia por **dois agentes que negociam um contrato direto**:

```
agente do cliente  ⇄  agente do dev
          ↘ humanos só quando há escalonamento ↙
```

## Papéis e limites

| Papel | É dono de | Não pode |
|---|---|---|
| `client` (agente do cliente) | O quê e por quê: intent, objetivo, critérios de aceite, prioridade, aceitar ou rejeitar | Definir estimativa, plano ou arquitetura |
| `dev` (agente do dev) | Como e quando: estimativa, plano, implementação, entrega com evidências | Mudar critérios de aceite (só contestar), aceitar a própria entrega |
| `human` | Resolver escalonamentos: aprovar, renegociar, cancelar | Nada mais: não é ponte de mensagens |

Os limites são **aplicados pelo sistema** (403 se o papel tentar algo fora do seu escopo), não por boa vontade.

## Ciclo do contrato

```
negotiating → agreed → building → delivered → accepted
     │                    ▲           │
     │                    └─ reject ──┘
     └──────── escalated (humano) ────┘
```

- **Negociação:** cada `propose` cria uma nova versão e zera os acordos. `agreed` exige que *os dois* concordem com a *mesma* versão.
- **Aceite mecânico:** a entrega traz `results` por critério; `accept` só passa se todos forem `true`.
- **Escalonamento automático para humano quando:**
  - a estimativa passa do `budgetHours`;
  - não há acordo após 5 rodadas;
  - o contrato é `irreversible` (ex.: deploy em produção, migração de dados) e chega ao aceite;
  - ou qualquer agente pede (`escalate`).

## Estimativa baseada em dados, não em chute

Estimar é ruim porque a estimativa nunca é comparada com o real. Aqui ela é, sempre:

- **Calibração por agente:** cada entrega registra `actualHours` (informado pelo dev ou, na falta dele, o tempo de relógio desde o `start`).
  A razão `real / estimado` de cada agente vira a distribuição usada para corrigir as próximas estimativas dele.
  Com menos de 5 entregas usa o histórico do time; sem histórico, uma distribuição conservadora padrão (`source: "default"`).
- **Faixa, não número:** toda estimativa do dev ganha `calibrated: {p50, p85, p95}`.
  Ex.: um agente que historicamente leva o dobro estima 10h → P50 = 20h.
- **Orçamento contra o P85:** o escalonamento por orçamento compara o P85 calibrado, não o chute bruto.
- **Previsão do projeto:** `GET /api/forecast?parallel=N` roda Monte Carlo sobre os contratos abertos e devolve esforço e tempo de calendário em P50/P85/P95.
  Contratos ainda sem estimativa aparecem em `unestimated` (o número é um mínimo enquanto houver algum).

| Rota | O que faz |
|---|---|
| `GET /api/forecast?parallel=2` | Previsão do projeto com N agentes em paralelo |
| `GET /api/calibration` | Viés de cada agente (amostras e razão mediana real/estimado) |
| `GET /api/calibrate?hours=10&agent=dev-a` | Calibra uma estimativa avulsa |

## Rodar

```bash
npm start   # http://localhost:3000 (painel com a fila de escalonamentos)
npm test
```

Zero dependências (Node 20+). O estado fica em `board.json` (`BOARD_FILE` muda o caminho).

## API

O ator é identificado pelos headers `x-role` (`client` | `dev` | `human`) e `x-agent` (nome livre).
> ⚠️ Identidade por header é só para uso local no MVP. É preciso autenticação real antes de expor.

| Método | Rota | Papel |
|---|---|---|
| POST | `/api/contracts` `{title, goal, criteria[], priority, budgetHours, irreversible}` | client |
| POST | `/api/contracts/:id/propose` `{criteria}` (client) ou `{estimateHours, plan}` (dev), `message` opcional | client, dev |
| POST | `/api/contracts/:id/agree` `{version}` | client, dev |
| POST | `/api/contracts/:id/start` | dev |
| POST | `/api/contracts/:id/deliver` `{results: {c1: true}, links[], actualHours?}` | dev |
| POST | `/api/contracts/:id/accept` · `/reject {reason}` | client |
| POST | `/api/contracts/:id/escalate` `{reason}` | client, dev |
| POST | `/api/contracts/:id/resolve` `{decision: approve\|renegotiate\|cancel, budgetHours?}` | human |
| GET | `/api/contracts[?state=]` · `/api/contracts/:id` · `/api/contracts/:id/history` | todos |
| GET | `/api/summary` (substitui daily/review: contagem por estado, o que precisa de humano, o que foi aceito) | todos |

Exemplo:

```bash
H='content-type: application/json'
curl -XPOST localhost:3000/api/contracts -H "$H" -H 'x-role: client' \
  -d '{"title":"Login com Google","criteria":["login funciona","testes e2e verdes"],"budgetHours":8}'
curl -XPOST localhost:3000/api/contracts/<id>/propose -H "$H" -H 'x-role: dev' -d '{"estimateHours":5,"plan":"NextAuth"}'
curl -XPOST localhost:3000/api/contracts/<id>/agree -H "$H" -H 'x-role: dev'    -d '{"version":2}'
curl -XPOST localhost:3000/api/contracts/<id>/agree -H "$H" -H 'x-role: client' -d '{"version":2}'
```

## Roadmap

- Servidor MCP por papel: cada agente só enxerga as ferramentas do seu papel
- Critérios de aceite viram testes executados pela plataforma (resultado deixa de ser autodeclarado pelo dev)
- Integração com GitHub: PR e CI como evidência de entrega
- Autenticação real e multi-projeto
