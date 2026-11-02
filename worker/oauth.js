// OAuth 2.1 authorization server for the claude.ai custom connector (see docs/spec-mcp.md).
// Pure Web Crypto, no node: imports. Clients are public (PKCE, no secret); tokens are stored
// only as SHA-256 in the OAuthStore Durable Object (one instance, `global`).
import { sha256Hex, safeEqual, parseTenants, tenantsForEmail } from './auth.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TTL_S = 3600;
const ACCESS_TTL_MS = ACCESS_TTL_S * 1000;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const ROUTES = {
  '/.well-known/oauth-protected-resource': ['GET'],
  '/.well-known/oauth-authorization-server': ['GET'],
  '/register': ['POST'],
  '/authorize': ['GET', 'POST'],
  '/token': ['POST'],
};
const CORS_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/register',
  '/token',
]);
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600',
};

const enc = (s) => new TextEncoder().encode(String(s));

function b64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function withHeaders(res, extra) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

const oauthErr = (status, oauth, message) => Object.assign(new Error(message), { status, oauth });
// Errors shown to the person on the authorization page (message is safe to display).
const pageErr = (status, message) => Object.assign(new Error(message), { status, page: true });
const redirectErr = (code) => Object.assign(new Error(code), { redirectError: code });

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function randomToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export function hashToken(token) {
  return sha256Hex(token);
}

export function metadata(origin) {
  return {
    protectedResource: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
    },
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    },
  };
}

function isLocalhost(url) {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

// RFC 7591 subset for public clients. Returns the normalized client or throws a 400 error.
export function validateRegistration(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw oauthErr(400, 'invalid_client_metadata', 'body must be a JSON object');
  }
  const list = body.redirect_uris;
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) {
    throw oauthErr(400, 'invalid_redirect_uri', 'redirect_uris is required (1 to 10 entries)');
  }
  const redirect_uris = [...new Set(list.map((uri) => {
    let url;
    try {
      url = new URL(String(uri));
    } catch {
      throw oauthErr(400, 'invalid_redirect_uri', 'redirect_uri is not a URL');
    }
    if (!(url.protocol === 'https:' || isLocalhost(url)) || url.hash) {
      throw oauthErr(400, 'invalid_redirect_uri', 'redirect_uri must be https, or http on localhost/127.0.0.1');
    }
    return String(uri);
  }))];
  const client_name = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : undefined;
  return { client_id: randomToken(), redirect_uris, client_name };
}

// S256 check (RFC 7636). Verifier: 43 to 128 unreserved characters.
export async function verifyPkce(verifier, challenge) {
  if (typeof verifier !== 'string' || typeof challenge !== 'string') return false;
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = await crypto.subtle.digest('SHA-256', enc(verifier));
  return safeEqual(b64url(new Uint8Array(digest)), challenge);
}

// Durable Object holding clients, codes and tokens. Only the Worker calls it, with x-obt-internal.
export class OAuthStore {
  constructor(ctx, env, { clock = Date.now } = {}) {
    this.ctx = ctx;
    this.env = env;
    this.clock = clock;
  }

