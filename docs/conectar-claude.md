# Conectar o Claude ao OpenBoardTracking

Você usa o **seu próprio plano** do Claude (claude.ai ou Claude Code) para operar o OpenBoardTracking. A plataforma funciona como uma ferramenta conectada ao seu Claude: ela nunca pede, nem guarda, sua senha ou chave da Anthropic.

> Os nomes dos menus do claude.ai podem mudar um pouco com o tempo. Se algo não estiver igual, procure termos parecidos.

## Parte 1: Pessoas do cliente (claude.ai)

### 1. Adicionar o conector

1. No claude.ai, abra **Configurações → Conectores**.
2. Clique em **Adicionar conector personalizado**.
3. Informe a URL: `https://<seu-domínio>/mcp`
4. Faça login com o seu e-mail corporativo, quando for pedido.
5. Clique em **Permitir** para autorizar o Claude a usar o OpenBoardTracking em seu nome.

### 2. Enviar as skills

As skills ensinam o Claude a criar pedidos e acompanhá-los com boas perguntas. Envie as duas da pasta `skills-claude-ai/`:

1. Compacte cada pasta (`ideia` e `acompanhar`) em um arquivo `.zip`.
2. No claude.ai, abra **Configurações → Capacidades** (ou **Skills**).
3. Envie cada `.zip` e ative as skills.

### 3. Exemplos de conversa

- "Quero um relatório de turnover por área."
- "Como estão meus pedidos?"
- "Aprova a entrega do pedido X."

O Claude vai pedir confirmação antes de criar, aprovar ou pedir ajustes em qualquer pedido.

## Parte 2: Time de desenvolvimento (Claude Code)

Há duas formas. Ambas usam um token de agente emitido pelo administrador do tenant (campo `agentTokens` da configuração).

### Opção A: comando direto

```
claude mcp add --transport http openboardtracking https://<seu-domínio>/t/<tenant>/mcp --header "Authorization: Bearer <token>"
```

### Opção B: plugin

```
/plugin marketplace add arimayuji/openboardtracking
/plugin install openboardtracking@openboardtracking
```

Antes de abrir o Claude Code, defina as variáveis `OBT_MCP_URL` (a URL `https://<seu-domínio>/t/<tenant>/mcp`) e `OBT_TOKEN` (o token). Detalhes em `plugin/README.md`.

Depois de conectar, o plugin traz as skills `ideia`, `acompanhar` e `executar-contrato`.

## Parte 3: Administrador

A configuração de tenants fica no segredo `TENANTS`, em JSON. Para cada tenant:

- `members`: e-mails exatos ou domínios (ex.: `@acme.com`) que acessam o portal do cliente.
- `admins`: e-mails exatos com acesso à API completa do tenant.
- `devs`: e-mails exatos do time de desenvolvimento. Entram no MCP com o papel de dev.
- `agentTokens`: tokens de agente, guardados apenas como hash SHA-256. Emita um token por pessoa ou por agente e troque quando necessário.

Após alterar o segredo, confirme que a pessoa consegue listar os modelos e os pedidos pelo conector.

## Parte 4: Perguntas frequentes

**Quanto custa?** A plataforma não cobra uso de IA separadamente. O uso do Claude acontece no seu plano atual.

**Quão seguro é?** Tokens são guardados apenas como hash. Os dados de cada cliente ficam isolados em um espaço próprio, sem acesso cruzado entre tenants.

**Não uso Claude. Como faço?** Use o portal web do OpenBoardTracking, pelo botão "Entrar" da página inicial. Todas as ações do Claude estão disponíveis lá também.
