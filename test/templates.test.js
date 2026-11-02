import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATES,
  AREAS,
  getTemplate,
  templatesByArea,
  intentFromTemplate,
} from '../src/templates.js';

test('every area has at least 2 templates', () => {
  const grouped = templatesByArea();
  for (const area of AREAS) {
    assert.ok((grouped[area.id] || []).length >= 2, `área ${area.id} com menos de 2 modelos`);
  }
  assert.ok(TEMPLATES.length >= 10);
});

test('ids are unique and kebab-case', () => {
  const ids = TEMPLATES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test('every template has 3-5 criteria and non-empty summary and description', () => {
  for (const t of TEMPLATES) {
    assert.ok(t.criteria.length >= 3 && t.criteria.length <= 5, `${t.id}: critérios`);
    assert.ok(t.summary.trim().length > 0, `${t.id}: summary`);
    assert.ok(t.description.trim().length > 0, `${t.id}: description`);
  }
});

test('sensitive areas are flagged and carry a data protection criterion', () => {
  for (const t of TEMPLATES.filter((t) => t.area === 'saude')) {
    assert.equal(t.sensitive, 'lgpd', t.id);
    assert.ok(t.criteria.some((c) => /acessíveis só/.test(c)), `${t.id}: critério de proteção`);
  }
  for (const t of TEMPLATES.filter((t) => t.area === 'direito')) {
    assert.equal(t.sensitive, 'sigilo', t.id);
    assert.ok(t.criteria.some((c) => /acessíveis só/.test(c)), `${t.id}: critério de proteção`);
  }
});

test('intentFromTemplate overrides title and copies criteria', () => {
  const template = getTemplate('rh-relatorio-turnover');
  const intent = intentFromTemplate(template, { title: 'Meu título', budget: { costUsd: 10 } });
  assert.equal(intent.title, 'Meu título');
  assert.equal(intent.goal, template.description);
  assert.deepEqual(intent.criteria, template.criteria);
  assert.notEqual(intent.criteria, template.criteria);
  assert.deepEqual(intent.budget, { costUsd: 10 });
  assert.equal(intent.area, template.area);
  assert.equal(intent.irreversible, template.irreversible);
  assert.equal(intent.sensitive, template.sensitive);
});

test('intentFromTemplate uses template title when no override is given', () => {
  const template = getTemplate('economia-painel-indicadores');
  const intent = intentFromTemplate(template);
  assert.equal(intent.title, template.title);
  assert.equal(Object.hasOwn(intent, 'budget'), false);
});

test('getTemplate returns null for unknown ids', () => {
  assert.equal(getTemplate('nao-existe'), null);
});

test('no template text contains forbidden technical words', () => {
  const forbidden = /(?<![\p{L}\p{N}])(PR|token|WIP|deploy|API)(?![\p{L}\p{N}])/iu;
  for (const t of TEMPLATES) {
    const text = [t.title, t.summary, t.description, ...t.criteria].join(' ');
    assert.doesNotMatch(text, forbidden, t.id);
  }
});
