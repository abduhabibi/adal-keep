/**
 * Has an employer chosen her? Musaned's "chosen" date, or her employer's
 * contract on her profile (contract no., visa no. or employer ID) — the same
 * rule as the backend's services/chosen.js. A cancelled or rejected request is not.
 */
const has = (v) => v != null && String(v).trim() !== ''

export function isChosen(p = {}) {
  if (/CANCEL|REJECT/i.test(p.musaned_stage || '')) return false
  return has(p.chosen_at) || has(p.contract_number) || has(p.visa_number) || has(p.employer_id)
}
