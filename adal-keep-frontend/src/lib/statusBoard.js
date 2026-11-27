/**
 * The status board (the owner, 2026-11-27): the profiles as cards in one column per status; a card dragged
 * onto another column takes that status at once (pages/StatusBoardPage.jsx).
 *
 * The status change is the profile page's own (PUT /api/profiles/:id): the server keeps its history, the
 * online copy follows it, and the robots' tasks start from it as before (autoTrigger, the task gate).
 * Off: ADAL_STATUS_BOARD=0 on the PC (asked once a window, remembered on this device), or ?adal_off=board.
 */
import api from '../services/api'
import { off } from './offSwitch'
import { STATUS_OPTIONS } from './utils'

const KEY = 'adal-status-board'
let on = (() => { try { return localStorage.getItem(KEY) !== '0' } catch { return true } })()
const asked = api.get('/app/status-board').then(r => {
  const v = r.data?.on !== false
  try { localStorage.setItem(KEY, v ? '1' : '0') } catch {}
  on = v
  return v
}).catch(() => on)   // (an older PC: no such route — shown)
export const boardOn = () => on && !off('board')
export const boardAsked = () => asked.then(() => boardOn())

/** The agency's statuses, in their order (the same list as the profile's status box). */
export const STATUSES = STATUS_OPTIONS.map(s => ({ value: s.value, label: s.label, className: s.className }))
const KNOWN = new Set(STATUSES.map(s => s.value))
/** A girl's column: her status, or the first one when it is empty or not one of the list. */
export const columnOf = (p) => (KNOWN.has(p?.status) ? p.status : STATUSES[0].value)

// What a status needs first. A medical result or "completed" without her passport number cannot be right:
// the Wafid medical is booked on the passport. (One place: add a rule here and the board says it.)
const NEEDS = {
  medical_applied: [['passport_number', 'her passport number']],
  medical_fit: [['passport_number', 'her passport number']],
  medical_rejected: [['passport_number', 'her passport number']],
  completed: [['passport_number', 'her passport number']],
}
/** null when she can take this status now; else what to add first ("Add her passport number first"). */
export function needsFirst(p, status) {
  const missing = (NEEDS[status] || []).filter(([k]) => !String(p?.[k] ?? '').trim()).map(([, what]) => what)
  return missing.length ? `Add ${missing.join(' and ')} first` : null
}

/** The column lists, newest first, for a list of girls. */
export function columns(list) {
  const out = Object.fromEntries(STATUSES.map(s => [s.value, []]))
  for (const p of list || []) out[columnOf(p)].push(p)
  for (const k of Object.keys(out)) out[k].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id - a.id)
  return out
}
