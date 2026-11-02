import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTenants, tenantsForEmail, sha256Hex, agentFromToken, verifyAccessJwt, authenticate,
} from '../worker/auth.js';

const TEAM = 'acme.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const KID = 'kid-test-1';
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let privateKey;
let jwk;

before(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  privateKey = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
});

async function signJwt(payload, { kid = KID, key = privateKey } = {}) {
  const head = b64urlJson({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64urlJson({
    email: 'ana@acme.com',
    aud: AUD,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...payload,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// Serves the public key as Cloudflare Access would, and counts the calls.
function fakeCerts() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  };
  return { fetchImpl, calls };
}

const verifyOpts = (fetchImpl, extra = {}) => ({ teamDomain: TEAM, aud: AUD, fetchImpl, ...extra });

const TENANTS = {
  acme: {
    members: ['ana@acme.com', '@acme.com'],
    agentTokens: [{ sha256: await sha256Hex('tok-dev-1'), role: 'dev', agent: 'dev-1' }],
  },
  beta: { members: ['ana@acme.com', 'bia@beta.io'], agentTokens: [] },
};

test('parseTenants accepts an object and rejects invalid JSON', () => {
  assert.deepEqual(parseTenants('{"acme":{"members":[]}}'), { acme: { members: [] } });
  assert.throws(() => parseTenants('{not json'));
  assert.throws(() => parseTenants('[1,2]'));
});

test('tenantsForEmail matches exact e-mail and domain entries', () => {
  assert.deepEqual(tenantsForEmail(TENANTS, 'ana@acme.com'), ['acme', 'beta']);
  assert.deepEqual(tenantsForEmail(TENANTS, 'carla@acme.com'), ['acme']);
  assert.deepEqual(tenantsForEmail(TENANTS, 'bia@beta.io'), ['beta']);
  assert.deepEqual(tenantsForEmail(TENANTS, 'x@acme.com.evil.net'), []);
  assert.deepEqual(tenantsForEmail(TENANTS, 'x@notacme.com'), []);
});

test('tenantsForEmail is case-insensitive', () => {
  assert.deepEqual(tenantsForEmail(TENANTS, 'ANA@Acme.COM'), ['acme', 'beta']);
  assert.deepEqual(tenantsForEmail(TENANTS, 'Carla@ACME.com'), ['acme']);
});

test('sha256Hex matches the known vector for "abc"', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('agentFromToken returns role and agent for the right token only', async () => {
  assert.deepEqual(await agentFromToken(TENANTS, 'acme', 'tok-dev-1'), { role: 'dev', agent: 'dev-1' });
  assert.equal(await agentFromToken(TENANTS, 'acme', 'tok-dev-2'), null);
  assert.equal(await agentFromToken(TENANTS, 'unknown', 'tok-dev-1'), null);
  assert.equal(await agentFromToken(TENANTS, 'acme', ''), null);
});

test('verifyAccessJwt returns the e-mail of a valid token', async () => {
  const { fetchImpl, calls } = fakeCerts();
  const jwt = await signJwt({});
  assert.equal(await verifyAccessJwt(jwt, verifyOpts(fetchImpl)), 'ana@acme.com');
  assert.deepEqual(calls, [CERTS_URL]);
});

test('verifyAccessJwt accepts aud as an array', async () => {
  const { fetchImpl } = fakeCerts();
  const jwt = await signJwt({ aud: ['other', AUD] });
  assert.equal(await verifyAccessJwt(jwt, verifyOpts(fetchImpl)), 'ana@acme.com');
});

test('verifyAccessJwt rejects a wrong audience with 401', async () => {
  const { fetchImpl } = fakeCerts();
  const jwt = await signJwt({ aud: 'someone-else' });
  await assert.rejects(verifyAccessJwt(jwt, verifyOpts(fetchImpl)), { status: 401 });
});

test('verifyAccessJwt rejects an expired token with 401', async () => {
  const { fetchImpl } = fakeCerts();
  const jwt = await signJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
  await assert.rejects(verifyAccessJwt(jwt, verifyOpts(fetchImpl)), { status: 401 });
});

test('verifyAccessJwt rejects a tampered payload with 401', async () => {
  const { fetchImpl } = fakeCerts();
  const jwt = await signJwt({});
  const [head, , sig] = jwt.split('.');
  const forged = b64urlJson({ email: 'mallory@acme.com', aud: AUD, exp: Math.floor(Date.now() / 1000) + 600 });
  await assert.rejects(verifyAccessJwt(`${head}.${forged}.${sig}`, verifyOpts(fetchImpl)), { status: 401 });
});

test('verifyAccessJwt rejects a token signed with another key, with 401', async () => {
  const { fetchImpl } = fakeCerts();
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const jwt = await signJwt({}, { key: other.privateKey });
  await assert.rejects(verifyAccessJwt(jwt, verifyOpts(fetchImpl)), { status: 401 });
});

test('authenticate without credentials throws 401', async () => {
  const request = new Request('https://board.example/api/portal/me');
  await assert.rejects(authenticate(request, { TENANTS: '{}' }), { status: 401 });
});

test('authenticate accepts a valid Access JWT as a human', async () => {
  const { fetchImpl } = fakeCerts();
  const jwt = await signJwt({ email: 'ana@acme.com' });
  const request = new Request('https://board.example/api/portal/me', { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
  const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
  assert.deepEqual(await authenticate(request, env, { fetchImpl }), { kind: 'human', email: 'ana@acme.com' });
});

test('authenticate accepts a bearer token for the given tenant as an agent', async () => {
  const request = new Request('https://board.example/t/acme/api/contracts', {
    headers: { Authorization: 'Bearer tok-dev-1' },
  });
  const env = { TENANTS: JSON.stringify(TENANTS) };
  assert.deepEqual(await authenticate(request, env, { tenantId: 'acme' }), { kind: 'agent', role: 'dev', agent: 'dev-1' });
  await assert.rejects(authenticate(request, env, { tenantId: 'beta' }), { status: 401 });
});
