/**
 * The Profiles page's phases (its tabs), from each girl's journey steps
 * ({ cv: 'done', musaned: 'waiting', … } — /automations/stages).
 *
 * CV → Musaned → Waiting (on Musaned, nobody chose her yet) → Selected
 * (chosen, Wafid not booked) → Wafid (booked, waiting for the result) →
 * Unfit (medical rejected) → EPRO → the steps after it, in the agency's order.
 * The furthest step she reached counts: a step skipped before it is behind her
 * (shown as "skipped" on her card).
 */
export const FIRST = [['cv', 'CV'], ['musaned', 'Musaned'], ['waiting', 'Waiting'], ['selected', 'Selected'], ['wafid', 'Wafid'], ['unfit', 'Unfit'], ['epro', 'EPRO']]
// The steps up to the EPRO, in order (the "skipped" badges).
export const STEPS_TO_EPRO = [['cv', 'CV'], ['musaned', 'Musaned'], ['selected', 'Selected'], ['wafid', 'Wafid'], ['epro', 'EPRO']]

/** Each step up to the EPRO: ticked or not. */
export function ticksToEpro(steps = {}, p = {}) {
  return [steps.cv === 'done', ['done', 'waiting'].includes(steps.musaned), steps.selected === 'done',
    p.status === 'medical_fit' || steps.wafid === 'done', steps.epro === 'done']
}
const furthest = (ok) => { let r = -1; ok.forEach((v, i) => { if (v) r = i }); return r }

/**
 * Waiting: on Musaned, nobody chose her yet, nothing after it done, not UNFIT.
 * The only girls whose CVs may go to agents on WhatsApp (the backend's
 * inWaitingPhase in routes/automations.js says the same).
 */
export function inWaitingPhase(steps = {}, p = {}) {
  return furthest(ticksToEpro(steps, p)) === 1 && p.status !== 'medical_rejected'
}

/** Her phase (a tab key). after: [[title, key, label]…] the steps after the EPRO, in order. */
export function phaseOf(steps = {}, p = {}, after = []) {
  const reached = furthest(ticksToEpro(steps, p))
  if (reached < 0) return 'cv'
  // Before the EPRO a rejected medical is its own tab.
  if (reached < 3 && p.status === 'medical_rejected') return 'unfit'
  if (reached === 0) return 'musaned'
  if (reached === 1) return 'waiting'
  if (reached === 2) return p.status === 'medical_applied' || ['active', 'failed'].includes(steps.wafid) ? 'wafid' : 'selected'
  if (reached === 3) return 'epro'
  // Past the EPRO: the first step (in the agency's order) not done yet.
  return after.find(([, k]) => steps[k] !== 'done')?.[1] || 'choices'
}

/**
 * Her card's marks: up to the EPRO, a step not ticked while a later one is
 * ("skipped"); after the EPRO the stages can come in any order, so no
 * "skipped" there — each finished one is marked done.
 */
export function stepMarks(steps = {}, p = {}, after = []) {
  const ok = ticksToEpro(steps, p)
  const reached = furthest(ok)
  return {
    skipped: STEPS_TO_EPRO.filter((_, i) => i < reached && !ok[i]).map(([, label]) => label),
    done: after.filter(([, k]) => steps[k] === 'done').map(([, , label]) => label),
  }
}
