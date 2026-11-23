/**
 * chosen.js — has an employer chosen her? (asked on 2026-11-23: "if she is
 * chosen, she should be automatically in selected list").
 *
 * Musaned's "chosen" date or stage, or her employer's contract on her profile
 * (contract no., visa no. or employer ID — read from Musaned or template.pdf:
 * the profile page's "Chosen by an employer" card). A cancelled or rejected
 * request on Musaned is not chosen.
 */
const has = (v) => v != null && String(v).trim() !== ''

export function contractOf(p = {}) {
  return has(p.contract_number) || has(p.visa_number) || has(p.employer_id)
}

/** at: musanedStep(p.musaned_stage) when the caller has it (>= 0: past "chosen" on Musaned). */
export function isChosen(p = {}, at = -1) {
  if (/CANCEL|REJECT/i.test(p.musaned_stage || '')) return false
  return has(p.chosen_at) || at >= 0 || contractOf(p)
}

/** A short note for her Selected step. */
export function chosenNote(p = {}) {
  if (has(p.chosen_at)) return String(p.chosen_at).slice(0, 10)
  if (has(p.contract_number)) return `contract ${String(p.contract_number).trim()}`
  if (has(p.visa_number)) return `visa ${String(p.visa_number).trim()}`
  return 'employer chose her'
}
