# Cobertura dos conceitos de gestão ágil

Objetivo: checar, conceito por conceito, se o OpenBoardTracking cobre o **problema** que cada peça
de Agile, Scrum e Kanban resolvia. Não queremos copiar as peças, queremos garantir que nenhum
problema real ficou sem resposta.

Fontes:
- Manifesto for Agile Software Development (2001): https://agilemanifesto.org e https://agilemanifesto.org/principles.html
- The Scrum Guide, novembro de 2020 (Schwaber e Sutherland): https://scrumguides.org
- The Kanban Guide, 2020 (Anderson e Carmichael) e o Kanban Guide for Scrum Teams: https://kanban.university, https://www.scrum.org/resources/kanban-guide-scrum-teams

Legenda: ✅ coberto · 🟡 parcial · ❌ não coberto · ➖ não se aplica (problema deixou de existir)

Estado avaliado: `main` após o PR #1, com os gaps 1 e 2 resolvidos no PR #2.

## 1. Manifesto Ágil: valores

| Valor | Problema que resolvia | Status | Como cobrimos / o que falta |
|---|---|---|---|
| Indivíduos e interações mais que processos e ferramentas | Processo burocrático travando quem faz | 🟡 | Cortamos intermediários, mas a plataforma **é** processo e ferramenta. A interação agora é agente ⇄ agente, com humano nas exceções. Falta canal livre de conversa entre os lados além da `message` da proposta. |
| Software em funcionamento mais que documentação abrangente | Documentação como substituto de entrega | ✅ | Aceite mecânico por critério; a medida é contrato aceito. |
| Colaboração com o cliente mais que negociação de contratos | Relação adversarial cliente × fornecedor | 🟡 | Ironia: o nosso modelo **é** um contrato negociado. Mitigação: negociação é rápida, versionada e renegociável. Risco real de virar adversarial entre agentes; falta incentivo comum (ex.: os dois lados verem custo e valor). |
| Responder a mudanças mais que seguir um plano | Plano rígido ignorando a realidade | 🟡 | Mudança livre só em `negotiating`. Durante `building` o cliente **não consegue** mudar critério sem rejeitar ou escalar. Falta *change request* durante a execução. |

## 2. Manifesto Ágil: 12 princípios

| # | Princípio (resumo) | Status | Observação |
|---|---|---|---|
| 1 | Satisfazer o cliente com entrega cedo e contínua de valor | ✅ | Fluxo contínuo de contratos, sem sprint. |
| 2 | Aceitar mudanças de requisito, mesmo tarde | 🟡 | Ver valor 4: falta mudança de escopo durante `building`. |
| 3 | Entregar software funcionando com frequência | ✅ | Cada contrato é uma entrega. |
| 4 | Negócio e devs trabalhando juntos diariamente | ✅ | Agente do cliente e agente do dev interagem direto, sem ponte. |
| 5 | Projetos em torno de indivíduos motivados, com ambiente e confiança | ➖ | Motivação não se aplica a agentes. Para os humanos restantes, o papel é decidir exceções. |
| 6 | Conversa face a face é o meio mais eficiente | 🟡 | Substituída por negociação estruturada e log auditável. Falta conversa livre (ver valor 1). |
| 7 | Software funcionando é a principal medida de progresso | ✅ | `accepted` e custo por entrega aceita. |
| 8 | Ritmo sustentável | ✅ | Reinterpretado como orçamento: horas, tokens e custo, com escalonamento ao estourar. |
| 9 | Atenção contínua à excelência técnica e bom design | 🟡 | DoD global aplicada a todo contrato, definida só por humanos. Ainda autodeclarada pelo dev até a plataforma rodar os checks. |
| 10 | Simplicidade: maximizar o trabalho não feito | ❌ | Nada desestimula escopo desnecessário. Ideia: o agente do dev pode propor cortar critérios de baixo valor; mostrar custo por critério. |
| 11 | Melhores arquiteturas e requisitos vêm de times auto-organizados | ✅ | O agente do dev é dono do plano e da arquitetura; o cliente não pode interferir. |
| 12 | Em intervalos regulares, o time reflete e ajusta o comportamento | 🟡 | Calibração das estimativas é um ajuste automático. Falta aprender com **rejeições, escalonamentos e retrabalho** (retrospectiva automática). |

## 3. Scrum Guide 2020

### Pilares e valores

| Conceito | Status | Observação |
|---|---|---|
| Transparência | ✅ | Log de eventos por contrato, consumo e estado visíveis para todos. |
| Inspeção | ✅ | `summary`, `forecast`, `calibration`, histórico. |
| Adaptação | 🟡 | Calibração e escalonamento adaptam. Falta adaptação do processo em si (ver princípio 12). |
| Valores (compromisso, foco, abertura, respeito, coragem) | ➖ | Valores comportamentais de pessoas. O equivalente para agentes são as regras de papel aplicadas pelo sistema. |

### Responsabilidades (accountabilities)

