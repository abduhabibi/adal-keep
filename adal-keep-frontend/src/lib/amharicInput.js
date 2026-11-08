/**
 * Typing Amharic with any keyboard (the checklist's notes): letters typed in
 * Latin become Ge'ez as they are typed, the way people already write Amharic
 * in Latin letters:
 *   b → ብ   be → በ   bu → ቡ   bi → ቢ   ba → ባ   bie / bE → ቤ   bo → ቦ
 *   sh → ሽ  ch / c → ች  ny / N → ኝ  zh / Z → ዥ  T → ጥ  C → ጭ  P → ጵ  S → ጽ
 *   q → ቅ   H → ሕ   a e u i o alone → አ ኡ ኢ ኦ …   .. → ።   , → ፣
 * Works on phones too (it looks at what was added to the box, not at keys).
 */
import { createElement as h, useState } from 'react'

// The 1st form (ä) of each consonant; its 7 forms follow in Unicode.
const BASE = {
  h: 0x1200, l: 0x1208, H: 0x1210, m: 0x1218, r: 0x1228, s: 0x1230, x: 0x1238, q: 0x1240, b: 0x1260, v: 0x1268,
  t: 0x1270, c: 0x1278, n: 0x1290, N: 0x1298, k: 0x12A8, K: 0x12B8, w: 0x12C8, z: 0x12D8, Z: 0x12E0, y: 0x12E8,
  d: 0x12F0, j: 0x1300, g: 0x1308, T: 0x1320, C: 0x1328, P: 0x1330, S: 0x1338, f: 0x1348, p: 0x1350,
}
const VOWEL = { e: 0, u: 1, i: 2, a: 3, E: 4, o: 6 }     // the form each vowel gives
const ALONE = { a: 'አ', e: 'እ', u: 'ኡ', i: 'ኢ', E: 'ኤ', o: 'ኦ' }
// Two letters that make one sound: ስ+h → ሽ, ት/ች+h → ች, ዝ+h → ዥ, ን+y → ኝ, ክ+h → ኽ
const PAIR = { 's+h': 'x', 'c+h': 'c', 't+h': 'c', 'z+h': 'Z', 'n+y': 'N', 'k+h': 'K' }

const baseOf = (ch) => {
  const cp = ch?.codePointAt(0)
  if (!cp) return null
  for (const [key, b] of Object.entries(BASE)) if (cp >= b && cp < b + 8) return { key, form: cp - b }
  return null
}
const form = (key, n) => String.fromCodePoint(BASE[key] + n)

/** One typed Latin letter after `prev` → { drop: replace prev?, add: what to write }. */
export function amharicKey(prev, letter) {
  const p = baseOf(prev)
  const v = letter in VOWEL ? letter : /^[AUIO]$/.test(letter) ? letter.toLowerCase() : null
  if (v) {
    if (p && p.form === 5) return { drop: true, add: form(p.key, VOWEL[v]) }                 // ብ + a → ባ
    if (p && p.form === 2 && v === 'e') return { drop: true, add: form(p.key, 4) }           // ቢ + e → ቤ
    if (prev === 'እ' && v === 'e') return { drop: true, add: 'ኤ' }
    return { drop: false, add: ALONE[v] }
  }
  const L = BASE[letter] ? letter : BASE[letter.toLowerCase()] ? letter.toLowerCase() : null
  if (L) {
    const pair = p && p.form === 5 && PAIR[`${p.key}+${L}`]
    if (pair) return { drop: true, add: form(pair, 5) }                                      // ስ + h → ሽ
    return { drop: false, add: form(L, 5) }
  }
  if (letter === '.' && prev === '.') return { drop: true, add: '።' }
  if (letter === ',') return { drop: false, add: '፣' }
  return { drop: false, add: letter }
}

/** Turns a whole Latin text into Amharic (as if typed letter by letter). */
export function toAmharic(text) {
  let out = ''
  for (const ch of String(text)) {
    if (!/[A-Za-z.,]/.test(ch)) { out += ch; continue }
    const r = amharicKey(out.slice(-1), ch)
    out = (r.drop ? out.slice(0, -1) : out) + r.add
  }
  return out
}

/**
 * onInput of a text box: what was just added in Latin becomes Amharic.
 * (Compares with the text before, so it works with phone keyboards that send whole words.)
 */
export function typeAmharic(e) {
  const el = e.target
  const was = el.dataset.was ?? ''
  const now = el.value
  // What changed: the same start and end, something new in the middle.
  let a = 0
  while (a < was.length && a < now.length && was[a] === now[a]) a++
  let b = 0
  while (b < was.length - a && b < now.length - a && was[was.length - 1 - b] === now[now.length - 1 - b]) b++
  const added = now.slice(a, now.length - b)
  if (!added || !/[A-Za-z.,]/.test(added)) { el.dataset.was = now; return }
  let head = now.slice(0, a)
  for (const ch of added) {
    if (!/[A-Za-z.,]/.test(ch)) { head += ch; continue }
    const r = amharicKey(head.slice(-1), ch)
    head = (r.drop ? head.slice(0, -1) : head) + r.add
  }
  const tail = now.slice(now.length - b)
  el.value = head + tail
  el.setSelectionRange(head.length, head.length)
  el.dataset.was = el.value
}

const KEY = 'adal-type-amharic'
/** Amharic typing on or off (kept on this device). */
export function useAmharicTyping() {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(KEY) === '1' } catch { return false } })
  const set = (v) => { setOn(v); try { localStorage.setItem(KEY, v ? '1' : '0') } catch {} }
  return [on, set]
}

/** The switch: አ (type Amharic) | A (type English). */
export function AmharicKeys({ on, onChange }) {
  const btn = (active) => `px-2.5 py-1.5 transition ${active ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`
  return h('span', { translate: 'no', title: 'Type the notes in Amharic (አ) or English (A)', className: 'inline-flex shrink-0 overflow-hidden rounded-lg border border-slate-300 text-sm font-semibold dark:border-slate-600' },
    h('button', { type: 'button', 'aria-pressed': on, onClick: () => onChange(true), className: btn(on) }, 'አ'),
    h('button', { type: 'button', 'aria-pressed': !on, onClick: () => onChange(false), className: btn(!on) }, 'A'))
}
