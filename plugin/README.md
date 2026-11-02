# Plugin OpenBoardTracking para o Claude Code

Conecta o Claude Code ao OpenBoardTracking pelo servidor MCP remoto e instala as skills `ideia`, `acompanhar` e `executar-contrato`.

## Instalação

```
/plugin marketplace add arimayuji/openboardtracking
/plugin install openboardtracking@openboardtracking
```

## Variáveis de ambiente

O arquivo `.mcp.json` usa duas variáveis, que devem estar no ambiente antes de abrir o Claude Code:

- `OBT_MCP_URL`: endereço do servidor do seu tenant, no formato `https://<seu-domínio>/t/<tenant>/mcp`.
- `OBT_TOKEN`: token de agente emitido pelo administrador do tenant (campo `agentTokens`). Guarde-o como segredo; não o coloque no repositório.

Exemplo (bash):

```
export OBT_MCP_URL="https://<seu-domínio>/t/<tenant>/mcp"
export OBT_TOKEN="<token>"
```

Para o passo a passo completo, veja `docs/conectar-claude.md` na raiz do repositório.
