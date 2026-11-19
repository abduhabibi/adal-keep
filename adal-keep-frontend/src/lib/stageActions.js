/**
 * Which buttons a profile shows at each stage (asked on 2026-11-19: "a profile
 * in the CV stage doesn't need the daily check-up or Print Tasheer").
 *
 * THE ONE PLACE for it: the profile page, its AI Actions, the Profiles list
 * (its tabs' buttons and the selection bar), the phone and the Companion all
 * ask shows() here. The table, in words: docs/stage-buttons.md.
 *
 * The stages are the Profiles page's phases (lib/phase.js):
 *   cv → musaned → waiting → selected → wafid → epro → (after the EPRO, in the
 *   agency's order: tasheer · insurance · embassy (Visa) · police) → choices (Ready)
 *   and unfit (Wafid said UNFIT), off the line.
 *
 * Each action: `at` its own stages; `next: true` also the stage right after
 * its last own one (in the agency's order — a redo there is common); `also`
 * more stages; `from` every stage from that one to Ready; `all` everywhere.
 * An action not listed here, or a phase not known yet, shows (nothing is
 * hidden by mistake).
 */
import { AFTER } from './phase.js'

export const BEFORE_EPRO = ['cv', 'musaned', 'waiting', 'selected', 'wafid', 'epro']

/** Every stage in order (after: [[title, key, label]…] the steps after the EPRO, in the agency's order). */
export const stageOrder = (after = AFTER) => [...BEFORE_EPRO, ...after.map(([, k]) => k), 'choices']

export const ACTIONS = {
  // ── Everywhere ────────────────────────────────────────────────────────────
  back:            { label: '← Back', where: 'Profile header', all: true },
  edit:            { label: '✏️ Edit', where: 'Profile header and bottom', all: true },
  delete:          { label: '🗑️ Delete', where: 'Profile header', all: true },
  create_cv:       { label: '📄 Create CV', where: 'Profile header, Generated CVs, CVs page', all: true },
  cv_list:         { label: 'Generated CVs: open · download · delete', where: 'Profile', all: true },
  documents:       { label: 'Documents & Fields: upload · open · 🖨 Print slip · refine photo', where: 'Profile', all: true },
  labor_id:        { label: 'Labor ID (click to change)', where: 'Profile', all: true },
  notes:           { label: 'Notes', where: 'Profile', all: true },
  prioritize:      { label: 'Prioritize (during a move)', where: 'Profile header, list cards', all: true },
  checklist:       { label: '📋 Checklist (new or add)', where: 'Selection bar', all: true },
  excel:           { label: '📥 Excel download / other formats', where: 'Selection bar', all: true },
  open_profile:    { label: 'Open profile', where: 'List cards, broker lists, missing sheet', all: true },

  // ── CV ────────────────────────────────────────────────────────────────────
  make_cv:         { label: '📄 Make her CV (step box)', where: 'AI Actions', at: ['cv'], next: true },

  // ── Musaned ───────────────────────────────────────────────────────────────
  musaned_add_candidate: { label: 'Musaned: Add candidate', where: 'AI Actions', at: ['musaned'], next: true },
  musaned_cv_import:     { label: 'Musaned: Add from Musaned', where: 'AI Actions', at: ['musaned', 'waiting'], next: true },
  musaned_check_chosen:  { label: 'Musaned: Check if chosen', where: 'AI Actions', at: ['waiting'], next: true },
  musaned_scan:          { label: 'Check now (Musaned list of new selections)', where: 'Profiles page, Waiting tab', at: ['waiting'] },
  whatsapp_send:         { label: '💬 Send CV to agents on WhatsApp', where: 'Profile, selection bar', at: ['waiting'] },
  // The daily check-up: Musaned looks at her every 2 hours, kept day by day (and FMOL).
  day_by_day:            { label: 'Day by day / FMOL (the daily check-up)', where: 'Profile', from: 'waiting' },
  musaned_delete:        { label: 'Musaned: Delete from Musaned', where: 'AI Actions', at: ['waiting', 'selected', 'wafid', 'epro'], also: ['unfit'] },

  // ── Wafid ─────────────────────────────────────────────────────────────────
  wafid_book:      { label: 'Wafid: Book medical', where: 'AI Actions', at: ['selected'], next: true },
  wafid_slip:      { label: 'Wafid: Appointment slip', where: 'AI Actions', at: ['selected', 'wafid'] },
  wafid_check:     { label: 'Wafid: Check result', where: 'AI Actions', at: ['wafid'], next: true, also: ['unfit'] },
  medical_battery: { label: 'Medical battery (set the date)', where: 'Profile header', from: 'selected' },

  // ── EPRO ──────────────────────────────────────────────────────────────────
  musaned_epro_approve: { label: 'Musaned: EPRO approve', where: 'AI Actions', at: ['epro'], next: true },

  // ── After the EPRO (the agency's order) ───────────────────────────────────
  tasheer_schedule:      { label: '🛂 Tasheer appointment / Make Tasheer (group)', where: 'AI Actions, selection bar', at: ['tasheer'], next: true },
  insurance_certificate: { label: '🛡️ Insurance certificate / Make insurance (group)', where: 'AI Actions, selection bar', at: ['insurance'], next: true },
  mofa_visa:             { label: 'Visa: Make visa (Enjaz)', where: 'AI Actions', at: ['embassy'], next: true },
  mofa_find_app:         { label: 'Visa: Find application number', where: 'AI Actions', at: ['embassy'], next: true },
  mofa_pay:              { label: 'Visa: Pay visa fees', where: 'AI Actions', at: ['embassy'], next: true },
  visa_barcodes:         { label: 'Visa barcodes: find / type the application number', where: 'Profile', at: ['embassy'], next: true, also: ['choices'] },
  print_embassy:         { label: '🖨 Print for embassy / Print embassy', where: 'Profile, selection bar', at: ['embassy'], next: true, also: ['choices'] },
  police_certificate:    { label: 'LMIS: Police certificate', where: 'AI Actions', at: ['police'], next: true },
  // FetaP issues the certificate about a day after the request: it comes back to her Documents.
  insurance_fetch:       { label: '🛡️ Get insurance certificate', where: 'AI Actions', at: ['insurance'], next: true },
  // Chosen on Musaned and Wafid FIT: the LMIS contract (it also starts by itself then).
  lmis_contract:         { label: 'LMIS: Create contract', where: 'AI Actions', at: ['wafid', 'epro'], next: true },
}

/** The stages an action shows on, in order (unfit last when it is one of them). */
export function stagesOf(key, after = AFTER) {
  const a = ACTIONS[key]
  const order = stageOrder(after)
  if (!a || a.all) return [...order, 'unfit']
  const out = new Set([...(a.at || []), ...(a.also || [])])
  if (a.from) order.slice(Math.max(0, order.indexOf(a.from))).forEach(s => out.add(s))
  if (a.next) {
    const last = Math.max(...(a.at || []).map(s => order.indexOf(s)))
    if (last >= 0 && order[last + 1]) out.add(order[last + 1])
  }
  return [...order, 'unfit'].filter(s => out.has(s))
}

/** Does this action show for a girl at this phase? An unknown phase or action: yes. */
export function shows(key, phase, after = AFTER) {
  if (!phase || !ACTIONS[key] || ACTIONS[key].all) return true
  return stagesOf(key, after).includes(phase)
}

/** For several girls at once (the selection bar): shows if it does for any of them. */
export function showsForAny(key, phases = [], after = AFTER) {
  if (!phases.length) return true
  return phases.some(ph => shows(key, ph, after))
}
