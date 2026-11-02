// Cloudflare Worker front + one Durable Object (TenantBoard) per tenant.
// The Worker authenticates, picks the tenant and forwards to its Durable Object.
// The DO runs the same app.handle() as the Node server (src/server.js).
import { Contracts } from '../src/contract.js';
import { Webhooks } from '../src/webhooks.js';
import { Slack } from '../src/slack.js';
import { createApp } from '../src/app.js';
import { authenticate, parseTenants, tenantsForEmail, safeEqual } from './auth.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const errorResponse = (e) => {
  const status = Number.isInteger(e?.status) ? e.status : 500;
  return json(status, { error: status < 500 ? e.message : 'internal error' });
};

const loadTenants = (env) => parseTenants(env.TENANTS || '{}');
const stubFor = (env, tenant) => env.TENANT_BOARD.get(env.TENANT_BOARD.idFromName(tenant));

// Static pages, served from public/. `human` pages need a Cloudflare Access login.
const PAGES = {
  '/': { file: 'landing.html', human: false },
  '/portal': { file: 'portal.html', human: true },
  '/board': { file: 'index.html', human: true },
};

export class TenantBoard {
  constructor(ctx, env) {
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get('state');
      this.store = new Contracts({ state, persist: (s) => ctx.storage.put('state', s) });
      this.hooks = new Webhooks(this.store);
      this.slack = new Slack(this.store, { token: env.SLACK_BOT_TOKEN });
      this.app = createApp({ store: this.store, hooks: this.hooks, slack: this.slack, env });
    });
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/__tick') {
        const secret = this.env.INTERNAL_SECRET;
        const given = request.headers.get('x-obt-internal') ?? '';
        if (!secret || !safeEqual(given, secret)) return json(403, { error: 'forbidden' });
        await this.slack.tick();
        return json(200, { ok: true });
      }
      const raw = request.headers.get('x-obt-actor');
      const actor = raw ? JSON.parse(raw) : null;
      return await this.app.handle(request, actor);
    } catch (e) {
      return errorResponse(e);
    }
  }
}

// Builds the request sent to the tenant's Durable Object. Client-supplied actor headers are
// removed here; the only actor the DO sees is the one the Worker just authenticated.
function forward(env, tenant, path, request, actor) {
  const headers = new Headers(request.headers);
  headers.delete('x-obt-actor');
  headers.delete('x-obt-internal');
  if (actor) headers.set('x-obt-actor', JSON.stringify(actor));

  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;
  const target = new URL(path + new URL(request.url).search, 'https://board.internal');
  return stubFor(env, tenant).fetch(new Request(target, init));
}

function isAdmin(tenantCfg, email) {
  const e = String(email ?? '').toLowerCase();
  return (tenantCfg?.admins ?? []).some((a) => String(a).toLowerCase() === e);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isRead = request.method === 'GET' || request.method === 'HEAD';

  // Pages
  const page = PAGES[path];
  if (page && isRead) {
    if (page.human) {
      let allowed = false;
      try {
        const who = await authenticate(request, env);
        allowed = who.kind === 'human' && tenantsForEmail(loadTenants(env), who.email).length > 0;
      } catch {
        allowed = false;
      }
      if (!allowed) return Response.redirect(new URL('/', url), 302);
    }
    return env.ASSETS.fetch(new Request(new URL(`/${page.file}`, url)));
  }

  // Integrations: authenticated by their own signature or token, no actor.
  const integration = path.match(/^\/t\/([^/]+)(\/api\/(?:integrations|intake)\/.*)$/);
  if (integration) {
    const [, tenant, rest] = integration;
    if (!Object.hasOwn(loadTenants(env), tenant)) return json(404, { error: 'unknown tenant' });
    return forward(env, tenant, rest, request, null);
  }

  // Agents: bearer token of one tenant.
  const agent = path.match(/^\/t\/([^/]+)(\/(?:api|proxy)\/.*)$/);
  if (agent) {
    const [, tenant, rest] = agent;
    const who = await authenticate(request, env, { tenantId: tenant });
    if (who.kind !== 'agent') throw Object.assign(new Error('invalid agent token'), { status: 401 });
    return forward(env, tenant, rest, request, { role: who.role, agent: who.agent, tenant });
  }

  // Humans: Cloudflare Access login, tenant chosen by e-mail (and ?tenant= when several).
  if (path.startsWith('/api/')) {
    const who = await authenticate(request, env);
    const tenants = tenantsForEmail(loadTenants(env), who.email);
    if (tenants.length === 0) return json(403, { error: 'no tenant for this user' });

    const requested = url.searchParams.get('tenant');
    let tenant;
    if (requested) {
      if (!tenants.includes(requested)) return json(400, { error: 'tenant not available for this user' });
      tenant = requested;
    } else if (tenants.length === 1) {
      [tenant] = tenants;
    } else {
      return json(400, { error: `tenant required (?tenant=${tenants.join(' | ')})` });
    }
    // Client users only reach the portal API. The full API (config, DoD, pricing, webhooks,
    // direct contract actions) is for the tenant's admins.
    if (!path.startsWith('/api/portal/') && !isAdmin(loadTenants(env)[tenant], who.email)) {
      return json(403, { error: 'only tenant admins can use this route' });
    }
    return forward(env, tenant, path, request, { role: 'human', agent: who.email, tenant });
  }

  return json(404, { error: 'not found' });
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      return errorResponse(e);
    }
  },

  // Daily digest and other periodic work: one internal tick per tenant.
  async scheduled(_controller, env, ctx) {
    const ticks = Object.keys(loadTenants(env)).map((tenant) => stubFor(env, tenant).fetch(
      new Request('https://board.internal/__tick', { headers: { 'x-obt-internal': env.INTERNAL_SECRET ?? '' } }),
    ));
    ctx.waitUntil(Promise.allSettled(ticks));
  },
};
