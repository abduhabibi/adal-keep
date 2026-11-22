/**
 * updateTrail.js — which version each PC of the office runs, and since when
 * (asked on 2026-11-22: prove that PCs update each other over the office
 * network). The main PC sees every Companion's version in its heartbeat; the
 * first time it sees a PC on a version is written down, and the list goes
 * online in the health report (keep_meta "/_diag", `pcs`), so Adal can read
 * the timestamps without being on the office network.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const FILE = process.env.ADAL_UPDATE_TRAIL || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'update-trail.json')
const KEEP = 200

const read = () => { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(j) ? j : [] } catch { return [] } }
const write = (rows) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(rows.slice(-KEEP))) } catch {} }

/**
 * Notes what each PC runs now. pcs: [{ name, version, main?, seen? }]. A PC seen
 * on a version for the first time gets `since` = now. Returns the list with
 * `since`, newest changes last in `trail`.
 */
export function noteVersions(pcs, now = Date.now()) {
  const rows = read()
  let changed = false
  const out = []
  for (const p of pcs) {
    if (!p?.name || !p.version) { out.push({ ...p, since: null }); continue }
    let hit = rows.find(r => r.name === p.name && r.version === p.version)
    if (!hit) { hit = { name: p.name, version: p.version, since: new Date(now).toISOString() }; rows.push(hit); changed = true }
    out.push({ name: p.name, main: !!p.main, version: p.version, since: hit.since, seen: p.seen || null })
  }
  if (changed) write(rows)
  return out
}

/** This main PC and the Companions it hears: name, version, since when, last heard. */
export async function pcsNow(own = {}, devices = null, now = Date.now()) {
  let list = devices
  if (!list) { try { list = (await import('./remoteBrowsers.js')).liveDevices(now) } catch { list = [] } }
  return noteVersions([
    { name: os.hostname(), main: true, version: own.version || null, seen: new Date(now).toISOString() },
    ...list.map(d => ({ name: d.name, version: d.version || null, seen: new Date(d.at || now).toISOString() })),
  ], now)
}
