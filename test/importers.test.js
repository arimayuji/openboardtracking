import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Contracts } from '../src/contract.js';
import { calibrate } from '../src/estimate.js';
import { parseCsv, importHistory } from '../src/importers.js';

const human = { role: 'human', agent: 'ops' };

test('parseCsv handles quotes, escaped quotes, newlines in quotes, CRLF, BOM and empty lines', () => {
  const text = '﻿title,notes\r\n"Fix, the ""login""","line1\nline2"\r\n\r\n,\r\nplain,x\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [
    { title: 'Fix, the "login"', notes: 'line1\nline2' },
    { title: '', notes: '' },
    { title: 'plain', notes: 'x' },
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('jira done row: estimate 4h, actual 8h, accepted with assignee and import delivery', () => {
  const s = new Contracts();
  const csv = [
    'Summary,Status,Original Estimate,Time Spent,Created,Resolved,Assignee,Issue Type',
    'Add export,Done,14400,28800,2024-03-04T09:00:00.000Z,2024-03-08T17:00:00.000Z,ana,Story',
  ].join('\n');
  const res = importHistory(s, { format: 'jira', csv }, human);
  assert.equal(res.imported, 1);
  assert.equal(res.done, 1);
  assert.equal(res.calibrationSamples, 1);
  const [c] = s.state.contracts;
  assert.equal(c.state, 'accepted');
  assert.equal(c.title, 'Add export');
  assert.equal(c.proposal.estimate.hours, 4);
  assert.equal(c.usage.hours, 8);
  assert.equal(c.assignee, 'ana');
  assert.equal(c.startedAt, '2024-03-04T09:00:00.000Z');
  assert.equal(c.acceptedAt, '2024-03-08T17:00:00.000Z');
  assert.equal(c.createdAt, '2024-03-04T09:00:00.000Z');
  assert.deepEqual(c.delivery, { imported: true, results: {}, at: '2024-03-08T17:00:00.000Z' });
  assert.deepEqual(c.source, { type: 'import', format: 'jira' });
  assert.equal(s.history(c.id)[0].type, 'import');
});

test('jira story points use hoursPerPoint, custom field header, and open rows stay negotiating', () => {
  const s = new Contracts();
  const csv = [
    'Summary,Status,Custom field (Story Points),Created,Assignee,Issue Type',
    '"Refactor, billing",In Progress,2,2024-05-01T10:00:00Z,bia,Bug',
  ].join('\n');
  importHistory(s, { format: 'jira', csv, hoursPerPoint: 3 }, human);
  const [c] = s.state.contracts;
  assert.equal(c.state, 'negotiating');
  assert.equal(c.title, 'Refactor, billing');
  assert.equal(c.proposal.estimate.hours, 6);
  assert.equal(c.delivery, null);
  assert.equal(c.kind, 'bug');
  assert.equal(c.assignee, null);
});

test('linear: done needs a Completed date; canceled without one stays open', () => {
  const s = new Contracts();
  const csv = [
    'Title,Status,Estimate,Created,Completed,Assignee,Labels',
    'Ship login,Done,5,2024-02-01T09:00:00Z,2024-02-02T09:00:00Z,joao,backend',
    'Old idea,Canceled,,2024-02-01T09:00:00Z,,,',
    'Maybe,Canceled,2,2024-02-01T09:00:00Z,2024-02-03T09:00:00Z,joao,',
  ].join('\n');
  const res = importHistory(s, { format: 'linear', csv, hoursPerPoint: 2 }, human);
  assert.equal(res.done, 2);
  assert.equal(res.open, 1);
  const [a, b, c] = s.state.contracts;
  assert.equal(a.state, 'accepted');
  assert.equal(a.proposal.estimate.hours, 10);
  assert.equal(a.assignee, 'joao');
  assert.equal(a.acceptedAt, '2024-02-02T09:00:00.000Z');
  assert.equal(b.state, 'negotiating');
  assert.equal(b.title, 'Old idea');
  assert.equal(c.state, 'accepted');
});

test('trello: done list detection (done, feito, concluído) and open otherwise; no estimate', () => {
  const s = new Contracts();
  const csv = [
    'Card Name,List Name,Labels,Due Date,Last Activity Date',
    'Card A,Done,,,2024-06-01T12:00:00Z',
    'Card B,Feito,,,2024-06-02T12:00:00Z',
    'Card C,Concluído,,,2024-06-03T12:00:00Z',
    'Card D,To Do,,2024-07-01,2024-06-04T12:00:00Z',
  ].join('\n');
  const res = importHistory(s, { format: 'trello', csv }, human);
  assert.equal(res.done, 3);
  assert.equal(res.open, 1);
  assert.deepEqual(s.state.contracts.map((c) => c.state), ['accepted', 'accepted', 'accepted', 'negotiating']);
  assert.equal(res.calibrationSamples, 0);
  assert.deepEqual(s.state.contracts[0].proposal.estimate, {});
});

test('generic format: status, estimate, actual, kind and dates are read as given', () => {
  const s = new Contracts();
  const csv = [
    'title,status,estimate_hours,actual_hours,started_at,finished_at,assignee,kind',
    'Hotfix pay,done,2,3.5,2024-08-01T08:00:00Z,2024-08-01T12:00:00Z,lia,incident',
    'Next thing,open,8,,,,,',
  ].join('\n');
  const res = importHistory(s, { format: 'generic', csv }, human);
  assert.equal(res.calibrationSamples, 1);
  const [a, b] = s.state.contracts;
  assert.equal(a.kind, 'incident');
  assert.equal(a.usage.hours, 3.5);
  assert.equal(a.proposal.estimate.hours, 2);
  assert.equal(a.assignee, 'lia');
  assert.equal(b.state, 'negotiating');
  assert.equal(b.kind, 'feature');
  assert.equal(b.proposal.estimate.hours, 8);
});

test('actual falls back to weekday hours (8h/day, min 0.5h) when no time was spent', () => {
  const s = new Contracts();
  const csv = [
    'title,status,estimate_hours,started_at,finished_at',
    'Span,done,4,2024-01-08T09:00:00Z,2024-01-10T17:00:00Z',
    'Quick,done,1,2024-01-08T10:00:00Z,2024-01-08T10:20:00Z',
    'Weekend,done,1,2024-01-06T10:00:00Z,2024-01-07T10:00:00Z',
  ].join('\n');
  importHistory(s, { format: 'generic', csv }, human);
  const [span, quick, weekend] = s.state.contracts;
  assert.equal(span.usage.hours, 24); // Mon 8h, Tue 8h, Wed 8h
  assert.equal(quick.usage.hours, 0.5);
  assert.equal(weekend.usage.hours, 0.5);
});

test('rows without a title are skipped with their 1-based data row number', () => {
  const s = new Contracts();
  const csv = [
    'Summary,Status,Assignee',
    'Good one,Done,ana',
    ' ,Done,ana',
    'Also good,To Do,',
  ].join('\n');
  const res = importHistory(s, { format: 'jira', csv }, human);
  assert.equal(res.imported, 2);
  assert.deepEqual(res.skipped, [{ row: 2, reason: 'título ausente' }]);
  assert.equal(s.state.contracts.length, 2);
});

test('only humans import (403) and unknown formats are rejected (400)', () => {
  const s = new Contracts();
  const csv = 'Summary,Status\nX,Done\n';
  assert.throws(() => importHistory(s, { format: 'jira', csv }, { role: 'dev', agent: 'dev-a' }), { status: 403 });
  assert.throws(() => importHistory(s, { format: 'jira', csv }, { role: 'integration', agent: 'x' }), { status: 403 });
  assert.throws(() => importHistory(s, { format: 'excel', csv }, human), { status: 400, message: /formato desconhecido/ });
  assert.equal(s.state.contracts.length, 0);
});

test('five jira done rows at 2x estimate calibrate the assignee to p50 20 on 10h', () => {
  const s = new Contracts();
  const rows = Array.from({ length: 5 }, (_, i) =>
    `Task ${i},Done,14400,28800,2024-04-0${i + 1}T09:00:00Z,2024-04-0${i + 1}T18:00:00Z,ana,Story`);
  const csv = ['Summary,Status,Original Estimate,Time Spent,Created,Resolved,Assignee,Issue Type', ...rows].join('\n');
  const res = importHistory(s, { format: 'jira', csv }, human);
  assert.equal(res.calibrationSamples, 5);
  const r = calibrate(s, { hours: 10 }, 'ana');
  assert.equal(r.hours.source, 'agent');
  assert.equal(r.hours.p50, 20);
  assert.equal(r.hours.samples, 5);
});

test('import does not check WIP or escalate, and saves once', () => {
  let saves = 0;
  const s = new Contracts({ persist: () => { saves++; } });
  s.state.config.wip = { building: 0, perAgent: 0, escalated: 0, expedite: 0 };
  const csv = ['Summary,Status,Assignee', 'A,Done,ana', 'B,In Progress,ana'].join('\n');
  importHistory(s, { format: 'jira', csv }, human);
  assert.equal(s.state.contracts.length, 2);
  assert.ok(s.state.contracts.every((c) => c.state !== 'escalated'));
  assert.equal(saves, 1);
});
