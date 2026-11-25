/**
 * changedRows.js — a list is sent whole once; after that only its rows that changed.
 *
 * "One girl changed and every window loaded 1.8 MB again" (2026-11-25). A window that has
 * the list says which version it has (X-Adal-Have); it gets the rows changed since, the
 * ones gone and how many there are now — a few hundred bytes. Anything that does not fit
 * (the PC restarted, too old, no header) gets the whole list, as before.
 * Found by comparing each row with the one before, whoever changed it (a person, a robot,
 * the other PCs' copying): no writer has to say anything.
 * Off: ADAL_CHANGED_ROWS=0.
 */
import crypto from 'crypto'

// Path → where its rows are in the answer, and what names one.
export const ROWS = {
  '/api/profiles/list': { id: 'id' },
  '/api/profiles/brief': { id: 'id' },
  '/api/automations/stages': { at: 'profiles', id: 'profile_id' },
}
const boot = crypto.randomBytes(4).toString('hex')
const states = new Map()   // path → { n, rows: Map(id → [text, n, row]), gone: Map(id → n), rest, restN, floor }
const on = () => process.env.ADAL_CHANGED_ROWS !== '0'
const rowsOf = (path, body) => { const { at } = ROWS[path]; return at ? body?.[at] : body }
const restOf = (path, body) => { const { at } = ROWS[path]; if (!at) return null; const { [at]: _rows, ...rest } = body; return rest }

/** The list was just made: what differs from the one before gets a new version. */
export function made(path, body) {
  if (!ROWS[path] || !on()) return
  const list = rowsOf(path, body)
  if (!Array.isArray(list)) return
  const key = ROWS[path].id
  let s = states.get(path)
  const first = !s
  if (first) states.set(path, s = { n: 1, rows: new Map(), gone: new Map(), rest: null, restN: 1, floor: 1 })
  const n = first ? 1 : s.n + 1
  let any = false
  const rest = JSON.stringify(restOf(path, body))
  if (rest !== s.rest) { s.rest = rest; s.restN = n; any = true }
  const seen = new Set()
  for (const row of list) {
    const id = row?.[key]
    seen.add(id)
    const text = JSON.stringify(row), old = s.rows.get(id)
    if (old && old[0] === text) continue
    s.rows.set(id, [text, n]); s.gone.delete(id); any = true
  }
  if (seen.size !== list.length || seen.has(undefined)) { states.delete(path); return }   // a row twice, or without a name: always whole
  for (const id of s.rows.keys()) if (!seen.has(id)) { s.rows.delete(id); s.gone.set(id, n); any = true }
  if (any) s.n = n
  if (s.gone.size > 2000) { s.gone.clear(); s.floor = s.n }
}

export const versionOf = (path) => states.has(path) && on() ? `${boot}.${states.get(path).n}` : null

/** What changed since the version `have`, as JSON text; null = send it whole. */
export function since(path, have) {
  const s = states.get(path)
  const m = /^([0-9a-f]{8})\.(\d{1,12})$/.exec(String(have || ''))
  if (!s || !on() || !m || m[1] !== boot) return null
  const v = Number(m[2])
  if (v > s.n || v < s.floor) return null
  const head = `{"$v":"${boot}.${s.n}","$count":${s.rows.size}`
  if (v === s.n) return `${head}}`
  const set = [], gone = []
  for (const [text, n] of s.rows.values()) if (n > v) set.push(text)
  if (set.length > 40 && set.length > s.rows.size / 2) return null
  for (const [id, n] of s.gone) if (n > v) gone.push(id)
  return `${head},"$set":[${set.join(',')}],"$gone":${JSON.stringify(gone)}${s.restN > v && s.rest !== 'null' ? `,"$rest":${s.rest}` : ''}}`
}
export const _reset = () => states.clear()
