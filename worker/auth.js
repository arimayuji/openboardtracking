// Authentication for the Worker front. Pure Web Crypto, no node: imports.
// Humans come through Cloudflare Access (signed JWT in Cf-Access-Jwt-Assertion).
// Agents present a bearer token whose SHA-256 is listed in the tenant config.

const KEY_TTL_MS = 10 * 60 * 1000;
const keyCache = new Map(); // `${teamDomain}|${kid}` -> { key: CryptoKey, at: ms }

function unauthorized(message) {
  return Object.assign(new Error(message), { status: 401 });
}

export function parseTenants(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('TENANTS is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TENANTS must be a JSON object');
  }
  return value;
}

// members: exact e-mail ("ana@acme.com") or domain entry ("@acme.com"), case-insensitive.
export function tenantsForEmail(tenants, email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (e.split('@').length !== 2 || e.startsWith('@') || e.endsWith('@')) return [];
  return Object.entries(tenants)
    .filter(([, tenant]) => (tenant?.members ?? []).some((member) => {
      const m = String(member).trim().toLowerCase();
      return m.startsWith('@') ? e.endsWith(m) : m === e;
    }))
    .map(([id]) => id);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison of two strings (no early exit on the first difference).
export function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function agentFromToken(tenants, tenantId, token) {
  const tenant = Object.hasOwn(tenants, tenantId) ? tenants[tenantId] : null;
  if (!tenant || !token) return null;
  const hash = await sha256Hex(token);
  let found = null;
  for (const entry of tenant.agentTokens ?? []) {
    // Check every entry so timing does not reveal which one matched.
    if (safeEqual(hash, String(entry.sha256 ?? '').toLowerCase()) && !found) {
      found = { role: entry.role, agent: entry.agent };
    }
  }
  return found;
}

function b64urlToBytes(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad base64url');
  const pad = (4 - (s.length % 4)) % 4;
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const decodeJson = (part) => JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));

async function signingKey(teamDomain, kid, fetchImpl, now) {
  const id = `${teamDomain}|${kid}`;
  const hit = keyCache.get(id);
  if (hit && now - hit.at < KEY_TTL_MS) return hit.key;

  const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('certs unavailable');
  const { keys = [] } = await res.json();
  for (const jwk of keys) {
    if (!jwk || jwk.kty !== 'RSA' || !jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keyCache.set(`${teamDomain}|${jwk.kid}`, { key, at: now });
  }
  const fresh = keyCache.get(id);
  if (!fresh) throw new Error('unknown key id');
  return fresh.key;
}

// Returns the e-mail claim of a valid Access JWT. Any failure throws an error with status 401.
export async function verifyAccessJwt(jwt, { teamDomain, aud, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  try {
    if (!teamDomain || !aud) throw new Error('Access is not configured');
    const parts = String(jwt ?? '').split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const header = decodeJson(parts[0]);
    if (header.alg !== 'RS256' || !header.kid) throw new Error('unsupported token header');

    const key = await signingKey(teamDomain, header.kid, fetchImpl, now);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), data);
    if (!valid) throw new Error('bad signature');

    const payload = decodeJson(parts[1]);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) throw new Error('wrong audience');
    const nowSec = now / 1000;
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) throw new Error('token expired');
    if (payload.nbf !== undefined && payload.nbf > nowSec) throw new Error('token not yet valid');
    if (typeof payload.email !== 'string' || !payload.email) throw new Error('no email claim');
    return payload.email;
  } catch (e) {
    throw unauthorized(`invalid access token: ${e.message}`);
  }
}

// -> { kind: 'human', email } | { kind: 'agent', role, agent } | throws with status 401.
// Agents need `tenantId` (taken from the /t/<tenant>/ path by the caller).
export async function authenticate(request, env = {}, { fetchImpl = globalThis.fetch, tenantId } = {}) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (jwt) {
    const email = await verifyAccessJwt(jwt, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      fetchImpl,
    });
    return { kind: 'human', email };
  }

  const match = (request.headers.get('Authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  if (match) {
    if (!tenantId) throw unauthorized('tenant required for agent tokens');
    const tenants = parseTenants(env.TENANTS || '{}');
    const found = await agentFromToken(tenants, tenantId, match[1]);
    if (!found) throw unauthorized('invalid agent token');
    return { kind: 'agent', role: found.role, agent: found.agent };
  }

  throw unauthorized('authentication required');
}
