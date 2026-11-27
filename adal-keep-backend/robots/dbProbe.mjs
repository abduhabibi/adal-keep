/**
 * dbProbe.mjs — where a slow statement's time goes (2026-11-27, Main: reads by index 5.9-6.0 s, also with 16 threads).
 * A connection of its own (no pool, no knex) every 10 s times: `select 1` (Node's thread pool only), a read that takes a
 * read snapshot (SQLite's locks, the WAL index, the disk), and the -wal file's size. The latest is said with every
 * "[db] slow" line, and the probe says itself when its read took over a second. At the start: the file's journal mode
 * (not "wal": a read waits for every writer). Off: ADAL_DB_PROBE=0.
 */
import fs from 'fs'

export const probeOn = (env = process.env) => env.ADAL_DB_PROBE !== '0'
export const lastProbe = { at: 0, selectMs: null, readMs: null, walMB: null, mode: '' }

/** One line of the latest probe. Pure. */
export function probeLine(p = lastProbe, now = Date.now()) {
  if (!p.at) return 'no probe yet'
  return `probe ${Math.round((now - p.at) / 1000)} s ago: select 1 ${p.selectMs} ms (threads), a read ${p.readMs} ms (locks/disk), WAL ${p.walMB} MB, ${p.mode || '?'} mode`
}

export async function startDbProbe(file, { everyMs = 10000, log = (m) => console.warn(m) } = {}) {
  if (!probeOn() || !file) return null
  let sqlite3
  try { sqlite3 = (await import('sqlite3')).default } catch { return null }
  const db = await new Promise((ok) => { const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => ok(e ? null : d)) })
  if (!db) return null
  db.configure?.('busyTimeout', 15000)
  const q = (sql) => new Promise((ok) => { const t0 = Date.now(); db.get(sql, (e, row) => ok({ ms: Date.now() - t0, row, e })) })
  const mode = (await q('PRAGMA journal_mode')).row?.journal_mode || '?'
  lastProbe.mode = mode
  log(`[db] the file is in ${mode} mode${mode === 'wal' ? '' : ' — not WAL: every read here waits for every write of Adal Keep'}`)
  const round = async () => {
    const a = await q('select 1 as x')
    const b = await q('select max(id) as m from automation_queue')
    let walMB = null
    try { walMB = Math.round(fs.statSync(file + '-wal').size / 1048576 * 10) / 10 } catch { walMB = 0 }
    Object.assign(lastProbe, { at: Date.now(), selectMs: a.ms, readMs: b.ms, walMB })
    if (b.ms > 1000 || a.ms > 1000) log(`[db] ${probeLine()}${b.e ? ` — ${b.e.message}` : ''}`)
  }
  round()
  const t = setInterval(round, everyMs); t.unref?.()
  return t
}
