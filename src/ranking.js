// Ranking for the dev team: which open work gives the most value per hour of effort.
// score = valueScore / max(0.5, p85Hours). Work without estimate goes to needsEstimate;
// work waiting on other contracts goes to blocked. Parents with children are not work themselves.
import { calibrate } from './estimate.js';

const OPEN = ['negotiating', 'agreed'];
const DEFAULT_VALUE = 3;
const round2 = (n) => Math.round(n * 100) / 100;

function reasonFor(valueScore, p85Hours) {
  if (valueScore >= 4 && p85Hours <= 8) return 'Alto valor e rápido de fazer';
  if (valueScore >= 4 && p85Hours > 24) return 'Alto valor, mas grande: considere dividir';
  if (valueScore <= 2 && p85Hours > 8) return 'Baixo valor para o esforço';
  return 'Valor e esforço equilibrados';
}

export function ranking(store) {
  const contracts = store.state.contracts;
  const stateOf = new Map(contracts.map((c) => [c.id, c.state]));
  const open = contracts.filter((c) => OPEN.includes(c.state) && !(c.childIds?.length));
  const ranked = [], needsEstimate = [], blocked = [];

  for (const c of open) {
    const valueScore = c.valueScore ?? DEFAULT_VALUE;
    const blockedBy = (c.dependsOn ?? []).filter((id) => stateOf.get(id) !== 'accepted');
    if (blockedBy.length) {
      blocked.push({ id: c.id, title: c.title, blockedBy });
      continue;
    }
    const estHours = c.proposal?.estimate?.hours;
    const p85Hours = c.proposal?.calibrated?.hours?.p85
      ?? (estHours != null ? calibrate(store, { hours: estHours }, c.assignee).hours.p85 : null);
    if (p85Hours == null) {
      needsEstimate.push({ id: c.id, title: c.title, valueScore });
      continue;
    }
    ranked.push({
      id: c.id,
      title: c.title,
      valueScore,
      valueBrl: c.valueBrl ?? null,
      p85Hours,
      score: round2(valueScore / Math.max(0.5, p85Hours)),
      reason: reasonFor(valueScore, p85Hours),
    });
  }

  ranked.sort((a, b) => b.score - a.score || b.valueScore - a.valueScore);
  return { ranked, needsEstimate, blocked };
}
