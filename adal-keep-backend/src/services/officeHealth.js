/**
 * officeHealth.js — how the office's PCs are doing (asked on 2026-11-22):
 *   1. one row per agency PC: who is signed in on it, its version, when it was
 *      last seen, its Wi-Fi signal, whether it reaches the other PCs over the
 *      office network, and how old its copy / backup is;
 *   2. the morning backup line: "Backup OK – 3 PCs hold a full copy", or the PC
 *      that is behind, named by the person signed in on it;
 *   3. the end-of-day card (from 17:00) and one phone push at 17:30.
 * Built from what the LAN layer already knows: the Companions' heartbeat
 * (remoteBrowsers.js), their copy reports (replica.js) and the backup state
 * (telegramBackup.js). The main PC answers for every PC; a Companion's window
 * shows the same page (it opens the main PC's pages).
 */
import os from 'os'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOUR = 3600e3, DAY = 24 * HOUR
export const FRESH_MS = 26 * HOUR          // a copy / backup newer than this is "today's"
export const SEEN_MS = 3 * 60e3            // a Companion heard in the last 3 minutes is online
export const SUMMARY_FROM = 17 * 60        // minutes after midnight: the card appears
export const PUSH_AT = 17 * 60 + 30        // the one phone push

// ── who is signed in on each PC ─────────────────────────────────────────────
const presence = new Map()                 // pc id ('' = the main PC) → { name, at }
const PRESENCE_MS = 10 * 60e3
/** The web page says "this person is signed in here" (every minute while open). */
export function notePresence(pcId, name, now = Date.now()) {
  const n = String(name || '').trim().slice(0, 60)
  if (!n) { presence.delete(String(pcId || '')); return }
  presence.set(String(pcId || ''), { name: n, at: now })
}
export const whoIsOn = (pcId, now = Date.now()) => {
  const p = presence.get(String(pcId || ''))
  return p && now - p.at < PRESENCE_MS ? p.name : null
}
export const _resetForTest = () => { presence.clear(); wifiCache = null }

// ── this PC's own Wi-Fi and version ─────────────────────────────────────────
let wifiCache = null
const run = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 4000, windowsHide: true }, (e, out) => r(e ? '' : String(out))))
/** Signal 0–100 from `netsh wlan show interfaces` (Windows) or /proc/net/wireless (Linux); null on a cable. */
export function parseWifi(text, platform = process.platform) {
  if (platform === 'win32') {
    const m = /^\s*Signal\s*:\s*(\d+)\s*%/mi.exec(text || '')
    return m ? Number(m[1]) : null
  }
  const line = String(text || '').split('\n').find(l => /^\s*\S+:\s/.test(l))
  if (!line) return null
  const q = Number(line.trim().split(/\s+/)[2]?.replace('.', ''))
  return Number.isFinite(q) ? Math.max(0, Math.min(100, Math.round(q * 100 / 70))) : null
}
export async function ownWifi() {
  if (wifiCache && Date.now() - wifiCache.at < 60e3) return wifiCache.v
  let v = null
  try {
    v = process.platform === 'win32' ? parseWifi(await run('netsh', ['wlan', 'show', 'interfaces']))
      : parseWifi(fs.existsSync('/proc/net/wireless') ? fs.readFileSync('/proc/net/wireless', 'utf8') : '')
  } catch {}
  wifiCache = { at: Date.now(), v }
  return v
}
export function ownVersion() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(BACKEND, '..', '.adal-version.json'), 'utf8'))
    return String(m.short || m.sha || '').slice(0, 7) || null
  } catch { return null }
}

// ── can it reach the others? (the main PC looks at each Companion) ──────────
export const canReach = (host, port, ms = 1500) => new Promise(resolve => {
  const s = net.connect({ host, port })
  const done = (ok) => { s.destroy(); resolve(ok) }
  s.setTimeout(ms, () => done(false))
  s.once('connect', () => done(true))
  s.once('error', () => done(false))
})

// ── the rows ────────────────────────────────────────────────────────────────
const ms = (t) => { const x = Date.parse(t || ''); return Number.isFinite(x) ? x : 0 }
const iso = (t) => (t ? new Date(t).toISOString() : null)

/**
 * Rows from what is known. own: { name, employee, version, wifi, lan }; devices:
 * the Companions heard now; replicas: every Companion that ever reported a copy;
 * backup: backupHealth().
 */
