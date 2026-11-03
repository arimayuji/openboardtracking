// Client portal API (`/api/portal/*`): what a non-technical client does in public/portal.html.
// Spec: docs/spec-portal.md, section "API do portal". Only humans may use it; the person is
// identified by actor.agent (their e-mail). Requests and acceptances act as `client`,
// decisions on escalations act as `human`.
import { httpError } from './contract.js';
import { TEMPLATES, getTemplate, intentFromTemplate } from './templates.js';
import { clientView, timeline, overview } from './plain.js';
import { importHistory } from './importers.js';
import { suggestCriteria } from './criteria-llm.js';

const NO_CRITERIA = 'Descreva pelo menos um critério de pronto, por exemplo: "- O relatório mostra o turnover por área"';
const NO_FX = 'O câmbio ainda não foi configurado; peça ao administrador para definir a cotação do dólar.';

// Store errors come back as Portuguese, non-technical messages. Other errors pass through unchanged.
function plainError(e) {
  if (e.status !== 409) return e;
  if (e.message.startsWith('criteria not passing')) {
    return httpError(409, 'Ainda há itens que não foram concluídos ou verificados.');
  }
  if (e.message.startsWith('cannot ')) {
    return httpError(409, 'Este pedido não está numa etapa em que isso seja possível agora.');
  }
  return e;
}

// Client-side criteria (the portal form sends the same rules): non-empty list, or template criteria,
// or "- " lines of the description.
function resolveCriteria(body, template) {
  const listed = Array.isArray(body.criteria) ? body.criteria.map((s) => String(s).trim()).filter(Boolean) : [];
  if (listed.length) return listed;
  if (template) return [...template.criteria];
  const fromLines = String(body.description ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'))
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean);
  if (fromLines.length) return fromLines;
  throw httpError(400, NO_CRITERIA);
}

function budgetFor(store, budgetBrl) {
  if (budgetBrl === undefined || budgetBrl === null || budgetBrl === '') return undefined;
  const rate = store.config.fx?.usdToBrl;
  if (typeof rate !== 'number' || !(rate > 0)) throw httpError(400, NO_FX);
  const brl = Number(budgetBrl);
  if (!Number.isFinite(brl) || brl <= 0) throw httpError(400, 'Informe um orçamento em reais maior que zero.');
  return { costUsd: Math.round((brl / rate) * 100) / 100 };
}

// Needs a decision first, then ready to accept, then most recently updated.
function rank(c) {
  if (c.state === 'escalated') return 0;
  if (c.state === 'delivered') return 1;
  return 2;
}

