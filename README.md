# OpenBoardTracking

Kanban **AI-native** para times de desenvolvimento em que agentes de IA e humanos trabalham juntos.
Sem PM, sem PO, sem Scrum Master, sem cerimônias: o fluxo se organiza sozinho e os "rituais" são gerados a partir dos eventos.

| Ritual tradicional | Aqui |
|---|---|
| Daily standup | `GET /api/standup`: resumo automático por ator (humano ou agente) |
| Sprint planning | Fila `ready` priorizada + `POST /api/claim` (o agente puxa a próxima tarefa) |
| Sprint review / velocity | `GET /api/metrics`: throughput e cycle time reais |
| Scrum Master cobrando status | Log de eventos + limites de WIP aplicados pelo sistema |

## Rodar
```bash
npm start   # http://localhost:3000
npm test
```
Zero dependências (Node 20+). O estado fica em `board.json` (`BOARD_FILE` muda o caminho).

## API para agentes
Identifique o ator com o header `x-actor` (ex.: `x-actor: claude-agent-1`).

```bash
curl -XPOST localhost:3000/api/tasks -H 'content-type: application/json' -d '{"title":"Implementar login","priority":1}'
curl -XPOST localhost:3000/api/tasks/<id>/move -d '{"column":"ready"}'
curl -XPOST localhost:3000/api/claim -H 'x-actor: agent-1'
curl -XPOST localhost:3000/api/tasks/<id>/notes -H 'x-actor: agent-1' -d '{"text":"PR aberto"}'
curl localhost:3000/api/standup
```

Colunas: `backlog → ready → doing → review → done` (WIP: doing=3, review=3).

## Roadmap
- Integração com GitHub (PR mergeado move o card para `done`)
- Servidor MCP para agentes usarem o board como ferramenta
- Quebra automática de épicos em tarefas via LLM
- Detecção de tarefas paradas e reatribuição automática
