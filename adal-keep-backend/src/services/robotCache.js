/**
 * robotCache.js — what a robot found on a portal once, kept for next time
 * (asked on 2026-11-23: "make it faster than the employees … searching
 * through cache"). A lookup that took a whole search on the site (her
 * passport → her Musaned HR Pool page) is answered from here, and the robot
 * goes straight to the page. The portal stays the truth: a page that no
 * longer shows her is forgotten and searched again (see musanedImport.js).
 *
 * Its own small table on this PC (robot_lookups: key, value, expires_at),
 * made when first used; never sent to other PCs or the online copy.
 */
const TABLE = 'robot_lookups'
const made = new WeakMap()

function ensure(db) {
  if (!made.has(db)) {
    made.set(db, (async () => {
      if (await db.schema.hasTable(TABLE)) return
      await db.schema.createTable(TABLE, t => { t.string('key').primary(); t.text('value'); t.bigInteger('expires_at') })
    })().catch((e) => { made.delete(db); throw e }))
  }
  return made.get(db)
}

/** The kept value, or null (none, or older than its time). */
export async function lookup(db, key) {
  try {
    await ensure(db)
    const row = await db(TABLE).where({ key }).first()
    if (!row) return null
    if (Number(row.expires_at) < Date.now()) { await db(TABLE).where({ key }).del(); return null }
    return JSON.parse(row.value)
  } catch { return null }
}

/** Keep it for `days` (30 by default). */
export async function remember(db, key, value, { days = 30 } = {}) {
  try {
    await ensure(db)
    const row = { key, value: JSON.stringify(value), expires_at: Date.now() + days * 86400000 }
    await db(TABLE).insert(row).onConflict('key').merge()
  } catch (e) { console.warn('[robotCache] keep:', e.message) }
}

export async function forget(db, key) {
  try { await ensure(db); await db(TABLE).where({ key }).del() } catch {}
}
