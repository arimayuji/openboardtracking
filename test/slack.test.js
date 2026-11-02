import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Contracts } from '../src/contract.js';
import { Slack, verifySlackSignature } from '../src/slack.js';

const client = { role: 'client', agent: 'c' };
const human = { role: 'human', agent: 'h' };

function setup(slackCfg = {}) {
  const s = new Contracts();
  s.updateConfig({ slack: { channel: 'C-NOTIFY', intakeChannels: ['C-BUGS'], approvers: ['U-LEAD'], ...slackCfg } }, human);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const slack = new Slack(s, { token: 'xoxb-test', fetchImpl });
  return { s, slack, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

test('signature: valid, invalid, stale and missing secret', () => {
  const raw = 'payload=x';
  const ts = 1_700_000_000;
  const sig = 'v0=' + createHmac('sha256', 'sec').update(`v0:${ts}:${raw}`).digest('hex');
  const h = { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig };
  verifySlackSignature(raw, h, 'sec', ts);
  assert.throws(() => verifySlackSignature(raw, h, 'other', ts), /invalid/);
  assert.throws(() => verifySlackSignature(raw, h, 'sec', ts + 600), /stale/);
  assert.throws(() => verifySlackSignature(raw, h, undefined, ts), /not configured/);
});

test('escalation is posted with decision buttons', async () => {
  const { s, calls } = setup();
  const c = s.createIntent({ title: 'Migrar banco', criteria: ['ok'] }, client);
  s.escalate(c.id, { reason: 'irreversível' }, client);
  await tick();
  const msg = calls.find((x) => x.url.endsWith('chat.postMessage'));
  assert.equal(msg.body.channel, 'C-NOTIFY');
  assert.equal(msg.headers.authorization, 'Bearer xoxb-test');
  const buttons = msg.body.blocks[1].elements;
  assert.deepEqual(buttons.map((b) => b.action_id), ['resolve:approve', 'resolve:renegotiate', 'resolve:cancel']);
  assert.equal(buttons[0].value, c.id);
});

test('button click from an approver resolves the escalation', async () => {
  const { s, slack, calls } = setup();
  const c = s.createIntent({ title: 'x', criteria: ['ok'] }, client);
  s.escalate(c.id, { reason: 'r' }, client);
  const r = await slack.handleInteraction({ user: { id: 'U-LEAD' }, response_url: 'https://hooks.slack.test/r', actions: [{ action_id: 'resolve:cancel', value: c.id }] });
  assert.equal(r.state, 'rejected');
  assert.equal(s.history(c.id).at(-1).agent, 'slack:U-LEAD');
  assert.equal(calls.at(-1).url, 'https://hooks.slack.test/r');
  assert.equal(calls.at(-1).body.replace_original, true);
});

test('button click from someone outside approvers is refused', async () => {
  const { s, slack } = setup();
  const c = s.createIntent({ title: 'x', criteria: ['ok'] }, client);
  s.escalate(c.id, { reason: 'r' }, client);
  const r = await slack.handleInteraction({ user: { id: 'U-RANDOM' }, actions: [{ action_id: 'resolve:approve', value: c.id }] });
  assert.equal(r.ok, false);
  assert.equal(c.state, 'escalated');
});

test('message in intake channel becomes a bug and the bot replies in thread', async () => {
  const { s, slack, calls } = setup();
  const ev = { type: 'event_callback', event_id: 'Ev1', event: { type: 'message', channel: 'C-BUGS', user: 'U-CLIENT', text: 'Checkout quebrou', ts: '111.1' } };
  const r = await slack.handleEvents(ev);
  assert.equal(r.opened, true);
  const c = s.get(r.contract);
  assert.equal(c.kind, 'bug');
  assert.equal(c.source.from, 'U-CLIENT');
  const ack = calls.at(-1).body;
  assert.equal(ack.thread_ts, '111.1');
  assert.match(ack.text, new RegExp(c.id));
  // Slack retry of the same event does not count again
  assert.equal((await slack.handleEvents(ev)).ignored, 'duplicate event');
  assert.equal(c.occurrences, 1);
});

test('ignored: other channels, bots, edits, thread replies; url verification answered', async () => {
  const { s, slack } = setup();
  const base = { type: 'event_callback', event: { type: 'message', channel: 'C-BUGS', user: 'U', text: 't', ts: '1.1' } };
  assert.match((await slack.handleEvents({ ...base, event: { ...base.event, channel: 'C-OTHER' } })).ignored, /channel/);
  assert.match((await slack.handleEvents({ ...base, event: { ...base.event, bot_id: 'B1' } })).ignored, /top-level/);
  assert.match((await slack.handleEvents({ ...base, event: { ...base.event, subtype: 'message_changed' } })).ignored, /top-level/);
  assert.match((await slack.handleEvents({ ...base, event: { ...base.event, thread_ts: '0.9' } })).ignored, /top-level/);
  assert.equal(s.state.contracts.length, 0);
  assert.deepEqual(await slack.handleEvents({ type: 'url_verification', challenge: 'abc' }), { challenge: 'abc' });
});

test('new incident is announced; digest goes out once per day at the configured hour', async () => {
  const { s, slack, calls } = setup({ digestHourUtc: 12 });
  s.openSignal({ title: '[alerta] API fora', criteria: ['ok'], kind: 'incident', classOfService: 'expedite', source: { type: 'datadog', fingerprint: 'f', link: 'https://dd/1' } }, { role: 'integration', agent: 'datadog' });
  await tick();
  assert.match(calls.at(-1).body.text, /Incidente aberto/);
  const n = calls.length;
  assert.equal(await slack.tick(new Date('2026-11-02T11:00:00Z')), false);
  assert.equal(await slack.tick(new Date('2026-11-02T12:05:00Z')), true);
  assert.equal(await slack.tick(new Date('2026-11-02T12:15:00Z')), false);
  assert.equal(calls.length, n + 1);
  assert.match(calls.at(-1).body.blocks[0].text.text, /incidentes abertos: 1/);
});

test('outside text cannot form slack links or mentions', async () => {
  const { s, calls } = setup();
  const c = s.createIntent({ title: '<!channel> <https://evil|clique>', criteria: ['ok'] }, client);
  s.escalate(c.id, { reason: 'r' }, client);
  await tick();
  assert.doesNotMatch(calls.at(-1).body.blocks[0].text.text, /<!channel>/);
});

test('without token or channel nothing is sent', async () => {
  const s = new Contracts();
  let called = false;
  new Slack(s, { token: undefined, fetchImpl: async () => { called = true; } });
  const c = s.createIntent({ title: 'x', criteria: ['ok'] }, client);
  s.escalate(c.id, { reason: 'r' }, client);
  await tick();
  assert.equal(called, false);
});
