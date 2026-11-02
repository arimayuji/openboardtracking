# OpenBoardTracking

**Gestão de software para a era em que agentes escrevem o código.**

## Manifesto

Scrum e Kanban pavimentaram o setor. Foram feitos para um mundo em que o recurso escasso era
a hora de uma pessoa e a comunicação entre pessoas era o único canal. Por isso giram em torno
de cerimônias, papéis intermediários e estimativas feitas no chute.

Esse mundo acabou. Com IA, o volume de features explodiu e o gargalo mudou de lugar:

- **O gargalo não é escrever código.** É traduzir intenção em critérios verificáveis e validar a entrega.
- **O recurso escasso não é só tempo.** É tempo, tokens e dinheiro, consumidos continuamente.
- **A cadeia `cliente → PO/PM → Scrum Master → dev → agente` é perda.** Cada salto entre pessoas tira contexto e adiciona espera.

Então não adaptamos Scrum para IA. Traduzimos o que ele tentava resolver para a realidade atual:

| O que existia | Por que existia | O que fica no lugar |
|---|---|---|
| PO / PM | Traduzir a vontade do cliente | **Agente do cliente**: escreve intents com critérios verificáveis |
| Scrum Master | Garantir que o processo seja seguido | **Regras aplicadas pelo sistema**: cada papel só faz o que é dele |
| Sprint | Criar um ritmo de entrega | **Fluxo contínuo de contratos**: entra, negocia, executa, é aceito |
| Planning poker / story points | Estimar esforço | **Estimativa calibrada pelo histórico** em horas, tokens e custo, sempre em faixa (P50/P85/P95) |
| Daily | Saber quem está fazendo o quê | **Telemetria**: cada agente reporta consumo e progresso enquanto trabalha |
| Velocity | Medir capacidade | **Custo por entrega aceita** e consumo real contra orçamento |
| Review / aceite subjetivo | Decidir se está pronto | **Aceite mecânico**: todos os critérios precisam passar |
| Escalar para o chefe | Desbloquear decisões | **Escalonamento explícito para humano**, só quando a regra manda |

Humanos não somem. Eles deixam de ser ponte e passam a ser **quem decide nas exceções**.

## Modelo

```
agente do cliente  ⇄  agente do dev
          ↘ humanos só quando há escalonamento ↙
```

### Papéis e limites

| Papel | É dono de | Não pode |
|---|---|---|
| `client` | O quê, por quê e quanto vale: intent, critérios, prioridade, orçamento, aceite | Definir estimativa, plano ou arquitetura |
| `dev` | Como e quanto custa: estimativa, plano, execução, consumo reportado, entrega com evidências | Mudar critérios de aceite (só contestar), aceitar a própria entrega |
| `human` | Resolver escalonamentos: aprovar, renegociar, cancelar, aumentar orçamento | Nada mais: não é ponte de mensagens |

Os limites são **aplicados pelo sistema** (403 se o papel tentar algo fora do seu escopo).

### Ciclo do contrato

```
negotiating → agreed → building → delivered → accepted
     │                    ▲           │
     │                    └─ reject ──┘
     └──────── escalated (humano) ────┘
```

- **Negociação:** cada `propose` cria uma nova versão e zera os acordos. `agreed` exige que os dois concordem com a mesma versão.
- **Aceite mecânico:** a entrega traz `results` por critério; `accept` só passa se todos forem `true`.
- **Escalonamento automático para humano quando:**
  - o P85 calibrado de qualquer métrica passa do orçamento (antes de começar);
  - o consumo real passa do orçamento (durante a execução, no momento em que acontece);
  - não há acordo após 5 rodadas;
  - o contrato é `irreversible` (ex.: deploy em produção, migração de dados) e chega ao aceite;
  - ou qualquer agente pede.

## Consumo: horas, tokens e custo

O agente do dev reporta incrementos de consumo enquanto trabalha:

```json
POST /api/contracts/:id/usage
{ "hours": 0.5, "tokensIn": 50000, "tokensOut": 12000, "costUsd": 1.8, "model": "<id do modelo>", "toolCalls": 14 }
```

O contrato acumula totais e a quebra por modelo (`usage.byModel`). Se nenhuma hora for informada até a entrega,
usa o tempo de relógio desde o `start`.

## Estimativa baseada em dados

- **Estimativa em três métricas:** o dev propõe `estimate: { hours, tokens, costUsd }` (qualquer subconjunto).
- **Calibração por agente e por métrica:** a razão `real / estimado` de cada agente corrige as próximas estimativas dele.
  Um agente pode acertar horas e errar tokens por 3x; cada métrica é calibrada separadamente.
  Com menos de 5 entregas usa o histórico do time; sem histórico, uma distribuição conservadora (`source: "default"`).
- **Faixa, não número:** toda estimativa ganha `calibrated.{metric}.{p50, p85, p95}`.
- **Previsão do projeto:** `GET /api/forecast?parallel=N` roda Monte Carlo sobre os contratos abertos,
  desconta o que já foi gasto e devolve quanto falta consumir por métrica, além do tempo de calendário com N agentes em paralelo.
  Contratos sem estimativa aparecem em `unestimated` (o número é um mínimo enquanto houver algum).

## Rodar

```bash
npm start   # http://localhost:3000 (painel com contratos, consumo, previsão e escalonamentos)
npm test
```

Zero dependências (Node 20+). O estado fica em `board.json` (`BOARD_FILE` muda o caminho).

## API

O ator é identificado pelos headers `x-role` (`client` | `dev` | `human`) e `x-agent` (nome livre).
> ⚠️ Identidade por header é só para uso local no MVP. É preciso autenticação real antes de expor.

| Método | Rota | Papel |
|---|---|---|
| POST | `/api/contracts` `{title, goal, criteria[], priority, budget: {hours?, tokens?, costUsd?}, irreversible}` | client |
| POST | `/api/contracts/:id/propose` `{criteria}` (client) ou `{estimate: {hours?, tokens?, costUsd?}, plan}` (dev), `message` opcional | client, dev |
| POST | `/api/contracts/:id/agree` `{version}` | client, dev |
| POST | `/api/contracts/:id/start` | dev |
| POST | `/api/contracts/:id/usage` `{hours, tokensIn, tokensOut, tokens, costUsd, model, toolCalls}` | dev |
| POST | `/api/contracts/:id/deliver` `{results: {c1: true}, links[], usage?}` | dev |
| POST | `/api/contracts/:id/accept` · `/reject {reason}` | client |
| POST | `/api/contracts/:id/escalate` `{reason}` | client, dev |
| POST | `/api/contracts/:id/resolve` `{decision: approve\|renegotiate\|cancel, budget?}` | human |
| GET | `/api/contracts[?state=]` · `/api/contracts/:id` · `/api/contracts/:id/history` | todos |
| GET | `/api/summary` (estados, o que precisa de humano, consumo na janela, custo por entrega aceita) | todos |
| GET | `/api/forecast?parallel=2` | todos |
| GET | `/api/calibration` (viés de cada agente por métrica) | todos |
| GET | `/api/calibrate?hours=10&tokens=200000&agent=dev-a` | todos |

## Roadmap

- Servidor MCP por papel: cada agente só enxerga as ferramentas do seu papel
- Critérios de aceite viram testes executados pela plataforma (resultado deixa de ser autodeclarado)
- Consumo coletado direto da API do provedor de modelo, sem depender do que o agente reporta
- Calibração por tipo de trabalho (tags), não só por agente
- Integração com GitHub: PR e CI como evidência de entrega
- Autenticação real e multi-projeto
