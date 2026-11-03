// Slack integration.
//
// Out (needs SLACK_BOT_TOKEN and config.slack.channel):
// - escalations are posted with Approve / Renegotiate / Cancel buttons
// - new incidents are posted as soon as they open
// - daily digest (config.slack.digestHourUtc) or on demand
//
// In (needs SLACK_SIGNING_SECRET; every request is signature checked):
// - Events API: top-level messages in config.slack.intakeChannels become bug reports,
//   and the bot answers in the thread with the contract id
// - Interactivity: button clicks resolve escalations, only for Slack users in
//   config.slack.approvers (empty list = nobody can decide from Slack)
import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from './contract.js';
import { handleMessage, quickWins } from './intake.js';
import { flow } from './flow.js';
import { retro } from './retro.js';

const MAX_SKEW_SECONDS = 300;
const DECISIONS = { approve: 'Aprovar', renegotiate: 'Renegociar', cancel: 'Cancelar' };

export function verifySlackSignature(raw, headers, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret) throw httpError(503, 'SLACK_SIGNING_SECRET is not configured');
  const ts = Number(headers['x-slack-request-timestamp']);
  const sig = headers['x-slack-signature'];
  if (!ts || !sig) throw httpError(401, 'missing slack signature');
  if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) throw httpError(401, 'stale slack request');
  const expected = Buffer.from('v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex'));
  const got = Buffer.from(String(sig));
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw httpError(401, 'invalid slack signature');
}

export class Slack {
  constructor(store, { token = process.env.SLACK_BOT_TOKEN, fetchImpl = globalThis.fetch } = {}) {
    this.store = store;
    this.token = token;
    this.fetch = fetchImpl;
    store.state.slack ??= { lastDigest: null };
    store.onEvent((ev) => this.onEvent(ev).catch((e) => console.error('slack notify failed:', e.message)));
  }

  get cfg() { return this.store.config.slack; }

  async api(method, body) {
    if (!this.token) return null;
    const res = await this.fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
    return data;
  }

  post(text, blocks, extra = {}) {
    if (!this.cfg.channel) return Promise.resolve(null);
    return this.api('chat.postMessage', { channel: this.cfg.channel, text, ...(blocks ? { blocks } : {}), ...extra });
  }

  async onEvent(ev) {
    const c = ev.contract;
    if (ev.type === 'escalated' && c) {
      const reason = ev.data?.reason ?? '';
      return this.post(`Escalonamento: ${c.title}. ${reason}`, escalationBlocks(c, reason));
    }
    if (ev.type === 'intent' && ev.data?.kind === 'incident' && c) {
      const full = this.store.get(c.id);
      return this.post(`Incidente aberto: ${c.title}`, [
        section(`:rotating_light: *Incidente aberto* (urgente)\n*${escapeMrkdwn(c.title)}*\nContrato \`${c.id}\`${full.source?.link ? ` · <${full.source.link}|alerta>` : ''}`),
      ]);
    }
    return null;
  }

  // ---- inbound ----

  async handleEvents(payload) {
    if (payload.type === 'url_verification') return { challenge: payload.challenge };
    // Slack retries deliveries it thinks failed; the same event must not count twice.
    const seen = (this.store.state.slack.seenEvents ??= []);
    if (payload.event_id) {
      if (seen.includes(payload.event_id)) return { ok: true, ignored: 'duplicate event' };
      seen.push(payload.event_id);
      if (seen.length > 200) seen.splice(0, seen.length - 200);
    }
    const e = payload.event;
    if (payload.type !== 'event_callback' || e?.type !== 'message') return { ok: true, ignored: 'not a message' };
    // Bot messages, edits, joins and thread replies are not new reports.
    if (e.bot_id || e.subtype || (e.thread_ts && e.thread_ts !== e.ts)) return { ok: true, ignored: 'not a top-level user message' };
    if (!this.cfg.intakeChannels.includes(e.channel)) return { ok: true, ignored: 'channel not configured for intake' };
    const r = handleMessage(this.store, { source: 'slack', from: e.user, text: e.text, link: `slack:${e.channel}:${e.ts}` });
    if (r.opened) {
      await this.api('chat.postMessage', { channel: e.channel, thread_ts: e.ts, text: `Registrado como bug \`${r.contract}\`. Vamos acompanhar por aqui.` })
        .catch((err) => console.error('slack ack failed:', err.message));
    }
    return r;
  }

