// Modelos prontos de pedido para clientes não técnicos.
// Textos em português do Brasil, sem jargão técnico.

export const AREAS = [
  { id: 'rh', label: 'Recursos Humanos' },
  { id: 'financas', label: 'Finanças e mercado' },
  { id: 'saude', label: 'Saúde' },
  { id: 'direito', label: 'Direito' },
  { id: 'economia', label: 'Economia' },
];

const LGPD_CRITERION = 'Dados pessoais ficam acessíveis só para pessoas autorizadas';
const SIGILO_CRITERION = 'Documentos e informações do processo ficam acessíveis só para a equipe autorizada';

export const TEMPLATES = [
  {
    id: 'rh-onboarding-automatizado',
    area: 'rh',
    title: 'Onboarding automatizado de novos colaboradores',
    summary: 'Prepara a entrada de cada novo colaborador sem trabalho manual repetido.',
    description:
      'Organiza os passos de chegada de uma nova pessoa na empresa: documentos, acessos, treinamentos e mensagens de boas-vindas. Cada etapa é acompanhada até ser concluída. Quem entra na empresa recebe as orientações no prazo combinado.',
    criteria: [
      'Cada novo colaborador recebe a lista de documentos e as orientações de primeiro dia',
      'O acompanhamento mostra quais etapas já foram concluídas e quais estão pendentes',
      'Mensagens de boas-vindas são enviadas no prazo combinado antes da data de entrada',
      LGPD_CRITERION,
    ],
    sensitive: 'lgpd',
    irreversible: true,
  },
  {
    id: 'rh-relatorio-turnover',
    area: 'rh',
    title: 'Relatório de turnover',
    summary: 'Mostra quantas pessoas saem da empresa, por área e por mês.',
    description:
      'Gera um relatório com as saídas e entradas de colaboradores ao longo do tempo. Os números ajudam a entender onde a rotatividade é maior. Os dados aparecem de forma agregada, sem identificar pessoas.',
    criteria: [
      'O relatório mostra o turnover por área e por mês',
      'O relatório mostra o total de entradas e saídas no período escolhido',
      'Os números aparecem agrupados, sem nomes de pessoas',
    ],
    sensitive: null,
    irreversible: false,
  },
  {
    id: 'financas-conciliacao-diaria',
    area: 'financas',
    title: 'Conciliação financeira diária',
    summary: 'Confere todo dia se os lançamentos do banco batem com os da contabilidade.',
    description:
      'Compara as movimentações do banco com os registros internos, todos os dias. Diferenças são listadas para revisão, com a indicação do que não bateu. O objetivo é que nenhum erro passe despercebido até o fechamento.',
    criteria: [
      'Todo dia útil é gerada uma lista de lançamentos que não bateram',
      'Cada diferença mostra o valor, a data e a origem da divergência',
      'A equipe consegue marcar cada diferença como resolvida',
    ],
    sensitive: null,
    irreversible: true,
  },
  {
    id: 'financas-alerta-risco-posicao',
    area: 'financas',
    title: 'Alerta de risco de posição',
    summary: 'Avisa quando uma carteira fica exposta além do limite definido.',
    description:
      'Acompanha as posições da carteira e avisa quando o risco passa do limite combinado. O alerta mostra quanto a carteira está exposta e quais posições mais pesam. A decisão de agir continua com a equipe responsável.',
    criteria: [
      'O alerta aparece quando a exposição passa do limite combinado',
      'O aviso mostra as três posições que mais contribuem para o risco',
      'Os limites podem ser ajustados pela equipe responsável',
    ],
    sensitive: null,
    irreversible: false,
  },
  {
    id: 'saude-lembrete-consultas',
    area: 'saude',
    title: 'Lembrete de consultas para pacientes',
    summary: 'Envia lembretes de consulta aos pacientes antes do horário marcado.',
    description:
      'Avisa cada paciente com antecedência sobre a consulta marcada, com data, horário e local. Quem não puder comparecer tem como remarcar pela mesma mensagem. A clínica acompanha quantos lembretes foram enviados e quantas consultas foram confirmadas.',
    criteria: [
      'Cada paciente recebe o lembrete com data, horário e local da consulta',
      'O lembrete é enviado no prazo combinado antes da consulta',
      'A clínica vê quantas consultas foram confirmadas ou remarcadas',
      LGPD_CRITERION,
    ],
    sensitive: 'lgpd',
    irreversible: true,
  },
  {
    id: 'saude-painel-ocupacao-leitos',
    area: 'saude',
    title: 'Painel de ocupação de leitos',
    summary: 'Mostra em tempo quase real quantos leitos estão livres e ocupados.',
    description:
      'Reúne a ocupação de leitos por unidade e por tipo, em uma tela de fácil leitura. A equipe vê rapidamente onde há vagas e onde a demanda está alta. As informações dos pacientes são exibidas somente para quem trabalha no atendimento.',
    criteria: [
      'O painel mostra leitos livres e ocupados por unidade e por tipo',
      'Os números são atualizados com a frequência combinada com a equipe',
      'O painel mostra o percentual de ocupação de cada unidade',
      LGPD_CRITERION,
    ],
    sensitive: 'lgpd',
    irreversible: false,
  },
  {
    id: 'direito-controle-prazos',
    area: 'direito',
    title: 'Controle de prazos processuais',
    summary: 'Lista os prazos de cada processo e avisa antes de vencerem.',
    description:
      'Reúne os prazos de todos os processos em um só lugar, com data de vencimento e responsável. Avisos são enviados antes de cada prazo para evitar perdas. A equipe confere o calendário de prazos da semana sem precisar abrir cada processo.',
    criteria: [
      'Todos os prazos aparecem em uma lista com data e responsável',
      'Um aviso é mostrado com antecedência antes de cada vencimento',
      SIGILO_CRITERION,
    ],
    sensitive: 'sigilo',
    irreversible: false,
  },
  {
    id: 'direito-triagem-contratos',
    area: 'direito',
    title: 'Triagem de contratos',
    summary: 'Separa os contratos recebidos por tipo e aponta cláusulas que pedem atenção.',
    description:
      'Lê os contratos enviados e os organiza por tipo, valor e prazo. Cláusulas fora do padrão da empresa são destacadas para revisão. O advogado responsável decide o que fazer com cada caso.',
    criteria: [
      'Cada contrato recebido aparece classificado por tipo, valor e prazo',
      'Cláusulas fora do padrão aparecem destacadas com a explicação do ponto de atenção',
      'Nenhum contrato é aprovado ou assinado sem a decisão do responsável',
      SIGILO_CRITERION,
    ],
    sensitive: 'sigilo',
    irreversible: false,
  },
  {
    id: 'economia-painel-indicadores',
    area: 'economia',
    title: 'Painel de indicadores econômicos',
    summary: 'Reúne os principais indicadores da economia em uma tela só.',
    description:
      'Junta indicadores como juros, câmbio, inflação e emprego em um painel organizado. Cada indicador mostra o valor atual e a variação no período. Facilita o acompanhamento semanal sem precisar consultar várias fontes.',
    criteria: [
      'O painel mostra juros, câmbio, inflação e emprego com o valor atual',
      'Cada indicador mostra a variação em relação ao período anterior',
      'Os dados indicam a fonte e a data de atualização',
    ],
    sensitive: null,
    irreversible: false,
  },
  {
    id: 'economia-relatorio-inflacao-setor',
    area: 'economia',
    title: 'Relatório de inflação por setor',
    summary: 'Mostra como os preços subiram em cada setor da economia.',
    description:
      'Compara a variação de preços entre setores como alimentação, transporte e serviços. O relatório destaca quais setores pressionam mais a inflação. Os números vêm com o período de comparação para facilitar a leitura.',
    criteria: [
      'O relatório mostra a variação de preços de cada setor no período',
      'Os setores são ordenados do que mais subiu para o que menos subiu',
      'O relatório indica o período de comparação usado em cada número',
    ],
    sensitive: null,
    irreversible: false,
  },
];

export function getTemplate(id) {
  return TEMPLATES.find((template) => template.id === id) || null;
}

export function templatesByArea() {
  const grouped = Object.fromEntries(AREAS.map((area) => [area.id, []]));
  for (const template of TEMPLATES) {
    if (!grouped[template.area]) grouped[template.area] = [];
    grouped[template.area].push(template);
  }
  return grouped;
}

export function intentFromTemplate(template, { title, description, budget } = {}) {
  return {
    title: title || template.title,
    goal: description || template.description,
    criteria: [...template.criteria],
    irreversible: template.irreversible,
    area: template.area,
    sensitive: template.sensitive,
    ...(budget ? { budget } : {}),
  };
}
