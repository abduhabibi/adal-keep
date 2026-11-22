/**
 * rollback.js — "Go back to previous version" with one click (asked on 2026-11-22).
 *
 * Only Adal's PC has the signing key, so the way back is signed AHEAD of time:
 * every release X carries, inside its own signed manifest, a second signed
 * envelope `rollback` = the release before it (Y) re-issued as a deliberate
 * rollback: Y's code and pieces, `rollback_of: X.sha`, and a publish order
 * (seq / published_at) just after X's. Every PC already takes a release only
 * when it is newer (lanRelease.isNewer / selfupdate.go isNewerRelease), and an
 * older commit only with `rollback_of` — so the envelope goes round the office
 * over the LAN like any update, while Supabase's X is not taken again (it is
 * not newer than the rollback). The next real release (seq = its publish time)
 * is newer than both and moves everyone forward.
 *
 * A bare downgrade is never possible: only a signed envelope whose
 * `rollback_of` names the release this PC runs is used.
 *
 * The database: each manifest names its migrations (`migrations`). When this
 * PC's database has a migration the older version does not know, going back
 * is refused (the older code would not start: knex calls the folder corrupt).
 */
import { verifyManifest } from './updateChannel.js'

/** The rollback envelope X → Y: Y's manifest, re-issued just after X (signed by the caller). */
export function rollbackManifest(cur, back, { migrations } = {}) {
  if (!cur?.sha || !back?.sha) throw new Error('both releases are needed')
  if (cur.sha === back.sha) throw new Error('the release before is the same one')
  const after = Date.parse(cur.published_at || '') || Number(cur.seq) || Date.now()
  const { rollback: _r, notes: _n, ...y } = back
  return {
    ...y,
    // Just after X: newer than X on every PC, older than any later release.
    seq: (Number(cur.seq) || after) + 1,
    published_at: new Date(after + 1).toISOString(),
    everyone_at: new Date(after + 1).toISOString(),
    early: [],
    rollback_of: cur.sha,
    migrations: migrations || back.migrations || null,
    notes: [`This PC went back to the version before (${back.short || back.sha.slice(0, 7)}), because the newest one (${cur.short || cur.sha.slice(0, 7)}) had a problem. Your data is kept.`],
    changes: [{ short: back.short, date: new Date(after + 1).toISOString(), message: `Back to the version before (${cur.short || cur.sha.slice(0, 7)} had a problem)` }],
  }
}

/** The signed way back that `manifest` (the release this PC runs) carries, or null. */
export function rollbackOf(manifest) {
  const r = manifest?.rollback
  if (!r?.manifest || !verifyManifest(r.manifest, r.signature)) return null
  if (r.manifest.rollback_of !== manifest.sha || r.manifest.sha === manifest.sha) return null
  return { manifest: r.manifest, signature: r.signature }
}

/** The migrations this database has run that `allowed` (a release's list) does not know. Null list: cannot tell. */
export async function migrationsAhead(db, allowed) {
  if (!Array.isArray(allowed)) return null
  if (!db) return []
  let rows = []
  try { rows = await db('knex_migrations').select('name') } catch { return [] } // no table yet: nothing ahead
  const known = new Set(allowed.map(n => String(n).replace(/\.(c|m)?js$/, '')))
  return rows.map(r => String(r.name)).filter(n => !known.has(n.replace(/\.(c|m)?js$/, '')))
}

/** The reason a release cannot go on this database (or ''): only for an older one (a rollback). */
export async function databaseRefusal(db, manifest) {
  if (!manifest?.rollback_of) return ''
  const ahead = await migrationsAhead(db, manifest.migrations)
  if (ahead === null) return 'Going back is refused: this release does not say which database changes it knows, so it may not be able to read this PC\'s data. Ask Adal for a fixed new version instead.'
  if (!ahead.length) return ''
  return `Going back is refused: the newer version already changed this PC's database (${ahead.length} change${ahead.length === 1 ? '' : 's'}: ${ahead.slice(0, 3).join(', ')}${ahead.length > 3 ? ', …' : ''}). The version before cannot read it. Your data is safe on the version you have — ask Adal for a fixed new version instead.`
}