  async fetch(request) {
    try {
      const secret = this.env.INTERNAL_SECRET;
      const given = request.headers.get('x-obt-internal') ?? '';
      if (!secret || !safeEqual(given, secret)) return json(403, { error: 'forbidden' });
      const op = new URL(request.url).pathname.replace(/^\/op\//, '');
      const body = (await request.json()) ?? {};
      const result = await this.run(op, body);
      if (result === undefined) return json(404, { error: 'unknown op' });
      return json(200, result);
    } catch {
      return json(500, { error: 'store failure' });
    }
  }

  // Reads and deletes a record in one step, so a code or refresh token can be used only once.
  take(key) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const rec = (await this.ctx.storage.get(key)) ?? null;
      if (rec) await this.ctx.storage.delete(key);
      return rec;
    });
  }

  async run(op, b) {
    const now = this.clock();
    const { storage } = this.ctx;
    switch (op) {
      case 'register':
        await storage.put(`client:${b.client.client_id}`, b.client);
        return { ok: true };
      case 'client':
        return (await storage.get(`client:${String(b.client_id)}`)) ?? null;
      case 'saveCode':
        await storage.put(`code:${String(b.hash)}`, { ...b.record, exp: now + CODE_TTL_MS });
        return { ok: true };
      case 'takeCode': {
        const rec = await this.take(`code:${String(b.hash)}`);
        return rec && rec.exp > now ? rec : null;
      }
      case 'saveTokens': {
        const base = { email: b.email, tenant: b.tenant, role: b.role, clientId: b.clientId };
        await storage.put(`at:${String(b.accessHash)}`, { ...base, exp: now + ACCESS_TTL_MS });
        await storage.put(`rt:${String(b.refreshHash)}`, { ...base, exp: now + REFRESH_TTL_MS });
        return { ok: true };
      }
      case 'access': {
        const rec = (await storage.get(`at:${String(b.hash)}`)) ?? null;
        return rec && rec.exp > now ? rec : null;
      }
      case 'takeRefresh': {
        const rec = await this.take(`rt:${String(b.hash)}`);
        if (!rec || rec.exp <= now || rec.clientId !== b.clientId) return null;
        return rec;
      }
      default:
        return undefined;
    }
  }
}