export function portalRoutes(store, { env = {}, fetchImpl = globalThis.fetch } = {}) {
  const human = (actor) => {
    if (actor?.role !== 'human') throw httpError(403, 'only human can use the client portal');
  };
  const client = (actor) => ({ role: 'client', agent: actor.agent });
  const decider = (actor) => ({ role: 'human', agent: actor.agent });

  // Only approvers (config.portal.approvers; empty list = everyone) confirm, decide, accept, reject and change scope.
  const requireApprover = (actor) => {
    if (store.canApprove(actor.agent)) return;
    const first = store.config.portal?.approvers?.[0] ?? 'um aprovador';
    throw httpError(403, `Só aprovadores podem fazer isso. Peça para ${first} aprovar.`);
  };

  // Wraps a handler: role check first, then store errors become plain messages.
  const route = (fn) => (params, body, actor, url) => {
    human(actor);
    try {
      return fn(params, body ?? {}, actor, url);
    } catch (e) {
      throw plainError(e);
    }
  };

  return [
    ['GET', /^\/api\/portal\/me$/, route((_, __, actor) => ({ email: actor.agent, tenant: actor.tenant ?? null }))],

    ['GET', /^\/api\/portal\/templates$/, route(() => TEMPLATES)],

    ['GET', /^\/api\/portal\/overview$/, route(() => overview(store))],

    ['GET', /^\/api\/portal\/requests$/, route((_, query, actor) => {
      const goalId = query.get?.('goalId') || null;
      return store.list()
        .filter((c) => !goalId || c.goalId === goalId)
        .slice()
        .sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((c) => clientView(store, c, actor));
    })],

    ['GET', /^\/api\/portal\/requests\/(\w+)$/, route(([id], _, actor) => {
      const c = store.get(id);
      return { ...clientView(store, c, actor), timeline: timeline(store, c) };
    })],

    // Criteria suggested by the LLM for the New request form; the person reviews them before sending.
    ['POST', /^\/api\/portal\/suggest-criteria$/, route(async (_, body) => {
      if (!store.config.llm?.enabled) throw httpError(503, 'Sugestão automática não está ativada.');
      const template = body.templateId ? getTemplate(body.templateId) : null;
      if (body.templateId && !template) throw httpError(400, 'Este modelo de pedido não existe mais. Escolha outro ou comece do zero.');
      const criteria = await suggestCriteria(
        { title: body.title, description: body.description, area: template?.area ?? null },
        { apiKey: env.ANTHROPIC_API_KEY, model: store.config.llm.model, fetchImpl },
      );
      return { criteria };
    })],

    ['GET', /^\/api\/portal\/goals$/, route(() => store.listGoals().map((g) => store.goalProgress(g.id)))],

    ['POST', /^\/api\/portal\/goals$/, route((_, body, actor) => {
      const goal = store.createGoal(
        { title: body.title, description: body.description ?? '', targetDate: body.targetDate ?? null },
        client(actor),
      );
      return store.goalProgress(goal.id);
    })],

    ['POST', /^\/api\/portal\/requests$/, route((_, body, actor) => {
      const template = body.templateId ? getTemplate(body.templateId) : null;
      if (body.templateId && !template) throw httpError(400, 'Este modelo de pedido não existe mais. Escolha outro ou comece do zero.');
      const criteria = resolveCriteria(body, template);
      const budget = budgetFor(store, body.budgetBrl);
      const goalId = body.goalId || null;
      const intent = template
        ? { ...intentFromTemplate(template, { title: body.title, description: body.description, budget }), criteria, goalId }
        : { title: body.title, goal: body.description, criteria, budget, goalId };
      return clientView(store, store.createIntent(intent, client(actor)), actor);
    })],

    // Client confirms the team's current proposal (estimate and plan) so work can start.
    ['POST', /^\/api\/portal\/requests\/(\w+)\/confirm$/, route(([id], body, actor) => {
      requireApprover(actor);
      const c = store.get(id);
      store.agree(id, { version: body.version ?? c.proposal.version }, client(actor));
      return clientView(store, store.get(id), actor);
    })],

    ['POST', /^\/api\/portal\/requests\/(\w+)\/decision$/, route(([id], body, actor) => {
      requireApprover(actor);
      store.resolve(id, { decision: body.decision }, decider(actor));
      return clientView(store, store.get(id), actor);
    })],

    ['POST', /^\/api\/portal\/requests\/(\w+)\/accept$/, route(([id], _, actor) => {
      requireApprover(actor);
      store.accept(id, client(actor));
      return clientView(store, store.get(id), actor);
    })],

    ['POST', /^\/api\/portal\/requests\/(\w+)\/reject$/, route(([id], body, actor) => {
      requireApprover(actor);
      store.reject(id, { reason: body.reason ?? '' }, client(actor));
      return clientView(store, store.get(id), actor);
    })],

    // Client changes scope while agreed, building or delivered: the request goes back to negotiation.
    ['POST', /^\/api\/portal\/requests\/(\w+)\/change$/, route(([id], body, actor) => {
      requireApprover(actor);
      const criteria = Array.isArray(body.criteria) ? body.criteria.map((s) => String(s).trim()).filter(Boolean) : [];
      if (!criteria.length) throw httpError(400, 'Escreva pelo menos um critério para a mudança.');
      store.requestChange(id, { criteria, reason: body.reason ?? '' }, client(actor));
      return clientView(store, store.get(id), actor);
    })],

    ['POST', /^\/api\/portal\/import$/, route((_, body, actor) => importHistory(
      store,
      { format: body.format, csv: body.csv, hoursPerPoint: body.hoursPerPoint },
      decider(actor),
    ))],
  ];
}
