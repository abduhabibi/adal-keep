/**
 * Musaned's own contract stages, in order (its tabs): EPRO approval → EPRO
 * approved → FMOL approval → FMOL approved → Sent to the Saudi Embassy → Visa
 * issued → Arrived KSA.
 */
export const MUSANED_ORDER = [
  [/EPRO\s*APPROVAL/i, 'epro'], [/EPRO\s*APPROVED/i, 'epro_approved'],
  [/FMOL\s*APPROVAL/i, 'fmol'], [/FMOL\s*APPROVED/i, 'fmol_approved'],
  [/EMBASSY/i, 'embassy'], [/VISA\s*ISSUED/i, 'visa_issued'], [/ARRIVED/i, 'arrived'],
]

/** Where she is on Musaned's contract tabs: 0 (EPRO approval) … 6 (arrived), -1 = none. */
export function musanedStep(stage) {
  const s = String(stage || '')
  if (/CANCEL|REJECT/i.test(s)) return -1
  return MUSANED_ORDER.findIndex(([re]) => re.test(s))
}

/**
 * The stage to keep when Musaned shows `next` and Adal Keep has `had`: a
 * contract stage only moves forward; a plain HR-pool status ("Available")
 * never overwrites a contract stage. null = keep what is there.
 */
export function newerStage(had, next) {
  const n = String(next || '').trim().toUpperCase()
  if (!n || n === String(had || '').trim().toUpperCase()) return null
  const a = musanedStep(had), b = musanedStep(n)
  if (b >= 0) return b >= a ? n : null
  if (/CANCEL|REJECT/i.test(n)) return n
  return a < 0 ? n : null
}
