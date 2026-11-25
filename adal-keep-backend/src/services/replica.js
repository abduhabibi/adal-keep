/**
 * replica.js — the main PC hands a copy of the agency's data to its Companions.
 *
 * Every Companion (adal-companion, replica.go) keeps a copy of the database
 * and the documents on its own disk, so that when the main PC is off or dead
 * a Companion can still back the agency up (to Telegram) and a new main PC can
 * be restored from it over the office network.
 *
 *   manifest  a consistent snapshot of the database (SQLite's backup), cut in
 *             1 MB chunks; each chunk has a fingerprint made from the page
 *             fingerprints the backup already uses (pageHashes). The documents
 *             of SafeStorage by name, size and time. The Companion asks only
 *             for what it does not have: after the first copy, a few chunks.
 *   pieces    each chunk (zstd inside) and each document (in ≤ 4 MB pieces) is
 *             LOCKED with the agency's backup key before it leaves this PC —
 *             the same lock as the Telegram backup (AES-256-GCM, scrypt). The
 *             Companion stores them as they come: its copy is locked at rest,
 *             and the same pieces go to Telegram as they are.
 *   keys      the backup key, the bot and channel, and what a restore needs
 *             (the vault key, the locked secrets): a Companion keeps them
 *             locked with Windows' own protection (DPAPI) for its user.
 *
 * Only computers let in with the main PC's number (networkGate: req.pcAccess)
 * get any of it, and never through the online link (X-Adal-Cloud).
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { rawSnapshot, pageSizeOf, pageHashes, lockFast, HAS_ZSTD, backupHealth, getConfig } from './telegramBackup.js'
import { getSecret, secretBlobs } from './secretStore.js'
import { vaultKey } from './accountVault.js'
import { deltaOn, framesOf, joinFrames, subPiece, Versions, DocsFeed, FRAME } from './replicaDelta.js'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = path.join(BACKEND, 'data')
const SAFE = process.env.ADAL_BACKUP_SAFE || path.join(DATA, 'SafeStorage')
const SNAPS = process.env.ADAL_REPLICA_SNAPS || path.join(DATA, 'replica-snap')
const LIST = process.env.ADAL_REPLICA_LIST || path.join(DATA, 'replicas.json')

export const CHUNK = 1024 * 1024        // database chunk (a whole number of pages for any page size)
export const PIECE = 4 * 1024 * 1024    // document piece (a bot downloads ≤ 20 MB; small pieces get through slow lines)
const SNAP_TTL = 20 * 60 * 1000
const ZL = zlib.constants

// ── The snapshot ────────────────────────────────────────────────────────────

const snaps = new Map()   // id → { file, at, length, ps }
function dropOldSnaps() {
  for (const [id, s] of snaps) if (Date.now() - s.at > SNAP_TTL) { fs.rmSync(s.file, { force: true }); snaps.delete(id) }
  // Leftovers from before a restart.
  try { for (const f of fs.readdirSync(SNAPS)) if (![...snaps.values()].some(s => path.basename(s.file) === f)) fs.rmSync(path.join(SNAPS, f), { force: true }) } catch {}
}

/** One fingerprint per chunk: from the page fingerprints in it (and its length). */
export function chunkSums(raw, ps = pageSizeOf(raw), chunk = CHUNK) { return sumsOf(raw.length, pageHashes(raw, ps), ps, chunk) }
function sumsOf(length, fp, ps, chunk = CHUNK) {
  const perChunk = chunk / ps
  const out = []
  for (let i = 0; i * chunk < length; i++) {
    const len = Math.min(chunk, length - i * chunk)
    out.push(crypto.createHash('sha1').update(String(len)).update(fp.subarray(i * perChunk * 8, (i + 1) * perChunk * 8)).digest('hex').slice(0, 20))
  }
  return out
}
/** pageHashes a chunk at a time (a whole database at once stopped every answer for up to a second). */
async function hashesInSteps(raw, ps) {
  const out = []
  for (let i = 0; i < raw.length; i += CHUNK) { out.push(pageHashes(raw.subarray(i, i + CHUNK), ps)); await new Promise(r => setImmediate(r)) }
  return Buffer.concat(out)
}

