/**
 * passportRetry.js — a passport whose place of birth or date of issue could not be read
 * (Gemini busy or out of quota, a blurred picture) is tried again later, not skipped for ever.
 *
 * Every 5 minutes the profiles with a passport picture and one of the two still empty are
 * tried again — local reading first, Gemini for what is left (passportDetails.js) — at
 * most MAX_TRIES times each, waiting longer between tries (10 min, 20 min, …). The tries
 * are kept in the settings table, so a restart does not forget them or start over.
 * Nothing typed is ever overwritten (fillPassportDetails fills only empty fields).
 * ADAL_PASSPORT_RETRY=0 turns it off. Every error is caught here.
 */
export const MAX_TRIES = 5
const KEY = 'passport_details_tries_v1'
const WAIT_MIN = 10

export const dueAfter = (n, at) => Date.parse(at || 0) + n * WAIT_MIN * 60000

async function load(db) {
  try { return JSON.parse((await db('settings').where('key', KEY).first())?.value || '{}') } catch { return {} }
}
async function save(db, state) {
  const value = JSON.stringify(state)
  const had = await db('settings').where('key', KEY).first()
  if (had) await db('settings').where('key', KEY).update({ value })
  else await db('settings').insert({ key: KEY, value })
}

/** One round: returns how many profiles were tried. */
export async function retryRound(db, { now = Date.now(), log = console.log, limit = 2, ask = null } = {}) {
  if (process.env.ADAL_PASSPORT_RETRY === '0') return 0
  try {
    const { fillPassportDetails, passportImageOf } = await import('./passportDetails.js')
    const rows = await db('profiles')
      .whereNotNull('passport_number').where('passport_number', '<>', '')
      .where(q => q.whereNull('place_of_birth').orWhere('place_of_birth', '').orWhereNull('passport_issue_date').orWhere('passport_issue_date', ''))
      .select('id')
    const state = await load(db)
    const open = new Set(rows.map(r => String(r.id)))
    for (const id of Object.keys(state)) if (!open.has(id)) delete state[id]   // filled meanwhile: forgotten
    let tried = 0
    for (const { id } of rows) {
      if (tried >= limit) break
      const s = state[id] || { n: 0, at: null }
      if (s.n >= MAX_TRIES || (s.n > 0 && now < dueAfter(s.n, s.at))) continue
      const img = await passportImageOf(db, id).catch(() => null)
      state[id] = { n: s.n + 1, at: new Date(now).toISOString() }
      if (!img) continue
      tried++
      try {
        const got = await fillPassportDetails(db, id, img, log, { retry: true, ask })
        if (Object.keys(got || {}).length) log(`[passport retry] profile #${id}: filled ${Object.keys(got).join(', ')} on try ${state[id].n}`)
      } catch (e) { log(`[passport retry] profile #${id}: ${e.message}`) }
      await save(db, state)
    }
    await save(db, state)
    return tried
  } catch (e) { log(`[passport retry] ${e.message}`); return 0 }
}

/** Start the rounds (the main PC only); returns the timer. */
export function startPassportRetry(db, { main = true } = {}) {
  if (!main || process.env.ADAL_PASSPORT_RETRY === '0') return null
  const t = setInterval(() => retryRound(db), 5 * 60000)
  t.unref?.()
  setTimeout(() => retryRound(db), 90000).unref?.()
  return t
}