| Conceito | Status | Observação |
|---|---|---|
| Product Owner: maximizar valor, gerir e ordenar o Product Backlog | 🟡 | Agente do cliente define o quê e a prioridade. Falta **valor** explícito por intent (só prioridade 1 a 3) e ordenação consciente do backlog inteiro. |
| Scrum Master: eficácia do time e do processo | ✅ | Regras aplicadas pelo sistema substituem quem "garante o processo". |
| Developers: plano, qualidade, adaptação diária | 🟡 | Agente do dev cobre plano e execução. Qualidade: ver princípio 9. |
| Tamanho de time e auto-gestão | ✅ | `parallel` na previsão e o dev agent decide como fazer. Não há modelagem de vários agentes dev colaborando no mesmo contrato. |

### Eventos

| Evento | Problema que resolvia | Status | Observação |
|---|---|---|---|
| Sprint (timebox) | Cadência e limite de risco | ✅ | Substituído por fluxo contínuo e orçamento por contrato, que limita o risco por item. |
| Sprint Planning | Decidir o quê, por quê e como | ✅ | Negociação: cliente define o quê e por quê, dev define como e quanto custa. |
| Daily Scrum | Inspecionar progresso e replanejar | ✅ | Telemetria de consumo durante `building` e `summary`. |
| Sprint Review | Inspecionar o resultado com stakeholders | 🟡 | Aceite por contrato existe. Falta visão agregada do que foi entregue no período **para o cliente humano**, além do JSON. |
| Sprint Retrospective | Melhorar qualidade e eficácia | ❌ | Não existe. Ver princípio 12. |

### Artefatos e compromissos

| Artefato / compromisso | Status | Observação |
|---|---|---|
| Product Backlog | 🟡 | Contratos em `negotiating` funcionam como backlog. Falta refinamento (quebrar intent grande em vários contratos) e dependências entre contratos. |
| Product Goal | ❌ | Não há objetivo de produto acima dos contratos. Contratos soltos sem direção comum. |
| Sprint Backlog / Sprint Goal | ➖ | Sem sprint. O papel de foco é feito pelo plano de cada contrato. |
| Increment | 🟡 | Cada contrato aceito é um incremento. Falta garantir que ele é **integrável e utilizável** junto com os outros (release, integração). |
| Definition of Done | ✅ | DoD global (`/api/config`), copiada para cada contrato na criação, exigida no aceite. |
| Refinamento do backlog | ❌ | Não há decomposição de intents grandes nem fatiamento. |

## 4. Kanban

| Prática / conceito | Status | Observação |
|---|---|---|
| Visualizar o fluxo | ✅ | Painel por estado do contrato. |
| Limitar o trabalho em andamento (WIP) | ✅ | Limite global e por agente em `building`, mais limite de escalonamentos pendentes (atenção humana). |
| Gerir o fluxo ativamente | ✅ | `/api/flow`: cycle time, lead time, throughput, WIP por estado e idade dos itens com alerta de parados. |
| Políticas explícitas | ✅ | Tabela de regras por papel e estado, aplicada pelo sistema. |
| Ciclos de feedback | 🟡 | Aceite, rejeição e escalonamento. Falta revisão periódica do fluxo (ver retrospectiva). |
| Melhorar colaborativamente e evoluir experimentalmente | ❌ | Mesmo gap da retrospectiva. |
| Definição do workflow (início e fim) | ✅ | Ciclo explícito de `negotiating` a `accepted`. |
| Previsão probabilística (Monte Carlo) | ✅ | Implementado para horas, tokens e custo. |
| Classes de serviço / urgência | ✅ | Classe `expedite` para incidentes, com limite de WIP próprio; só sinais de incidente abrem esse tipo. |

## 5. Resumo

**Bem coberto:** papéis e limites, transparência, planning, daily, entrega contínua, políticas explícitas, previsão e ritmo sustentável via orçamento.

**Gaps reais, por prioridade sugerida:**

1. ~~Limite de WIP e métricas de fluxo~~ (resolvido no PR #2)
2. ~~Definition of Done global~~ (resolvido no PR #2; ainda autodeclarada)
3. **Retrospectiva automática**: aprender com rejeições, escalonamentos e estouros de orçamento, e propor ajustes.
4. **Mudança de escopo durante a execução** (*change request* em `building`), sem precisar rejeitar ou escalar.
5. **Product Goal e refinamento**: objetivo acima dos contratos, decomposição de intents grandes e dependências.
6. **Valor explícito por intent**, para ordenar o backlog por valor ÷ custo calibrado, e corte de escopo de baixo valor.
7. ~~Classe de serviço expedite~~ (resolvido junto com a entrada de alertas e bugs)
8. **Visão de review para o cliente humano**: parcialmente coberta pelo resumo diário no Slack; falta uma visão por período no painel.

**Riscos de conceito:**
- O modelo é literalmente "negociação de contrato", o oposto de um valor do Manifesto. Só funciona se os dois agentes tiverem incentivo comum, não só limites.
- Excelência técnica não pode depender só do que o cliente pede. Sem DoD global, o agente do dev otimiza para passar critérios ao menor custo.
