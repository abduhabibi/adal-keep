/**
 * What a passport page's text says (asked on 2026-11-17: read the passport on
 * the phone itself, fast, with the PC off). Plain text work only — the reading
 * of the picture is lib/passportHere.js (the phone) and the accuracy test on the PC.
 *
 *   mrzIn(text)            the two bottom lines (MRZ) whose ICAO check digits all
 *                          verify — number, birth, expiry and the overall digit —
 *                          as the PC's own reader takes them (backend quickMrz.js)
 *   fieldsOf(m)            the profile's fields from them
 *   placeFromLines(lines)  the place of birth: the line right under the
 *                          "Place of Birth" label, found by its position
 *   placeFromRow(text)     the place of birth from the one row where it sits
 */
import { parseTD3, fitLine2 } from './mrz.js'

export function mrzIn(text) {
  const ls = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, '').toUpperCase()).filter(l => l.length >= 30)
  for (let i = 0; i < ls.length - 1; i++) {
    if (!/^P[A-Z<]/.test(ls[i])) continue
    const m = parseTD3(`${ls[i].padEnd(44, '<').slice(0, 44)}\n${fitLine2(ls[i + 1]).padEnd(44, '<').slice(0, 44)}`)
    if (!m?.overall_verified || !m.passport_number_verified || !m.date_of_birth_verified || !m.date_of_expiry_verified) continue
    if (!/^[A-Z ]{2,}$/.test(m.surname || '') || !/^[A-Z ]{2,}$/.test(m.given_names || '')) continue
    return { ...m, line: i }
  }
  return null
}

/** Her profile's fields from the verified lines (Ethiopian names: her name, her father's, her grandfather's). */
export function fieldsOf(m) {
  const given = String(m.given_names || '').trim().split(/\s+/).filter(Boolean)
  return {
    full_name: `${m.given_names} ${m.surname}`.replace(/\s+/g, ' ').trim(),
    first_name: given[0] || '', middle_name: given.slice(1).join(' '), last_name: m.surname || '',
    surname: m.surname, given_names: m.given_names,
    passport_number: m.passport_number, date_of_birth: m.date_of_birth,
    passport_expiry_date: m.date_of_expiry, date_of_expiry: m.date_of_expiry,
    gender: m.sex, sex: m.sex, nationality: m.nationality_code,
  }
}

// The value is printed in capitals; the labels are mixed case (and Amharic).
const LABEL = /place\s*of\s*birth|birth\s*place|of\s*birth/i
const NOT_A_PLACE = /^(ETH|ETHIOPIA|ETHIOPIAN|FEMALE|MALE|PASSPORT|NATIONALITY|SEX|DATE|ISSUE|AUTHORITY|MAIN|DEPARTMENT|IMMIGRATION|ICS|INVEA|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/
// Her place: one or two capital words side by side (4 letters or more — a
// 3-letter piece is a month or a code), the first such run on the line.
function capitals(text) {
  for (const run of String(text || '').split(/[^A-Z'\- ]+/)) {
    const words = run.trim().split(/\s+/).filter(w => w.length >= 4 && !NOT_A_PLACE.test(w))
    if (words.length) return words.slice(0, 2).join(' ')
  }
  return ''
}

/** lines: [{ text, bbox: { x0, y0, x1, y1 } }] of the page above the MRZ, top to bottom. */
export function placeFromLines(lines) {
  const ls = (lines || []).filter(l => String(l.text || '').trim())
  const i = ls.findIndex(l => LABEL.test(l.text))
  if (i < 0) return ''
  const lab = ls[i].bbox
  // The line right below the label (the first one under it that overlaps it sideways).
  for (const l of ls.slice(i + 1, i + 4)) {
    const b = l.bbox
    if (b.y0 < lab.y0) continue
    if (b.x1 < lab.x0 - (lab.x1 - lab.x0) * 0.3) continue
    const v = capitals(l.text)
    if (v) return v
  }
  return ''
}

export const placeFromRow = (text) => String(text || '').split(/\r?\n/).map(capitals).find(Boolean) || ''

/** Where the value can sit, in MRZ-widths from the MRZ's left edge and its top (the two passport designs). */
// Measured on 14 of our passports where the label was read (2026-11-17).
export const PLACE_ROWS = [
  { x0: 0.27, x1: 0.88, up0: 0.36, up1: 0.295 },  // the newer design: the value 0.31–0.34 above the MRZ
  { x0: 0.52, x1: 0.92, up0: 0.275, up1: 0.228 }, // the older one: 0.24–0.26, in the right-hand column
]
