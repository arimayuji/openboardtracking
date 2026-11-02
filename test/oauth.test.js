import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleOAuth, bearerFromOAuth, metadata, validateRegistration, verifyPkce, OAuthStore, randomToken, hashToken,
} from '../worker/oauth.js';

const ORIGIN = 'https://board.example';
const SECRET = 'internal-secret-test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const TENANTS = {
  acme: { members: ['ana@acme.com', 'carla@acme.com'], devs: ['carla@acme.com'] },
  beta: { members: ['ana@acme.com', 'bia@beta.io'] },
};

const ANA = { email: 'ana@acme.com' };
const CARLA = { email: 'carla@acme.com' };
const BIA = { email: 'bia@beta.io' };

// In-memory stand-in for a Durable Object: fake ctx.storage (Map) and a clock the test controls.
function makeEnv() {
  const map = new Map();
  const clock = { now: Date.now() };
  const ctx = {
    storage: {
      get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
      put: async (k, v) => { map.set(k, structuredClone(v)); },
      delete: async (k) => map.delete(k),
    },
    blockConcurrencyWhile: (fn) => fn(),
  };
  const env = { INTERNAL_SECRET: SECRET, TENANTS: JSON.stringify(TENANTS) };
  const store = new OAuthStore(ctx, env, { clock: () => clock.now });
  env.OAUTH_STORE = {
    idFromName: (name) => name,
    get: () => ({ fetch: (req) => store.fetch(req) }),
  };
  return { env, clock, map };
}

const call = (env, url, init, human) => handleOAuth(new Request(url, init), env, {
  authenticateHuman: async () => {
    if (!human) throw Object.assign(new Error('login required'), { status: 401 });
    return human;
  },
});

async function register(env, redirectUris = [REDIRECT], clientName) {
  const res = await handleOAuth(new Request(`${ORIGIN}/register`, {
    method: 'POST',
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: clientName }),
  }), env);
  assert.equal(res.status, 201);
  return (await res.json()).client_id;
}

// Runs the consent page and the POST with "Permitir"; returns the authorization code.
async function approve(env, human, clientId, { tenant, state = 'st4te', challenge = CHALLENGE } = {}) {
  const params = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  if (tenant) params.tenant = tenant;
  const page = await call(env, `${ORIGIN}/authorize?${new URLSearchParams(params)}`, undefined, human);
  assert.equal(page.status, 200);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const form = new URLSearchParams({ ...params, csrf, decisao: 'permitir' });
  const res = await call(env, `${ORIGIN}/authorize`, { method: 'POST', body: form }, human);
  assert.equal(res.status, 302);
  return new URL(res.headers.get('location')).searchParams.get('code');
}