// Calls the OAuthStore Durable Object. Every op is a POST to /op/<name> with a JSON body.
async function callStore(env, op, body) {
  const ns = env.OAUTH_STORE;
  if (!ns) throw oauthErr(500, 'server_error', 'OAUTH_STORE binding missing');
  const stub = ns.get(ns.idFromName('global'));
  const res = await stub.fetch(new Request(`https://oauth-store.internal/op/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-obt-internal': env.INTERNAL_SECRET ?? '' },
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw oauthErr(500, 'server_error', 'store failure');
  return res.json();
}

const loadTenants = (env) => parseTenants(env.TENANTS || '{}');

function roleFor(tenantCfg, email) {
  const e = String(email ?? '').trim().toLowerCase();
  const isDev = (tenantCfg?.devs ?? []).some((d) => String(d).trim().toLowerCase() === e);
  return isDev ? 'dev' : 'human';
}

async function csrfToken(env, email, clientId, state) {
  if (!env.INTERNAL_SECRET) throw new Error('INTERNAL_SECRET missing');
  const key = await crypto.subtle.importKey('raw', enc(env.INTERNAL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc([email, clientId, state].join('\n')));
  return b64url(new Uint8Array(sig));
}

function htmlPage(status, title, body) {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --fg: #111; --bg: #fff; --line: #888; }
@media (prefers-color-scheme: dark) { :root { --fg: #eee; --bg: #111; --line: #777; } }
body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: var(--bg); color: var(--fg); }
main { max-width: 480px; margin: 40px auto; }
button { font: inherit; padding: 10px 18px; border-radius: 6px; border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer; }
button.primary { background: var(--fg); color: var(--bg); }
.acoes { display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    },
  });
}

function redirectTo(uri, params) {
  const dest = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') dest.searchParams.set(k, v);
  }
  return new Response(null, { status: 302, headers: { location: dest.href, 'cache-control': 'no-store' } });
}

// Validates everything the authorization request needs. Client and redirect_uri errors are shown
// on the page (never redirected: the redirect target is not trusted yet); the rest go to redirect_uri.
async function checkAuthRequest(env, p, email) {
  const client = await callStore(env, 'client', { client_id: String(p.client_id ?? '') });
  if (!client) throw pageErr(400, 'Cliente não reconhecido. Adicione o conector de novo no Claude.');
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri)) {
    throw pageErr(400, 'redirect_uri não registrado para este cliente.');
  }

  const tenants = loadTenants(env);
  const allowed = tenantsForEmail(tenants, email);
  if (allowed.length === 0) throw pageErr(403, 'Seu usuário não tem acesso a nenhum tenant.');
  let tenant;
  if (p.tenant) {
    if (!allowed.includes(p.tenant)) throw pageErr(400, 'Tenant indisponível para este usuário.');
    tenant = p.tenant;
  } else if (allowed.length === 1) {
    [tenant] = allowed;
  } else {
    throw pageErr(400, `Escolha o tenant na URL (?tenant=${allowed.join(' | ')}).`);
  }

  if (p.response_type !== 'code') throw redirectErr('unsupported_response_type');
  if (p.code_challenge_method !== 'S256' || !p.code_challenge) throw redirectErr('invalid_request');
  return { client, tenant, role: roleFor(tenants[tenant], email) };
}

function consentPage(p, email, tenant, client, csrf) {
  const hidden = {
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    response_type: 'code',
    state: p.state ?? '',
    code_challenge: p.code_challenge,
    code_challenge_method: 'S256',
    tenant,
    csrf,
  };
  const fields = Object.entries(hidden)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('\n');
  return htmlPage(200, 'Conectar o Claude', `
<h1>Conectar o Claude</h1>
<p>Conectar o Claude ao OpenBoardTracking como <strong>${escapeHtml(email)}</strong> (${escapeHtml(tenant)})?</p>
<p>Cliente: ${escapeHtml(client.client_name || client.client_id)}</p>
<form method="POST" action="/authorize">
${fields}
<div class="acoes">
<button class="primary" type="submit" name="decisao" value="permitir">Permitir</button>
<button type="submit" name="decisao" value="cancelar">Cancelar</button>
</div>
</form>`);
}

async function authorize(request, env, opts, url) {
  const isPost = request.method === 'POST';
  let p = {};
  try {
    if (isPost) {
      const form = await request.formData();
      p = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
    } else {
      p = Object.fromEntries(url.searchParams);
    }

    let who;
    try {
      who = await opts.authenticateHuman(request);
    } catch {
      who = null;
    }
    const email = who?.email;
    if (!email) throw pageErr(401, 'Entre com sua conta corporativa para conectar o Claude.');

    if (isPost) {
      const expected = await csrfToken(env, email, String(p.client_id ?? ''), String(p.state ?? ''));
      if (!safeEqual(String(p.csrf ?? ''), expected)) {
        throw pageErr(403, 'Formulário expirado. Abra o conector de novo.');
      }
    }

    const { client, tenant, role } = await checkAuthRequest(env, p, email);
    if (!isPost) {
      const csrf = await csrfToken(env, email, p.client_id, p.state ?? '');
      return consentPage(p, email, tenant, client, csrf);
    }

    if (p.decisao !== 'permitir') {
      return redirectTo(p.redirect_uri, { error: 'access_denied', state: p.state });
    }
    const code = randomToken();
    await callStore(env, 'saveCode', {
      hash: await hashToken(code),
      record: {
        clientId: p.client_id,
        redirectUri: p.redirect_uri,
        challenge: p.code_challenge,
        email,
        tenant,
        role,
      },
    });
    return redirectTo(p.redirect_uri, { code, state: p.state });
  } catch (e) {
    if (e.redirectError) return redirectTo(p.redirect_uri, { error: e.redirectError, state: p.state });
    if (e.page) return htmlPage(e.status, 'Erro na autorização', `<h1>Não foi possível conectar</h1><p>${escapeHtml(e.message)}</p>`);
    return htmlPage(500, 'Erro na autorização', '<h1>Erro interno</h1>');
  }
}

async function register(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw oauthErr(400, 'invalid_client_metadata', 'body must be JSON');
  }
  const client = validateRegistration(body);
  await callStore(env, 'register', { client });
  return json(201, {
    client_id: client.client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
}

async function issueTokens(env, { email, tenant, clientId }) {
  const tenants = loadTenants(env);
  if (!Object.hasOwn(tenants, tenant) || !tenantsForEmail(tenants, email).includes(tenant)) {
    throw oauthErr(400, 'invalid_grant', 'user no longer has access to this tenant');
  }
  const access = randomToken();
  const refresh = randomToken();
  await callStore(env, 'saveTokens', {
    accessHash: await hashToken(access),
    refreshHash: await hashToken(refresh),
    email,
    tenant,
    role: roleFor(tenants[tenant], email),
    clientId,
  });
  return json(200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
  }, { 'cache-control': 'no-store', pragma: 'no-cache' });
}

async function tokenEndpoint(request, env) {
  const type = request.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('application/x-www-form-urlencoded')) {
    throw oauthErr(400, 'invalid_request', 'use application/x-www-form-urlencoded');
  }
  const p = new URLSearchParams(await request.text());
  const clientId = p.get('client_id') ?? '';
  if (!clientId) throw oauthErr(400, 'invalid_request', 'client_id is required');
  const client = await callStore(env, 'client', { client_id: clientId });
  if (!client) throw oauthErr(400, 'invalid_client', 'unknown client');

  const grant = p.get('grant_type');
  if (grant === 'authorization_code') {
    const code = p.get('code') ?? '';
    const verifier = p.get('code_verifier') ?? '';
    const redirectUri = p.get('redirect_uri') ?? '';
    if (!code || !verifier || !redirectUri) throw oauthErr(400, 'invalid_request', 'code, redirect_uri and code_verifier are required');
    const rec = await callStore(env, 'takeCode', { hash: await hashToken(code) });
    if (!rec || rec.clientId !== clientId || rec.redirectUri !== redirectUri
      || !(await verifyPkce(verifier, rec.challenge))) {
      throw oauthErr(400, 'invalid_grant', 'invalid authorization code');
    }
    return issueTokens(env, { email: rec.email, tenant: rec.tenant, clientId });
  }

  if (grant === 'refresh_token') {
    const refresh = p.get('refresh_token') ?? '';
    if (!refresh) throw oauthErr(400, 'invalid_request', 'refresh_token is required');
    const rec = await callStore(env, 'takeRefresh', { hash: await hashToken(refresh), clientId });
    if (!rec) throw oauthErr(400, 'invalid_grant', 'invalid refresh token');
    return issueTokens(env, { email: rec.email, tenant: rec.tenant, clientId });
  }

  throw oauthErr(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

function errorResponse(e) {
  const status = Number.isInteger(e?.status) ? e.status : 500;
  const error = e?.oauth ?? (status < 500 ? 'invalid_request' : 'server_error');
  return json(status, { error, error_description: status < 500 ? e.message : 'internal error' }, { 'cache-control': 'no-store' });
}

async function handle(request, env, opts, url) {
  switch (url.pathname) {
    case '/.well-known/oauth-protected-resource':
      return json(200, metadata(url.origin).protectedResource);
    case '/.well-known/oauth-authorization-server':
      return json(200, metadata(url.origin).authorizationServer);
    case '/register':
      return register(request, env);
    case '/authorize':
      return authorize(request, env, opts, url);
    case '/token':
      return tokenEndpoint(request, env);
    default:
      return null;
  }
}

// Routes the OAuth paths. Returns null for any other path so the Worker keeps routing it.
// opts.authenticateHuman(request) -> { email } for a Cloudflare Access login, or throws.
export async function handleOAuth(request, env, opts = {}) {
  const url = new URL(request.url);
  const methods = ROUTES[url.pathname];
  if (!methods) return null;
  const cors = CORS_PATHS.has(url.pathname);
  if (request.method === 'OPTIONS' && cors) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  let res;
  try {
    res = methods.includes(request.method)
      ? await handle(request, env, opts, url)
      : json(405, { error: 'invalid_request', error_description: 'method not allowed' }, { allow: methods.join(', ') });
  } catch (e) {
    res = errorResponse(e);
  }
  return cors ? withHeaders(res, CORS_HEADERS) : res;
}

// Bearer access token -> { email, tenant, role } or null. Membership and role are checked
// against the current tenant config, so removing someone from members revokes access at once.
export async function bearerFromOAuth(request, env) {
  const match = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const rec = await callStore(env, 'access', { hash: await hashToken(match[1]) });
  if (!rec) return null;
  const tenants = loadTenants(env);
  if (!Object.hasOwn(tenants, rec.tenant) || !tenantsForEmail(tenants, rec.email).includes(rec.tenant)) return null;
  return { email: rec.email, tenant: rec.tenant, role: roleFor(tenants[rec.tenant], rec.email) };
}