/** What a document is (cheap: no reading of the file): its name, size and time. */
export const docSum = (name, st) => crypto.createHash('sha1').update(`${name}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 20)

const docEntry = (name, st) => ({ name, size: st.size, sum: docSum(name, st), parts: Math.max(1, Math.ceil(st.size / PIECE)) })
export const docs = new DocsFeed(SAFE, docEntry)
const versions = new Versions({ file: HAS_ZSTD ? path.join(path.dirname(SNAPS), 'replica-versions.gz') : null })
const history = new Map()   // snap → its chunks (a Companion says which one it has)
function listDocs() {
  if (deltaOn()) return docs.refresh().all()
  let names = []
  try { names = fs.readdirSync(SAFE, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name) } catch {}
  const out = []
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(SAFE, name))
      out.push({ name, size: st.size, sum: docSum(name, st), parts: Math.max(1, Math.ceil(st.size / PIECE)) })
    } catch {}
  }
  return out
}

/** The manifest: a fresh snapshot of the database and the list of documents. */
// Companions ask every minute (asked on 2026-11-20): the last snapshot is used
// again while the database has not changed (its file and its -wal untouched) or
// it is under 45 s old — one snapshot for every Companion, not one per question.
let lastManifest = null   // { m, at, mark }
const DB_PATH = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : path.join(BACKEND, 'data.sqlite')
const dbMark = () => ['', '-wal'].map(x => { try { const s = fs.statSync(DB_PATH + x); return `${s.size}:${s.mtimeMs}` } catch { return '-' } }).join('|')

const IDLE = new Set(['sync_pcs', 'sync_role', 'audit_log', 'run_history', 'profile_days', 'notifications'])
const IDLE_MS = (Number(process.env.ADAL_REPLICA_IDLE_MIN) || 30) * 60000
/** Only the PCs' own signs of life changed since the last snapshot (the change log, sync_log): it is used again. */
async function onlyIdle(db, last) {
  if (!db || !deltaOn() || !last?.vec || Date.now() - last.at > IDLE_MS) return false
  try {
    for (const [o, s] of Object.entries(await logVec(db))) {
      if (s <= (last.vec[o] || 0)) continue
      for (const r of await db.raw('SELECT DISTINCT tbl FROM sync_log WHERE origin = ? AND seq > ?', [o, last.vec[o] || 0])) if (!IDLE.has(r.tbl)) return false
    }
    return true
  } catch { return false }
}
const logVec = async (db) => Object.fromEntries((await db.raw('SELECT origin, MAX(seq) AS s FROM sync_log GROUP BY origin')).map(r => [r.origin, Number(r.s)]))

/** What a Companion that has snapshot `have` and the documents as of `docsAt` needs to know (v2). */
export async function manifestFor({ have = '', docsAt = '', db = null, ...o } = {}) {
  const m = await manifest({ db, ...o })
  const out = { v: 2, pc_number: m.pc_number, made: m.made, snap: m.snap, backup: m.backup, docs_at: docs.at }
  const was = history.get(have)
  if (have === m.snap) out.same_db = true
  else if (was && was.length <= m.db.chunks.length + 64) out.db = { ...m.db, chunks: undefined, n: m.db.chunks.length, set: Object.fromEntries(m.db.chunks.map((s, i) => [i, s]).filter(([i, s]) => was[i] !== s)), from: have }
  else out.db = m.db
  const ch = docs.since(docsAt)
  if (ch) { if (ch.set.length || ch.gone.length) { out.docs_set = ch.set; out.docs_gone = ch.gone } else out.same_docs = true } else out.docs = m.docs
  return out
}

export async function manifest({ snapshot = rawSnapshot, db = null } = {}) {
  if (!getSecret('backup_password')) throw new Error('No backup key on the main PC yet')
  dropOldSnaps()
  const mark = dbMark()
  if (snapshot === rawSnapshot && lastManifest && snaps.has(lastManifest.m.snap) && Date.now() - lastManifest.at < SNAP_TTL / 2 &&
      (Date.now() - lastManifest.at < 45000 || lastManifest.mark === mark || await onlyIdle(db, lastManifest))) {
    const s = snaps.get(lastManifest.m.snap)
    if (deltaOn()) s.at = Date.now()   // in use: it stays
    return { ...lastManifest.m, docs: listDocs(), backup: backupHealth() }
  }
  const vec = db ? await logVec(db).catch(() => null) : null
  const raw = await snapshot()
  const ps = pageSizeOf(raw)
  const fp = await hashesInSteps(raw, ps)
  const chunks = sumsOf(raw.length, fp, ps)
  const id = crypto.randomBytes(8).toString('hex')
  fs.mkdirSync(SNAPS, { recursive: true })
  const file = path.join(SNAPS, `${id}.sqlite`)
  await fs.promises.writeFile(file, raw)
  snaps.set(id, { file, at: Date.now(), length: raw.length, ps })
  let number = null
  try { number = (await import('./mainPC.js')).pcNumber() } catch {}
  const m = {
    v: 1,
    pc_number: number,
    made: new Date().toISOString(),
    snap: id,
    db: { length: raw.length, ps, chunk: CHUNK, z: HAS_ZSTD ? 'zstd' : 'gzip', chunks },
    docs: listDocs(),
    backup: backupHealth(),
  }
  if (snapshot === rawSnapshot) lastManifest = { m, at: Date.now(), mark, vec }
  if (deltaOn() && HAS_ZSTD) {
    const per = CHUNK / ps * 8
    chunks.forEach((s, i) => versions.add(i, s, fp.subarray(i * per, (i + 1) * per)))
    history.set(id, chunks)
    while (history.size > 60) history.delete(history.keys().next().value)
    versions.save()
  }
  return m
}

/** One database chunk of a snapshot, compressed and locked. */
export function dbChunk(snap, i) {
  const s = snaps.get(String(snap))
  if (!s) throw Object.assign(new Error('That snapshot is gone: ask for a new manifest'), { status: 410 })
  const n = Number(i)
  if (!Number.isInteger(n) || n < 0 || n * CHUNK >= s.length) throw Object.assign(new Error('No such chunk'), { status: 404 })
  const fd = fs.openSync(s.file, 'r')
  try {
    const len = Math.min(CHUNK, s.length - n * CHUNK)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, n * CHUNK)
    const z = HAS_ZSTD ? zlib.zstdCompressSync(buf, { params: { [ZL.ZSTD_c_compressionLevel]: 6 } }) : zlib.gzipSync(buf, { level: 6 })
    return lockFast(z, getSecret('backup_password'))
  } finally { fs.closeSync(fd) }
}

/** dbChunk without blocking the event loop (reading and compressing in the thread pool): the one the routes use. */
export async function dbChunkAsync(snap, i, { framed = false, base = '' } = {}) {
  const s = snaps.get(String(snap))
  if (!s) throw Object.assign(new Error('That snapshot is gone: ask for a new manifest'), { status: 410 })
  const n = Number(i)
  if (!Number.isInteger(n) || n < 0 || n * CHUNK >= s.length) throw Object.assign(new Error('No such chunk'), { status: 404 })
  const fh = await fs.promises.open(s.file, 'r')
  try {
    const len = Math.min(CHUNK, s.length - n * CHUNK)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, n * CHUNK)
    // In frames (v2): the whole piece, or only the frames that differ from the one the Companion has.
    if (framed && HAS_ZSTD && deltaOn()) {
      const frames = await framesOf(buf)
      const to = history.get(String(snap))?.[n]
      const ch = base && to ? versions.changed(n, base, to, FRAME / s.ps) : null
      if (base && (!ch || ch.length > frames.length / 2)) return lockFast(joinFrames(frames), getSecret('backup_password'))
      return lockFast(base ? subPiece(frames, ch) : joinFrames(frames), getSecret('backup_password'))
    }
    const z = HAS_ZSTD
      ? await new Promise((ok, no) => zlib.zstdCompress(buf, { params: { [ZL.ZSTD_c_compressionLevel]: 3 } }, (e, r) => e ? no(e) : ok(r)))
      : await new Promise((ok, no) => zlib.gzip(buf, { level: 6 }, (e, r) => e ? no(e) : ok(r)))
    return lockFast(z, getSecret('backup_password'))
  } finally { await fh.close() }
}

/** One piece of a document, locked. */
export function docPiece(name, part) {
  const base = path.basename(String(name || ''))
  if (!base || base !== String(name)) throw Object.assign(new Error('No such document'), { status: 404 })
  const file = path.join(SAFE, base)
  let st
  try { st = fs.statSync(file) } catch { throw Object.assign(new Error('No such document'), { status: 404 }) }
  const k = Number(part)
  const parts = Math.max(1, Math.ceil(st.size / PIECE))
  if (!Number.isInteger(k) || k < 0 || k >= parts) throw Object.assign(new Error('No such piece'), { status: 404 })
  const fd = fs.openSync(file, 'r')
  try {
    const len = Math.max(0, Math.min(PIECE, st.size - k * PIECE))
    const buf = Buffer.alloc(len)
    if (len) fs.readSync(fd, buf, 0, len, k * PIECE)
    return lockFast(buf, getSecret('backup_password'))
  } finally { fs.closeSync(fd) }
}

/** What a Companion needs to back up from its copy, and what a restore from it needs. */
export function replicaKeys() {
  const password = getSecret('backup_password')
  if (!password) throw new Error('No backup key on the main PC yet')
  const cfg = getConfig()
  let chat = null
  try { chat = fs.readFileSync(path.join(BACKEND, '.adal_chat.json'), 'utf8') } catch {}
  return {
    password,
    bot_token: getSecret('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN || '',
    chat_id: cfg.chat_id || '',
    vault_key: vaultKey(),
    secrets: secretBlobs(),
    chat_account: chat,
  }
}

// ── The Companions that hold a copy ─────────────────────────────────────────

function readList() { try { return JSON.parse(fs.readFileSync(LIST, 'utf8')) } catch { return {} } }
function writeList(l) { fs.mkdirSync(path.dirname(LIST), { recursive: true }); fs.writeFileSync(LIST, JSON.stringify(l, null, 1)) }

/** A Companion says how its copy stands (after a sync), or that it backed up from it. */
export function recordReport(pc, ip, body = {}) {
  const l = readList()
  const id = String(pc?.id || ip || 'unknown')
  const r = l[id] || {}
  r.name = String(body.name || pc?.name || r.name || 'Companion').slice(0, 60)
  r.ip = ip || r.ip || null
  if (Number(body.port) > 0 && Number(body.port) < 65536) r.port = Number(body.port)
  if (body.made) r.made = String(body.made).slice(0, 40)
  if (body.synced_at) r.synced_at = String(body.synced_at).slice(0, 40)
  if (Number.isFinite(Number(body.bytes))) r.bytes = Number(body.bytes)
  if (Number.isFinite(Number(body.docs))) r.docs = Number(body.docs)
  if (body.backup_at) r.backup_at = String(body.backup_at).slice(0, 40)
  r.seen = new Date().toISOString()
  l[id] = r
  writeList(l)
  return r
}

export const replicas = () => Object.entries(readList()).map(([id, r]) => ({ id, ...r }))
  .sort((a, b) => String(b.synced_at || '').localeCompare(String(a.synced_at || '')))