  async handleInteraction(payload) {
    const action = payload.actions?.[0];
    const [kind, decision] = String(action?.action_id ?? '').split(':');
    if (kind !== 'resolve' || !DECISIONS[decision]) return { ok: true, ignored: 'unknown action' };
    const user = payload.user?.id;
    if (!this.cfg.approvers.includes(user)) {
      await this.reply(payload.response_url, { response_type: 'ephemeral', replace_original: false, text: 'Você não está na lista de aprovadores desta plataforma.' });
      return { ok: false, error: 'not an approver' };
    }
    const id = action.value;
    try {
      const c = this.store.resolve(id, { decision }, { role: 'human', agent: `slack:${user}` });
      await this.reply(payload.response_url, {
        replace_original: true,
        text: `${DECISIONS[decision]}: ${c.title}`,
        blocks: [section(`*${escapeMrkdwn(c.title)}* (\`${c.id}\`)\nDecisão: *${DECISIONS[decision]}* por <@${user}>. Estado agora: \`${c.state}\`.`)],
      });
      return { ok: true, contract: c.id, state: c.state };
    } catch (e) {
      await this.reply(payload.response_url, { response_type: 'ephemeral', replace_original: false, text: `Não foi possível decidir: ${e.message}` });
      return { ok: false, error: e.message };
    }
  }

  reply(url, body) {
    if (!url) return Promise.resolve();
    return this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .catch((e) => console.error('slack reply failed:', e.message));
  }

  // ---- digest ----

  digestText() {
    const s = this.store.summary(24);
    const f = flow(this.store);
    const q = quickWins(this.store);
    const lines = [
      '*Resumo das últimas 24h*',
      `Aceitos: ${s.acceptedRecently.length} · em execução: ${s.counts.building} · aguardando aceite: ${s.counts.delivered}`,
      `Bugs abertos: ${s.openByKind.bug} · incidentes abertos: ${s.openByKind.incident}`,
      `Gasto na janela: ${s.spendInWindow.hours}h · ${s.spendInWindow.tokens} tokens · US$ ${s.spendInWindow.costUsd}`,
      s.costPerAcceptedUsd != null ? `Custo médio por entrega aceita: US$ ${s.costPerAcceptedUsd}` : null,
      f.cycleTimeHours.samples ? `Cycle time P85: ${f.cycleTimeHours.p85}h · throughput: ${f.throughput.perDay}/dia` : null,
      s.needsHuman.length ? `*Precisam de decisão humana (${s.needsHuman.length}):*\n${s.needsHuman.map((x) => `• \`${x.id}\` ${escapeMrkdwn(x.title)}: ${escapeMrkdwn(x.reason)}`).join('\n')}` : 'Nenhuma decisão humana pendente.',
      f.stale.length ? `*Parados (${f.stale.length}):* ${f.stale.map((id) => `\`${id}\``).join(', ')}` : null,
      q.quickWins.length ? `*Quick wins (${q.quickWins.length}):*\n${q.quickWins.slice(0, 5).map((x) => `• \`${x.id}\` ${escapeMrkdwn(x.title)} (P85 ${x.p85Hours}h)`).join('\n')}` : null,
      q.needsEstimate.length ? `Bugs e incidentes sem estimativa: ${q.needsEstimate.length}` : null,
      ...this.learningLines(),
    ];
    return lines.filter(Boolean).join('\n');
  }

  // "O que aprender": up to 3 findings from the last 7 days that need attention.
  learningLines() {
    const items = retro(this.store, { days: 7 }).findings.filter((f) => f.severity === 'atenção' || f.severity === 'alta');
    if (!items.length) return [];
    return ['*O que aprender:*', ...items.slice(0, 3).map((f) => `• ${escapeMrkdwn(f.text)}`)];
  }

  sendDigest() {
    const text = this.digestText();
    return this.post('Resumo diário', [section(text)]).then(() => ({ ok: true, text }));
  }

  // Called periodically; sends at most once per UTC day at the configured hour.
  async tick(now = new Date()) {
    const hour = this.cfg.digestHourUtc;
    if (hour == null || now.getUTCHours() !== Number(hour)) return false;
    const day = now.toISOString().slice(0, 10);
    if (this.store.state.slack.lastDigest === day) return false;
    this.store.state.slack.lastDigest = day;
    this.store.save();
    await this.sendDigest();
    return true;
  }
}

function escalationBlocks(c, reason) {
  return [
    section(`:warning: *Precisa de decisão humana*\n*${escapeMrkdwn(c.title)}* (\`${c.id}\`)\nMotivo: ${escapeMrkdwn(reason)}`),
    {
      type: 'actions',
      elements: Object.entries(DECISIONS).map(([d, label]) => ({
        type: 'button',
        action_id: `resolve:${d}`,
        text: { type: 'plain_text', text: label },
        value: c.id,
        ...(d === 'approve' ? { style: 'primary' } : d === 'cancel' ? { style: 'danger' } : {}),
      })),
    },
  ];
}

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
// Slack mrkdwn control characters; keeps outside text from forming links or mentions.
const escapeMrkdwn = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
