/**
 * changedOnly.js — what changed since a job's last look, from the change log (sync_log).
 *
 * Every row anyone changes (a person, a robot, another PC, Adal Robots) goes into sync_log with a
 * running number per PC (sync/engine.js, at most 20 s later). A job that runs every few minutes asks
 * here which girls changed since its last look, instead of going over all of them.
 *
 *   const look = await changedGirls(db, 'agency')
 *   look.ids        null: all of them (the first look after a start, every 6 hours, no change log
 *                   here, or the job switched off) — else a Set of profile ids (empty: nothing to do)
 *   look.done()     the job ended well: the next look starts from here
 *
 * Off: ADAL_CHANGED_ONLY=0 (every job looks at everything, as before), or one job:
 * ADAL_CHANGED_ONLY_<NAME>=0.
 */
const ALL_EVERY = 6 * 3600 * 1000
// Tables that say something about a girl, and how a row points at her.
const OWN = { profiles: null, automation_queue: 'profile_id', profile_fields: 'profile_id', generated_cvs: 'profile_id', tasks: 'profile_id', profile_automations: 'profile_id', document_verifications: 'profile_id', whatsapp_sends: 'profile_id' }
const MAX = 2000                      // more rows than this: everything (a move, a restore)
const at = new WeakMap()              // db → name → { vec, allAt }

const off = (name) => process.env.ADAL_CHANGED_ONLY === '0' || process.env[`ADAL_CHANGED_ONLY_${name.toUpperCase()}`] === '0'
const ALL = { ids: null, others: true, done() {} }

/** others: tables without a girl in them that changed too (settings, accounts, brokers …): Set of names. */
export async function changedGirls(db, name, { ignore = [], now = Date.now() } = {}) {
  if (off(name)) return ALL
  try {
    const jobs = at.get(db) || at.set(db, new Map()).get(db)
    const was = jobs.get(name)
    const top = Object.fromEntries((await db.raw('SELECT origin, MAX(seq) AS s FROM sync_log GROUP BY origin')).map(r => [r.origin, Number(r.s)]))
    if (!Object.keys(top).length) return ALL
    const done = (all) => () => jobs.set(name, { vec: top, allAt: all ? now : was.allAt })
    if (!was || now - was.allAt >= ALL_EVERY) return { ids: null, others: true, done: done(true) }
    const rows = []
    for (const [o, s] of Object.entries(top)) {
      if (s <= (was.vec[o] || 0)) continue
      rows.push(...await db.raw('SELECT DISTINCT tbl, rid FROM sync_log WHERE origin = ? AND seq > ? AND seq <= ? LIMIT ?', [o, was.vec[o] || 0, s, MAX + 1]))
      if (rows.length > MAX) return { ids: null, others: true, done: done(true) }
    }
    const by = {}
    for (const r of rows) if (!ignore.includes(r.tbl) && !/^(sync_|audit_log|feature_use|profile_days|run_history)/.test(r.tbl)) (by[r.tbl] ||= new Set()).add(String(r.rid))
    const ids = new Set([...(by.profiles || [])].map(Number)), others = new Set()
    for (const [t, set] of Object.entries(by)) {
      const rids = [...set]
      for (let i = 0; i < rids.length; i += 400) {
        const part = rids.slice(i, i + 400)
        if (t === 'files') (await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id').whereIn('files.id', part).pluck('profile_fields.profile_id')).forEach(x => ids.add(Number(x)))
        else if (OWN[t]) (await db(t).whereIn('id', part).pluck(OWN[t])).forEach(x => x != null && ids.add(Number(x)))
        else if (!(t in OWN)) others.add(t)
      }
    }
    return { ids, others, done: done(false) }
  } catch { return ALL }              // no change log (copying off): everything, as before
}
export const _forget = (db) => at.delete(db)
