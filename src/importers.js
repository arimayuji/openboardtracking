// Import past and ongoing work from Jira, Linear, Trello or a generic CSV as contracts,
// so estimation calibration starts with real history instead of guesses.
// Mapping rules: docs/spec-portal.md, "Importação de histórico".
import { httpError, KINDS } from './contract.js';

const HOURS_PER_BUSINESS_DAY = 8;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// RFC 4180: quoted fields, "" escapes, commas and newlines inside quotes, CRLF or LF.
// Returns one object per data row, keyed by the header as written. Fully empty lines are ignored.
export function parseCsv(text = '') {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // Only a line with no characters at all is ignored; ",," is a row with empty cells.
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (!nonEmpty.length) return [];
  const [header, ...body] = nonEmpty;
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, j) => [k, r[j] ?? ''])));
}

// importHistory(store, { format, csv, hoursPerPoint }, actor) -> summary.
// Only humans import. Skipped rows report their 1-based data row number and a reason.
export function importHistory(store, { format, csv = '', hoursPerPoint = 4 } = {}, actor) {
  if (actor?.role !== 'human') throw httpError(403, 'only human can import history');
  if (!Object.hasOwn(MAPPERS, format)) throw httpError(400, `formato desconhecido: ${format}; use jira, linear, trello ou generic`);

  const out = { imported: 0, done: 0, open: 0, skipped: [], calibrationSamples: 0 };
  parseCsv(csv).forEach((raw, i) => {
    const rec = MAPPERS[format](lowerKeys(raw), hoursPerPoint);
    if (!rec.title) { out.skipped.push({ row: i + 1, reason: 'título ausente' }); return; }

    const estimateHours = rec.estimateHours > 0 ? round2(rec.estimateHours) : null;
    const source = { type: 'import', format };
    const startIso = iso(rec.start);
    const kind = rec.kind;

    if (rec.done) {
      const atIso = iso(rec.finish ?? rec.start) ?? new Date().toISOString();
      // Time actually spent wins; otherwise the business hours between start and finish.
      const actualHours = rec.timeSpentHours > 0 ? round2(rec.timeSpentHours) : round2(businessHours(rec.start, rec.finish));
      store.importContract({
        title: rec.title, kind, source, estimateHours, actualHours, state: 'accepted', assignee: rec.assignee,
        startedAt: startIso, acceptedAt: atIso, delivery: { imported: true, results: {}, at: atIso },
        createdAt: startIso ?? atIso,
      }, actor);
      out.done++;
      if (estimateHours && actualHours > 0) out.calibrationSamples++;
    } else {
      store.importContract({
        title: rec.title, kind, source, estimateHours, actualHours: 0, state: 'negotiating', createdAt: startIso ?? undefined,
      }, actor);
      out.open++;
    }
    out.imported++;
  });
  store.save();
  return out;
}

// ---- format mappers: raw row (lowercase keys) -> { title, done, kind, estimateHours, timeSpentHours, start, finish, assignee }

const MAPPERS = {
  jira(r, hoursPerPoint) {
    const points = num(f(r, 'story points', 'custom field (story points)'));
    const seconds = num(f(r, 'original estimate'));
    const type = f(r, 'issue type').toLowerCase();
    return {
      title: f(r, 'summary'),
      done: ['done', 'closed', 'resolved'].includes(f(r, 'status').toLowerCase()),
      kind: type === 'bug' ? 'bug' : type === 'incident' ? 'incident' : 'feature',
      estimateHours: seconds != null ? seconds / 3600 : points != null ? points * hoursPerPoint : null,
      timeSpentHours: (num(f(r, 'time spent')) ?? 0) / 3600,
      start: parseDate(f(r, 'created')),
      finish: parseDate(f(r, 'resolved')),
      assignee: f(r, 'assignee') || null,
    };
  },

  linear(r, hoursPerPoint) {
    const status = f(r, 'status').toLowerCase();
    const completed = parseDate(f(r, 'completed'));
    const points = num(f(r, 'estimate'));
    return {
      title: f(r, 'title'),
      // Done, Completed or Canceled count as done only when the export has a Completed date.
      done: ['done', 'completed', 'canceled'].includes(status) && completed !== null,
      kind: 'feature',
      estimateHours: points != null ? points * hoursPerPoint : null,
      timeSpentHours: 0,
      start: parseDate(f(r, 'created')),
      finish: completed,
      assignee: f(r, 'assignee') || null,
    };
  },

  trello(r) {
    const list = f(r, 'list name').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    return {
      title: f(r, 'card name'),
      done: /done|feito|concluido/.test(list),
      kind: 'feature',
      estimateHours: null,
      timeSpentHours: 0,
      start: null,
      finish: parseDate(f(r, 'last activity date')),
      assignee: null,
    };
  },

  generic(r) {
    const kind = f(r, 'kind').toLowerCase();
    return {
      title: f(r, 'title'),
      done: f(r, 'status').toLowerCase() === 'done',
      kind: KINDS.includes(kind) ? kind : 'feature',
      estimateHours: num(f(r, 'estimate_hours')),
      timeSpentHours: num(f(r, 'actual_hours')) ?? 0,
      start: parseDate(f(r, 'started_at')),
      finish: parseDate(f(r, 'finished_at')),
      assignee: f(r, 'assignee') || null,
    };
  },
};

// ---- helpers

// First non-empty value among the given (lowercase) column names, trimmed.
function f(r, ...names) {
  for (const n of names) {
    const v = (r[n] ?? '').trim();
    if (v !== '') return v;
  }
  return '';
}

function lowerKeys(raw) {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), String(v ?? '').trim()]));
}

function num(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ISO dates, plus Jira's "02/Jan/24 10:00 AM". Times without zone are read as UTC.
function parseDate(v) {
  if (!v) return null;
  const jira = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(v);
  if (jira) {
    const [, d, mon, y, h, mi, s = '0', ap] = jira;
    const month = MONTHS[mon.toLowerCase()];
    if (month === undefined) return null;
    let hour = Number(h);
    if (ap) hour = (hour % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0);
    const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
    return new Date(Date.UTC(year, month, Number(d), hour, Number(mi), Number(s)));
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

// Hours between start and finish on weekdays, at most 8h per day. Minimum 0.5 when start < finish.
function businessHours(start, finish) {
  if (!start || !finish || finish.getTime() <= start.getTime()) return 0;
  const DAY = 864e5;
  const s = start.getTime();
  const e = finish.getTime();
  let total = 0;
  for (let d = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()); d < e; d += DAY) {
    const weekday = new Date(d).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const overlap = (Math.min(e, d + DAY) - Math.max(s, d)) / 36e5;
    total += Math.min(HOURS_PER_BUSINESS_DAY, Math.max(0, overlap));
  }
  return Math.max(0.5, total);
}

const iso = (d) => (d ? d.toISOString() : null);
const round2 = (n) => Math.round(n * 100) / 100;
