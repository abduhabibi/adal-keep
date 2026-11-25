/**
 * Number of children: 0 unless a person wrote another number (asked on 2026-11-25) — never
 * asked, shown as 0 when read, saved as 0 with the next save; a number she has (her own, or
 * the one on her Musaned contract, which the CV prints) is kept.
 * Off: ADAL_CHILDREN_ZERO=0.
 */
import { fieldsFromContract } from './contractFields.js'

export const childrenOn = () => process.env.ADAL_CHILDREN_ZERO !== '0'
const blank = (v) => v === null || v === undefined || String(v).trim() === ''

/** Her number when none is written on her: her contract's, else 0. */
function unwritten(p) {
  if (!p || blank(p.contract_data)) return 0
  try { const n = fieldsFromContract({ ...p, children_count: null })?.children_count; return Number(n) > 0 ? Number(n) : 0 } catch { return 0 }
}

/** Before a profile is saved: `data` is written, `current` her saved row (null: a new girl). Changes `data`, returns it. */
export function withChildren(data, current = null) {
  try {
    if (!data || !childrenOn()) return data
    if (data.children_count !== undefined ? blank(data.children_count) : blank(current?.children_count)) {
      // A blank sent for a girl who has a number (an older page that never had the box): kept.
      if (data.children_count !== undefined && !blank(current?.children_count)) delete data.children_count
      else data.children_count = unwritten({ ...current, ...data })
    }
  } catch {}
  return data
}

/** A profile read: no number shows as 0 (nothing is written). */
export function fillChildren(p) {
  try { if (p && 'children_count' in p && childrenOn() && blank(p.children_count)) p.children_count = unwritten(p) } catch {}
  return p
}
