/**
 * pcHealth.js — the PC's own dangers, found before they hurt:
 *   - the disk filling up (documents, backups and the database stop being saved);
 *   - the database damaged (checked once a day: PRAGMA quick_check);
 *   - a server that froze and was restarted (watchdog.js, data/last-freeze.json).
 * Each shows in the notification bar on this PC (attention calls) and goes to
 * Adal Keep Admin with the PC's health (diag.js).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LOW_DISK_MB = 3 * 1024
const DAY = 24 * 3600 * 1000

let state = { at: null, disk: null, database: null, freeze: null }
let timer = null

/** Free space on the disk that holds Adal Keep, in MB. */
export function diskFree(dir = BACKEND) {
  try { const s = fs.statfsSync(dir); return { free_mb: Math.round(s.bavail * s.bsize / 1048576), total_mb: Math.round(s.blocks * s.bsize / 1048576) } } catch { return null }
}

export async function checkDatabase(db) {
  const at = new Date().toISOString()
  try {
    const row = (await db.raw('PRAGMA quick_check'))?.[0]
    const said = row ? String(Object.values(row)[0]) : 'ok'
    let size_mb = null
    try { size_mb = Math.round(fs.statSync(path.join(BACKEND, 'data.sqlite')).size / 104857.6) / 10 } catch {}
    return { ok: said === 'ok', at, why: said === 'ok' ? null : said.slice(0, 200), size_mb }
  } catch (e) { return { ok: false, at, why: String(e.message).slice(0, 200) } }
}

function lastFreeze() {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(BACKEND, 'data', 'last-freeze.json'), 'utf8'))
    return Date.now() - Date.parse(f.at) < 7 * DAY ? f : null
  } catch { return null }
}

export async function checkPC(db, { withDatabase = true } = {}) {
  state = {
    at: new Date().toISOString(),
    disk: diskFree(),
    database: withDatabase ? await checkDatabase(db) : state.database,
    freeze: lastFreeze(),
  }
  if (state.disk && state.disk.free_mb < LOW_DISK_MB) console.error(`[pc] the disk is almost full: ${state.disk.free_mb} MB free`)
  if (state.database && !state.database.ok) console.error(`[pc] the database check failed: ${state.database.why}`)
  return state
}

export const pcStatus = () => state

/** For the notification bar on this PC (attention calls; negative numbers are not runs). */
export function pcCalls(s = state) {
  const out = []
  if (s.disk && s.disk.free_mb < LOW_DISK_MB) out.push({ run_id: -101, full_name: 'This PC', title: `The disk is almost full: ${(s.disk.free_mb / 1024).toFixed(1)} GB left`, body: 'Free some space (empty the Recycle Bin, move old files away), or documents and backups stop being saved.', at: Date.parse(s.at) || Date.now(), image: null })
  if (s.database && !s.database.ok) out.push({ run_id: -102, full_name: 'This PC', title: 'The database check found a problem', body: 'Adal has been told. Keep working; do not turn the PC off while it saves. The backup has a good copy.', at: Date.parse(s.database.at) || Date.now(), image: null })
  return out
}

export function startPCHealth(db) {
  if (timer || process.env.NODE_ENV === 'test') return
  setTimeout(() => checkPC(db).catch(() => {}), 3 * 60 * 1000).unref?.()
  // The disk every 30 minutes, the database once a day.
  let lastDb = Date.now()
  timer = setInterval(() => {
    const withDatabase = Date.now() - lastDb >= DAY
    if (withDatabase) lastDb = Date.now()
    checkPC(db, { withDatabase }).catch(() => {})
  }, 30 * 60 * 1000)
  timer.unref?.()
}