async function exchange(env, params) {
  return call(env, `${ORIGIN}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

const bearerReq = (token) => new Request(`${ORIGIN}/mcp`, { headers: { Authorization: `Bearer ${token}` } });

test('metadata describes the protected resource and the authorization server', () => {
  const m = metadata(ORIGIN);
  assert.equal(m.protectedResource.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(m.protectedResource.authorization_servers, [ORIGIN]);
  assert.equal(m.authorizationServer.issuer, ORIGIN);
  assert.equal(m.authorizationServer.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(m.authorizationServer.token_endpoint, `${ORIGIN}/token`);
  assert.equal(m.authorizationServer.registration_endpoint, `${ORIGIN}/register`);
  assert.deepEqual(m.authorizationServer.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(m.authorizationServer.token_endpoint_auth_methods_supported, ['none']);
});

test('well-known endpoints answer JSON with CORS', async () => {
  const { env } = makeEnv();
  const res = await handleOAuth(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal((await res.json()).token_endpoint, `${ORIGIN}/token`);
});

test('validateRegistration accepts https and localhost redirects and returns a random client_id', () => {
  const a = validateRegistration({ redirect_uris: [REDIRECT, 'http://localhost:3000/cb', 'http://127.0.0.1/cb'], client_name: 'Claude' });
  const b = validateRegistration({ redirect_uris: [REDIRECT] });
  assert.equal(a.client_name, 'Claude');
  assert.equal(a.redirect_uris.length, 3);
  assert.ok(a.client_id.length >= 32);
  assert.notEqual(a.client_id, b.client_id);
});

test('validateRegistration rejects plain http and missing redirect_uris with 400', () => {
  assert.throws(() => validateRegistration({ redirect_uris: ['http://evil.com/cb'] }), { status: 400 });
  assert.throws(() => validateRegistration({ redirect_uris: ['javascript:alert(1)'] }), { status: 400 });
  assert.throws(() => validateRegistration({}), { status: 400 });
  assert.throws(() => validateRegistration({ redirect_uris: [] }), { status: 400 });
});

test('POST /register returns 400 JSON for a bad redirect', async () => {
  const { env } = makeEnv();
  const res = await handleOAuth(new Request(`${ORIGIN}/register`, {
    method: 'POST',
    body: JSON.stringify({ redirect_uris: ['http://evil.com/cb'] }),
  }), env);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_redirect_uri');
});

test('verifyPkce accepts the RFC 7636 vector and rejects other verifiers', async () => {
  assert.equal(await verifyPkce(VERIFIER, CHALLENGE), true);
  assert.equal(await verifyPkce(`${VERIFIER}x`, CHALLENGE), false);
  assert.equal(await verifyPkce('short', 'short'), false);
  assert.equal(await verifyPkce(VERIFIER, 'nope'), false);
});

test('randomToken is 32 bytes base64url and hashToken is sha256 hex', async () => {
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('GET /authorize without login is refused with 401', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const url = `${ORIGIN}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&code_challenge=${CHALLENGE}&code_challenge_method=S256`;
  const res = await call(env, url, undefined, null);
  assert.equal(res.status, 401);
});

test('consent page escapes client name and state', async () => {
  const { env } = makeEnv();
  const clientId = await register(env, [REDIRECT], '<script>alert(1)</script>');
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: '"><img src=x>',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  });
  const res = await call(env, `${ORIGIN}/authorize?${qs}`, undefined, CARLA);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('"><img'));
  assert.ok(html.includes('Permitir') && html.includes('Cancelar'));
});

test('POST /authorize with a bad CSRF token is refused with 403', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    state: 's',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    csrf: 'forged',
    decisao: 'permitir',
  });
  const res = await call(env, `${ORIGIN}/authorize`, { method: 'POST', body: form }, ANA);
  assert.equal(res.status, 403);
});

test('cancelar redirects with error=access_denied and state', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const params = {
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', state: 'abc',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
  };
  const page = await call(env, `${ORIGIN}/authorize?${new URLSearchParams(params)}`, undefined, CARLA);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const res = await call(env, `${ORIGIN}/authorize`, {
    method: 'POST', body: new URLSearchParams({ ...params, csrf, decisao: 'cancelar' }),
  }, CARLA);
  const loc = new URL(res.headers.get('location'));
  assert.equal(res.status, 302);
  assert.equal(loc.searchParams.get('error'), 'access_denied');
  assert.equal(loc.searchParams.get('state'), 'abc');
});

test('several tenants need ?tenant=, and it must be one of them', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const qs = (extra = '') => `${ORIGIN}/authorize?${new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code',
    code_challenge: CHALLENGE, code_challenge_method: 'S256',
  })}${extra}`;
  assert.equal((await call(env, qs(), undefined, ANA)).status, 400);
  assert.equal((await call(env, qs('&tenant=gamma'), undefined, ANA)).status, 400);
  assert.equal((await call(env, qs('&tenant=beta'), undefined, ANA)).status, 200);
});

test('full flow: register, authorize, token, then the bearer resolves to email, tenant and role', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const code = await approve(env, ANA, clientId, { tenant: 'acme' });
  const res = await exchange(env, {
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER,
  });
  assert.equal(res.status, 200);
  const tokens = await res.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.ok(tokens.refresh_token);
  assert.deepEqual(await bearerFromOAuth(bearerReq(tokens.access_token), env), {
    email: 'ana@acme.com', tenant: 'acme', role: 'human',
  });
  assert.equal(await bearerFromOAuth(bearerReq('wrong-token'), env), null);
  assert.equal(await bearerFromOAuth(new Request(`${ORIGIN}/mcp`), env), null);
});

test('authorization code is single use', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const code = await approve(env, ANA, clientId, { tenant: 'acme' });
  const body = { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER };
  assert.equal((await exchange(env, body)).status, 200);
  const again = await exchange(env, body);
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, 'invalid_grant');
});

test('wrong code_verifier gives invalid_grant', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const code = await approve(env, ANA, clientId, { tenant: 'acme' });
  const res = await exchange(env, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: 'x'.repeat(43),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_grant');
});

test('refresh token rotates: the old one stops working', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const code = await approve(env, ANA, clientId, { tenant: 'acme' });
  const first = await (await exchange(env, {
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER,
  })).json();

  const second = await exchange(env, { grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token });
  assert.equal(second.status, 200);
  const rotated = await second.json();
  assert.notEqual(rotated.refresh_token, first.refresh_token);
  assert.ok(await bearerFromOAuth(bearerReq(rotated.access_token), env));

  const reused = await exchange(env, { grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, 'invalid_grant');
});

test('an expired access token resolves to null', async () => {
  const { env, clock } = makeEnv();
  const clientId = await register(env);
  const code = await approve(env, ANA, clientId, { tenant: 'acme' });
  const tokens = await (await exchange(env, {
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER,
  })).json();
  assert.ok(await bearerFromOAuth(bearerReq(tokens.access_token), env));
  clock.now += 3601 * 1000;
  assert.equal(await bearerFromOAuth(bearerReq(tokens.access_token), env), null);
});

test('an expired authorization code is refused', async () => {
  const { env, clock } = makeEnv();
  const clientId = await register(env);
  const code = await approve(env, ANA, clientId, { tenant: 'acme' });
  clock.now += 5 * 60 * 1000 + 1;
  const res = await exchange(env, {
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER,
  });
  assert.equal((await res.json()).error, 'invalid_grant');
});

test('devs of a tenant get role dev, other members get human', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  for (const [human, role] of [[CARLA, 'dev'], [ANA, 'human']]) {
    const code = await approve(env, human, clientId, { tenant: 'acme' });
    const tokens = await (await exchange(env, {
      grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER,
    })).json();
    const who = await bearerFromOAuth(bearerReq(tokens.access_token), env);
    assert.equal(who.role, role);
    assert.equal(who.tenant, 'acme');
  }
});

test('a person removed from the tenant loses the bearer access', async () => {
  const { env } = makeEnv();
  const clientId = await register(env);
  const code = await approve(env, BIA, clientId);
  const tokens = await (await exchange(env, {
    grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER,
  })).json();
  assert.equal((await bearerFromOAuth(bearerReq(tokens.access_token), env)).tenant, 'beta');
  // Bia leaves the tenant: the stored token no longer resolves.
  env.TENANTS = JSON.stringify({ beta: { members: [] } });
  assert.equal(await bearerFromOAuth(bearerReq(tokens.access_token), env), null);
});

test('the OAuth store refuses calls without the internal secret', async () => {
  const { env } = makeEnv();
  const stub = env.OAUTH_STORE.get('global');
  const res = await stub.fetch(new Request('https://oauth-store.internal/op/client', {
    method: 'POST', headers: { 'x-obt-internal': 'wrong' }, body: JSON.stringify({ client_id: 'x' }),
  }));
  assert.equal(res.status, 403);
});

test('token endpoint rejects unknown clients and non-form bodies', async () => {
  const { env } = makeEnv();
  const unknown = await exchange(env, { grant_type: 'refresh_token', client_id: 'nope', refresh_token: 'x' });
  assert.equal((await unknown.json()).error, 'invalid_client');
  const json = await call(env, `${ORIGIN}/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal((await json.json()).error, 'invalid_request');
});

test('unknown paths are not handled by OAuth', async () => {
  const { env } = makeEnv();
  assert.equal(await handleOAuth(new Request(`${ORIGIN}/portal`), env), null);
  const preflight = await handleOAuth(new Request(`${ORIGIN}/token`, { method: 'OPTIONS' }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
});