export function buildRows({ own, devices = [], replicas = [], backup = null, who = () => null, now = Date.now() }) {
  const rows = []
  const lastGood = ms(backup?.last_good_at)
  rows.push({
    id: '', main: true, name: who('') || own.employee || own.name, employee: who('') || own.employee || null, pc: own.name,
    version: own.version || null, last_seen: iso(now), online: true, wifi: own.wifi ?? null, lan: own.lan || null,
    copy_at: iso(now), backup_at: iso(lastGood) , behind_ms: 0,
  })
  const ids = new Set()
  for (const d of devices) {
    ids.add(d.id)
    const rep = replicas.find(r => r.id === d.id) || {}
    rows.push(companionRow({ id: d.id, pc: d.name, who: who(d.id), d, rep, now }))
  }
  for (const r of replicas) {
    if (ids.has(r.id)) continue
    rows.push(companionRow({ id: r.id, pc: r.name, who: who(r.id), d: null, rep: r, now }))
  }
  return rows
}

function companionRow({ id, pc, who, d, rep, now }) {
  const copy = ms(rep.synced_at) || ms(rep.made)
  const seen = d ? d.at : ms(rep.seen)
  const online = !!d && now - d.at < SEEN_MS
  const total = d?.peers_total ?? null
  return {
    id, main: false, name: who || pc || 'A PC', employee: who || null, pc: pc || null,
    version: d?.version || null, last_seen: iso(seen), online, wifi: d?.wifi ?? null,
    lan: total == null ? null : { ok: d.peers_ok ?? 0, total, down: d.peers_down || [] },
    copy_at: iso(copy), backup_at: iso(ms(rep.backup_at)), behind_ms: copy ? Math.max(0, now - copy) : null,
  }
}

// ── the morning backup line ─────────────────────────────────────────────────
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
/** "Selam's PC": the person signed in on it, else the PC's own name. */
export const pcLabel = (row) => (row.employee ? `${row.employee}'s PC` : `${row.pc || row.name || 'A PC'}`)
const days = (msBehind) => Math.max(1, Math.floor(msBehind / DAY))

/** { ok, text, behind: [text], holders } — the line shown each morning. */
export function backupProof(rows, backup, now = Date.now()) {
  const holders = rows.filter(r => r.main || (r.behind_ms != null && r.behind_ms < FRESH_MS))
  const behind = rows.filter(r => !r.main && !(r.behind_ms != null && r.behind_ms < FRESH_MS))
    .map(r => (r.behind_ms == null ? `${pcLabel(r)} has no copy yet` : `${pcLabel(r)} is ${plural(days(r.behind_ms), 'day', 'days')} behind`))
  const good = ms(backup?.last_good_at)
  const stale = backup && backup.enabled !== false && (!good || now - good >= FRESH_MS)
  const text = stale
    ? (good ? `No new backup for ${plural(days(now - good), 'day', 'days')}` : 'No backup yet')
    : `Backup OK – ${plural(holders.length, 'PC holds', 'PCs hold')} a full copy`
  return { ok: !stale && !behind.length, level: stale ? 'warn' : behind.length ? 'notice' : 'ok', text, behind, holders: holders.length }
}

// ── the live collection (main PC) ───────────────────────────────────────────
export async function collect({ db, now = Date.now() } = {}) {
  const { liveDevices } = await import('./remoteBrowsers.js')
  const { replicas } = await import('./replica.js')
  const { backupHealth } = await import('./telegramBackup.js')
  let employee = null
  try { employee = (await (await import('./activeEmployee.js')).getActiveEmployee(db))?.name || null } catch {}
  const devices = liveDevices(now)
  const ups = await Promise.all(devices.map(async d => ({ id: d.id, name: d.name, ok: await canReach(d.ip, d.port) })))
  const rows = buildRows({
    own: { name: os.hostname(), employee, version: ownVersion(), wifi: await ownWifi(), lan: devices.length ? { ok: ups.filter(u => u.ok).length, total: ups.length, down: ups.filter(u => !u.ok).map(u => u.name) } : null },
    devices, replicas: replicas(), backup: backupHealth(), who: (id) => whoIsOn(id, now), now,
  })
  return { rows, proof: backupProof(rows, backupHealth(), now), at: iso(now) }
}

// ── the end-of-day card ─────────────────────────────────────────────────────
const localDay = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` }
export const minutesOf = (d) => { const x = new Date(d); return x.getHours() * 60 + x.getMinutes() }

export function summaryText({ added = 0, epro = 0, waiting = 0 }) {
  const parts = []
  if (added) parts.push(`${plural(added, 'profile', 'profiles')} added`)
  if (epro) parts.push(`${epro} moved to EPRO`)
  if (waiting) parts.push(`${waiting} waiting on you`)
  return parts.length ? `Today: ${parts.join(', ')}` : 'Today: a quiet day'
}

/** Profiles that went from before-EPRO to EPRO today, from the per-day rows (profileDays.js). */
export function eproMoves(todayRows, before) {
  const state = (data) => { try { return JSON.parse(data || '{}').steps?.epro || 'todo' } catch { return 'todo' } }
  let n = 0
  for (const r of todayRows) {
    const prev = before.get(r.profile_id)
    if (prev == null) continue
    if (['active', 'done'].includes(state(r.data)) && state(prev) === 'todo') n++
  }
  return n
}

export async function daySummary(db, now = new Date()) {
  const day = localDay(now)
  let added = 0, epro = 0, waiting = 0
  try {
    const q = () => db('profiles').where('created_at', '>=', day)
    try { added = Number((await q().whereNull('deleted_at').count({ n: '*' }).first())?.n) || 0 } catch { added = Number((await q().count({ n: '*' }).first())?.n) || 0 }
  } catch {}
  try {
    const today = await db('profile_days').where({ day }).select('profile_id', 'data')
    if (today.length) {
      const earlier = await db('profile_days').where('day', '<', day).whereIn('profile_id', today.map(r => r.profile_id)).orderBy('day', 'asc').select('profile_id', 'data')
      const before = new Map(earlier.map(r => [r.profile_id, r.data]))   // the newest earlier day wins
      epro = eproMoves(today, before)
    }
  } catch {}
  try { waiting = (await import('./attention.js')).waiting().length } catch {}
  const counts = { added, epro, waiting }
  return { ...counts, text: summaryText(counts), show: minutesOf(now) >= SUMMARY_FROM, day }
}

// ── the one phone push at 17:30 ─────────────────────────────────────────────
const KEY = 'office_day_pushed'
async function readKey(db) { return (await db('settings').where({ key: KEY }).first())?.value || null }
async function writeKey(db, value) {
  const at = new Date().toISOString()
  if (await db('settings').where({ key: KEY }).first()) await db('settings').where({ key: KEY }).update({ value, updated_at: at })
  else await db('settings').insert({ key: KEY, value, created_at: at, updated_at: at })
}
/** Inside the hour after the push, the summary is also a call in the "needs you" list the phones read. */
export const CALL_MS = 60 * 60e3
let lastSummary = null
export const dayCall = (now = new Date()) => {
  const m = minutesOf(now)
  if (!lastSummary || lastSummary.day !== localDay(now) || m < PUSH_AT || m >= PUSH_AT + CALL_MS / 60e3) return null
  return { run_id: -103, full_name: 'Today', title: lastSummary.text, body: '', at: new Date(now).setHours(Math.floor(PUSH_AT / 60), PUSH_AT % 60, 0, 0), image: null, kind: 'look' }
}

/** Once a day at/after 17:30: one push to the phones, never twice a day. */
export async function pushIfDue(db, now = new Date(), { push } = {}) {
  const m = minutesOf(now)
  if (m < PUSH_AT || m >= 20 * 60) return { sent: false, why: 'not the time' }
  const day = localDay(now)
  if (await readKey(db) === day) return { sent: false, why: 'already today' }
  await writeKey(db, day)
  try { await (await import('./profileDays.js')).snapshotDays(db) } catch {}
  lastSummary = await daySummary(db, now)
  const send = push || (async () => (await import('./fcmPush.js')).pushToPhones(db, { type: 'attention' }))
  const r = await send(db, { type: 'attention' }).catch(e => ({ error: e.message }))
  return { sent: true, text: lastSummary.text, push: r }
}

let timer = null
export function startOfficeDay(db) {
  if (timer || process.env.NODE_ENV === 'test') return
  const look = () => pushIfDue(db).catch(e => console.warn('[office-day]', e.message))
  setTimeout(look, 60e3).unref?.()
  timer = setInterval(look, 60e3)
  timer.unref?.()
}
