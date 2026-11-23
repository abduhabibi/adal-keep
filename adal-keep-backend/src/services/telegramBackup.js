/**
 * telegramBackup.js — an off-site copy of the main PC in a private Telegram
 * channel, so a stolen, broken or burnt PC loses nothing.
 *
 * WHEN  Agency PCs are unplugged at night, so nothing waits for the night:
 *       new documents go within seconds, the database every 2 hours during
 *       the day (when the robots are quiet), and a PC switched on in the
 *       morning whose last whole backup is more than 20 hours old starts one
 *       within a few minutes. "Back up now" runs it at once.
 * WHAT  The database: a whole copy (zstd, ~1/6 of its size) every few days,
 *       and in between only the pages that changed since that copy (usually a
 *       few KB: seconds instead of minutes). Documents only once (each new
 *       file is sent the first time it appears).
 * HOW   Everything is locked with the agency's backup password (AES-256-GCM,
 *       key from scrypt) BEFORE it leaves the PC — Telegram only ever holds
 *       unreadable pieces. Pieces are ≤ 19 MB because a bot can download at
 *       most 20 MB per file, so a restore can always fetch them back.
 *       After each run the index (which piece is what) is sent too, also
 *       locked: "adal-backup-index.enc". Restoring needs that last index file,
 *       the bot token and the password.
 *
 * Without the password nobody — not Telegram, not Adal — can read a backup.
 */
import { waitForQuiet } from './userUploads.js'
import { runsWorking } from './busy.js'
import { vaultKey, stageVaultKey, applyStagedVaultKey } from './accountVault.js'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { forCloud as sealedForCloud } from './backupSeal.js'
import { fileURLToPath } from 'url'
import sqlite3 from 'sqlite3'
import { getSecret, setSecret, secretBlobs, restoreSecretBlobs } from './secretStore.js'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = path.join(BACKEND, 'data')
const SAFE = process.env.ADAL_BACKUP_SAFE || path.join(DATA, 'SafeStorage')   // (tests: a folder of their own)
const STATE = process.env.ADAL_BACKUP_STATE || path.join(DATA, 'backup-state.json')
const TMP = path.join(DATA, 'backup-tmp')
const DB_FILE = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : path.join(BACKEND, 'data.sqlite')

const PART = 4 * 1024 * 1024           // small pieces: each one gets through a slow office line (a bot downloads ≤ 20 MB)
const SET_TARGET = 18 * 1024 * 1024    // documents are grouped into sets of about this size
const MAGIC = Buffer.from('ADALBK1')
const BASE_HASHES = path.join(path.dirname(STATE), 'backup-base.hashes') // one 8-byte fingerprint per page of the last whole copy sent
const FULL_EVERY_MS = 3 * 864e5        // a whole copy every 3 days (or when the changes grow big)
const UPLOADS_AT_ONCE = 2

// ── Settings ─────────────────────────────────────────────────────────────────

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} }
}
function writeState(s) {
  fs.mkdirSync(DATA, { recursive: true })
  fs.writeFileSync(STATE, JSON.stringify(s, null, 1))
}

// Adal's own bot and storage channel (.env) serve every agency; an agency's
// own bot / channel, when one was set before, still wins.
const botToken = () => getSecret('telegram_bot_token') || process.env.TELEGRAM_BOT_TOKEN || ''
const chatOf = (s) => s.chat_id || process.env.TELEGRAM_STORAGE_CHAT || ''

export function getConfig() {
  const s = readState()
  return {
    chat_id: chatOf(s),
    shared: !getSecret('telegram_bot_token') && !!process.env.TELEGRAM_BOT_TOKEN,
    shared_ready: !!(process.env.TELEGRAM_BOT_TOKEN && (s.chat_id || process.env.TELEGRAM_STORAGE_CHAT)),
    // This agency's own channel (not the one Adal's storage shares between agencies).
    own_channel: !!s.chat_id && s.chat_id !== (process.env.TELEGRAM_STORAGE_CHAT || ''),
    window_start: s.window_start || '12:30',
    window_end: s.window_end || '13:30',
    enabled: s.enabled !== false,
    has_token: !!botToken(),
    has_password: !!getSecret('backup_password'),
    last_run: s.last_run || null,
    last_ok: s.last_ok || null,
    last_error: s.last_error || null,
    last_error_at: s.last_error_at || null,
    // The newest failure, kept after a later success (Settings → Health).
    last_fail: s.last_fail || null,
    last_fail_at: s.last_fail_at || null,
    verify: s.verify || null,
    last_full_ok: lastFullAt(s),
    last_good_at: backupHealth(s).last_good_at,
    companion_backup: s.companion_backup || null,
    ...documentCounts(s),
  }
}

// Only documents still here count: a deleted one stays marked as sent.
function documentCounts(s) {
  const all = listDocuments()
  return { files_sent: all.filter(n => s.sent?.[n]).length, files_total: all.length }
}

export function saveConfig({ bot_token, password, chat_id, window_start, window_end, enabled }) {
  if (bot_token !== undefined && String(bot_token).trim()) setSecret('telegram_bot_token', String(bot_token).trim())
  if (password !== undefined && String(password)) {
    if (String(password).length < 8) throw new Error('The backup password needs at least 8 characters.')
    if (readState().sets?.length && getSecret('backup_password') && getSecret('backup_password') !== String(password)) {
      // Older pieces stay locked with the old password: start a fresh backup.
      const s = readState(); s.sent = {}; s.sets = []; writeState(s)
    }
    setSecret('backup_password', String(password))
  }
  const s = readState()
  if (chat_id !== undefined) {
    const next = String(chat_id).trim()
    // A new channel (this agency's own, instead of the shared one): everything
    // is sent there again, so the channel alone holds a whole backup.
    if (next !== chatOf(s)) { s.sent = {}; s.sets = []; s.moved_at = new Date().toISOString() }
    s.chat_id = next
  }
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
  if (window_start !== undefined) { if (!hhmm.test(window_start)) throw new Error('Start time like 12:30'); s.window_start = window_start }
  if (window_end !== undefined) { if (!hhmm.test(window_end)) throw new Error('End time like 13:30'); s.window_end = window_end }
  if (enabled !== undefined) s.enabled = !!enabled
  writeState(s)
  return getConfig()
}

// ── Telegram ─────────────────────────────────────────────────────────────────

const NET_DOWN = /No connection to Telegram|fetch failed|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|aborted|timeout|socket/i
async function tg(token, method, body, timeoutMs = 60000, tries = 0, maxTries = 4) {
  let r
  try {
    r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
    ...(body instanceof FormData ? {} : { headers: { 'content-type': 'application/json' } }),
  })
  } catch (e) {
    // The line dropped: wait a little and send it again (a few times).
    if (tries >= maxTries) throw new Error(`No connection to Telegram (${e.cause?.code || e.message})`)
    await new Promise(ok => setTimeout(ok, [5, 15, 30, 60][tries] * 1000))
    return tg(token, method, body, timeoutMs, tries + 1, maxTries)
  }
  const j = await r.json().catch(() => ({}))
  // One channel serves many agencies: when Telegram says "too many", wait as it asks.
  if (j.error_code === 429 && tries < 6) {
    await new Promise(ok => setTimeout(ok, ((j.parameters?.retry_after || 5) + 1) * 1000))
    return tg(token, method, body, timeoutMs, tries + 1, Math.max(maxTries, 6))
  }
  if (!j.ok) throw new Error(`Telegram: ${j.description || r.status}`)
  return j.result
}

/** Send a test message; returns the channel's title. */
export async function testConnection() {
  const token = botToken()
  const chat_id = chatOf(readState())
  if (!token) throw new Error('Paste the bot token first.')
  if (!chat_id) throw new Error('The storage channel is not set yet — ask Adal.')
  const chat = await tg(token, 'getChat', JSON.stringify({ chat_id }))
  await tg(token, 'sendMessage', JSON.stringify({ chat_id, text: '✅ Adal Keep backup is connected. Locked backups will arrive here every day.' }))
  return { title: chat.title || chat.username || String(chat_id) }
}

/** The bot's @name, to add as the admin of the agency's own channel. */
let botName = null
export async function botInfo() {
  const token = botToken()
  if (!token) return { username: null }
  if (!botName) botName = (await tg(token, 'getMe', JSON.stringify({}))).username
  return { username: botName }
}

const plainName = (t) => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase()

/** The channels where this agency's name was posted. Telegram's answer, read on its own. */
export function chatsNamed(updates, agency) {
  const want = plainName(agency)
  const seen = new Map()
  for (const u of updates) {
    const post = u.channel_post || u.message
    const c = post?.chat
    if (want && c && c.type !== 'private' && plainName(post.text) === want) {
      seen.set(c.id, { id: c.id, title: c.title || c.username || String(c.id), type: c.type })
    }
  }
  return [...seen.values()]
}

/**
 * The bot is shared, so it sees every agency's channels: only the one where this
 * agency's own name was posted may be offered, or its backups could go to another's.
 */
export async function findChats(agency) {
  const token = botToken()
  if (!token) throw new Error('Paste the bot token first.')
  if (!plainName(agency)) throw new Error('Write your agency name first.')
  const ups = await tg(token, 'getUpdates', JSON.stringify({ allowed_updates: ['channel_post', 'message'] }))
  return chatsNamed(ups, agency)
}

// Where a piece goes: Telegram when it answers, otherwise the agency's online
// storage (Supabase, the "keep" bucket, folder <agency>/_backup) — a piece
// kept there has the id "sb:<object>". Pieces are locked before either.
// Once Telegram fails in a run, the rest of that run goes online at once
// (no minutes of waiting per piece); the next run tries Telegram again.
const route = { db: null, tgDown: false, online: 0, replica: null }
async function sendToTelegram(token, chat_id, buf, filename, caption) {
  const fd = new FormData()
  fd.append('chat_id', String(chat_id))
  fd.append('caption', caption.slice(0, 1000))
  fd.append('disable_notification', 'true')
  fd.append('document', new Blob([buf]), filename)
  // Slow office lines: allow 10 minutes for one 19 MB piece.
  const res = await tg(token, 'sendDocument', fd, 10 * 60 * 1000, 0, 2)
  return res.document.file_id
}
async function sendOnline(buf, filename) {
  const c = route.db && await cloudOf(route.db).catch(() => null)
  if (!c?.agency) return null
  const object = `${c.agency}/_backup/${filename.replace(/[^\w.-]+/g, '_')}-${crypto.randomBytes(4).toString('hex')}`
  await c.cloudCall(route.db, 'POST', `/storage/v1/object/keep/${object}`, buf,
    { headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' } })
  route.online++
  return `sb:${object}`
}
async function sendPiece(token, chat_id, buf, filename, caption) {
  // Someone is uploading files into Adal Keep: this piece waits until about
  // 30 s after the last upload (services/userUploads.js) — delayed, never skipped.
  await waitForQuiet({ onWait: () => { progress.waitingForUploads = true; console.log('[backup] the user is uploading — the backup waits') } })
  progress.waitingForUploads = false
  let tgErr = null
  if (token && chat_id && !route.tgDown) {
    try { return await sendToTelegram(token, chat_id, buf, filename, caption) }
    catch (e) {
      if (!NET_DOWN.test(e.message)) throw e   // Telegram answered with a real error: shown as it is
      tgErr = e
      route.tgDown = true
      console.warn(`[backup] Telegram does not answer (${e.message}) — this backup goes to the online storage`)
    }
  }
  let id = null
  try { id = await sendOnline(buf, filename) }
  catch (e) { throw new Error(`${tgErr ? tgErr.message + '; ' : ''}online storage: ${e.message}`) }
  if (id) return id
  throw tgErr || new Error('No route for the backup: Telegram is not set up and the online copy is off.')
}

async function fetchPiece(token, fileId) {
  // A piece of a Companion's copy, read straight from that Companion on the office network.
  if (String(fileId).startsWith('rp:')) {
    if (!route.replica) throw new Error("This piece is in a Companion's copy: restore it from that Companion.")
    const r = await fetch(`${route.replica.url}/replica/piece/${encodeURIComponent(String(fileId).slice(3))}`, { headers: { 'x-adal-number': route.replica.number }, signal: AbortSignal.timeout(5 * 60 * 1000) })
    if (!r.ok) throw new Error(`The Companion answered ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  if (String(fileId).startsWith('sb:')) {
    const c = route.db && await cloudOf(route.db).catch(() => null)
    if (!c) throw new Error('This piece is in the online storage: the online copy must be on to read it.')
    const r = await c.cloudCall(route.db, 'GET', `/storage/v1/object/authenticated/keep/${String(fileId).slice(3)}`, undefined, { raw: true })
    if (!r.ok) throw new Error(`Online storage download ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  const f = await tg(token, 'getFile', JSON.stringify({ file_id: fileId }))
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!r.ok) throw new Error(`Telegram download ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// ── Locking ──────────────────────────────────────────────────────────────────

export function lock(buf, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(password, salt, 32)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), ct])
}
export function unlock(buf, password) {
  if (!buf.subarray(0, 7).equals(MAGIC)) throw new Error('Not an Adal Keep backup piece')
  const salt = buf.subarray(7, 23), iv = buf.subarray(23, 35), tag = buf.subarray(35, 51)
  const key = crypto.scryptSync(password, salt, 32)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  try { return Buffer.concat([d.update(buf.subarray(51)), d.final()]) } catch { throw new Error('Wrong backup password (or a damaged piece)') }
}

/**
 * The same lock (a piece unlock() opens), with the key worked out once per
 * process: the copy for a Companion is many small pieces, and scrypt for each
 * would hold the server up for seconds. (A fresh IV per piece, as always.)
 */
let fastKey = null
export function lockFast(buf, password) {
  if (fastKey?.password !== password) {
    const salt = crypto.randomBytes(16)
    fastKey = { password, salt, key: crypto.scryptSync(password, salt, 32) }
  }
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', fastKey.key, iv)
  const ct = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([MAGIC, fastKey.salt, iv, c.getAuthTag(), ct])
}

/**
 * Reads one set of an index back: its pieces fetched, unlocked, put together.
 *   files / db / dbz / dbz-delta  one locked whole, cut in pieces
 *   rdb    a Companion's copy of the database: each piece one locked chunk
 *          (zstd or gzip inside), the chunks in order make the database
 *   rfile  a Companion's copy of one document: each piece locked on its own
 */
export function setReader(fetchOne, password) {
  return async (set) => {
    const bufs = []
    for (const id of set.parts) bufs.push(await fetchOne(id))
    if (set.type === 'rdb') {
      const raw = Buffer.concat(bufs.map(b => {
        const u = unlock(b, password)
        return set.z === 'zstd' ? unzstd(u) : set.z === 'gzip' ? zlib.gunzipSync(u) : u
      }))
      return raw.subarray(0, set.length ?? raw.length)
    }
    if (set.type === 'rfile') return Buffer.concat(bufs.map(b => unlock(b, password)))
    return unlock(Buffer.concat(bufs), password)
  }
}

// ── What to back up ──────────────────────────────────────────────────────────

function listDocuments() {
  try {
    return fs.readdirSync(SAFE, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name)
  } catch { return [] }
}

/** Pack files: [4-byte header length][JSON {name,size}][bytes] … */
function pack(names) {
  const chunks = []
  for (const name of names) {
    const data = fs.readFileSync(path.join(SAFE, name))
    const head = Buffer.from(JSON.stringify({ name, size: data.length }))
    const len = Buffer.alloc(4); len.writeUInt32BE(head.length)
    chunks.push(len, head, data)
  }
  return Buffer.concat(chunks)
}
function unpack(buf, intoDir) {
  let off = 0, n = 0
  while (off < buf.length) {
    const hl = buf.readUInt32BE(off); off += 4
    const { name, size } = JSON.parse(buf.subarray(off, off + hl).toString()); off += hl
    const safeName = path.basename(name)
    const dest = path.join(intoDir, safeName)
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf.subarray(off, off + size))
    off += size; n++
  }
  return n
}

// ── The database: a whole copy now and then, only changed pages in between ──

const ZL = zlib.constants
export const HAS_ZSTD = typeof zlib.zstdCompress === 'function'
const zstd = (buf) => new Promise((ok, no) => zlib.zstdCompress(buf, {
  params: { [ZL.ZSTD_c_compressionLevel]: 9, [ZL.ZSTD_c_enableLongDistanceMatching]: 1, [ZL.ZSTD_c_windowLog]: 27 },
}, (e, r) => e ? no(e) : ok(r)))
export const unzstd = (buf) => zlib.zstdDecompressSync(buf, { params: { [ZL.ZSTD_d_windowLogMax]: 27 } })

/** A page-for-page copy of the open database (SQLite's backup: consistent while the app runs). */
export function rawSnapshot() {
  fs.mkdirSync(TMP, { recursive: true })
  const out = path.join(TMP, `raw-${Date.now()}.sqlite`)
  return new Promise((ok, no) => {
    const src = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READONLY, (e) => {
      if (e) return no(e)
      const b = src.backup(out, (e1) => {
        if (e1) { src.close(); return no(e1) }
        b.step(-1, (e2) => b.finish(() => src.close(() => {
          if (e2) return no(e2)
          try { const buf = fs.readFileSync(out); fs.rmSync(out, { force: true }); ok(buf) } catch (e3) { no(e3) }
        })))
      })
    })
  })
}
export const pageSizeOf = (buf) => { const n = buf.readUInt16BE(16); return n === 1 ? 65536 : n || 4096 }
export function pageHashes(buf, ps) {
  const n = Math.ceil(buf.length / ps), out = Buffer.alloc(n * 8)
  for (let i = 0; i < n; i++) crypto.createHash('sha1').update(buf.subarray(i * ps, (i + 1) * ps)).digest().copy(out, i * 8, 0, 8)
  return out
}
/** The pages of buf that differ from the whole copy (its fingerprints): [4-byte head length][JSON][pages]. */
export function makeDelta(buf, ps, baseHashes) {
  const now = pageHashes(buf, ps), pages = []
  for (let i = 0; i < now.length / 8; i++) if (!now.subarray(i * 8, i * 8 + 8).equals(baseHashes.subarray(i * 8, i * 8 + 8))) pages.push(i)
  const head = Buffer.from(JSON.stringify({ ps, length: buf.length, pages }))
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length)
  return { delta: Buffer.concat([len, head, ...pages.map(i => buf.subarray(i * ps, (i + 1) * ps))]), pages: pages.length }
}
export function applyDelta(base, delta) {
  const hl = delta.readUInt32BE(0)
  const { ps, length, pages } = JSON.parse(delta.subarray(4, 4 + hl).toString())
  const out = Buffer.alloc(length); base.copy(out, 0, 0, Math.min(base.length, length))
  let off = 4 + hl
  for (const i of pages) { const n = Math.min(length, (i + 1) * ps) - i * ps; delta.copy(out, i * ps, off, off + n); off += n }
  return out
}
/** The database a restore gets from an index: the whole copy with its changes, or an older gzip copy. */
export async function databaseFromIndex(index, get) {
  // A backup a Companion made from its copy: the whole database in chunks.
  const chunks = index.sets.find(x => x.type === 'rdb')
  if (chunks) return await get(chunks)
  const full = index.sets.find(x => x.type === 'dbz')
  if (full) {
    let raw = unzstd(await get(full))
    const d = index.sets.find(x => x.type === 'dbz-delta' && x.base_date === full.date)
    if (d) raw = applyDelta(raw, unzstd(await get(d)))
    return raw
  }
  const old = index.sets.find(x => x.type === 'db')
  return old ? zlib.gunzipSync(await get(old)) : null
}

async function databaseSnapshot(db) {
  fs.mkdirSync(TMP, { recursive: true })
  const out = path.join(TMP, `db-${Date.now()}.sqlite`)
  // A consistent copy while the app keeps running.
  await db.raw('VACUUM INTO ?', [out])
  // (Only where this Node has no zstd.) Off the main thread: the app stays quick meanwhile.
  const buf = await new Promise((ok, no) => zlib.gzip(fs.readFileSync(out), { level: 6 }, (e, r) => e ? no(e) : ok(r)))
  fs.rmSync(out, { force: true })
  return buf
}

// ── The run ──────────────────────────────────────────────────────────────────

export const progress = { running: false }

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
function inWindow(cfg, d = new Date()) {
  const now = d.getHours() * 60 + d.getMinutes()
  return now >= minutes(cfg.window_start) && now < minutes(cfg.window_end)
}
const today = () => new Date().toLocaleDateString('en-CA')

async function sendSet(token, chat_id, password, buf, label) {
  const locked = lock(buf, password)
  const count = Math.ceil(locked.length / PART)
  const ids = new Array(count)
  // Two pieces go up at once: the line never waits on Telegram's answer to the last one.
  let next = 0
  const worker = async () => {
    while (next < count) {
      const i = next++
      const piece = locked.subarray(i * PART, (i + 1) * PART)
      ids[i] = await sendPiece(token, chat_id, piece, `adal-${label}-${i + 1}of${count}.bin`, `Adal Keep backup · ${label} · ${i + 1}/${count}`)
      progress.bytes_sent = (progress.bytes_sent || 0) + piece.length
      if (progress.bytes_total) progress.percent = Math.min(99, Math.floor(progress.bytes_sent / progress.bytes_total * 100))   // 100 when the index is in
    }
  }
  // (One at a time while a robot works: it keeps most of the line.)
  await Promise.all(Array.from({ length: Math.min(runsWorking() > 0 ? 1 : UPLOADS_AT_ONCE, count) }, worker))
  return ids
}

/** The database step: a whole copy when due, else only the pages changed since it. */
async function sendDatabase(s, token, chat_id, password) {
  const raw = await rawSnapshot()
  const ps = pageSizeOf(raw)
  const full = s.sets.find(x => x.type === 'dbz')
  let baseHashes = null
  try { baseHashes = fs.readFileSync(BASE_HASHES) } catch {}
  if (full && baseHashes && full.ps === ps && Date.now() - new Date(full.date).getTime() < FULL_EVERY_MS) {
    const { delta, pages } = makeDelta(raw, ps, baseHashes)
    const sum = crypto.createHash('sha256').update(delta).digest('hex')
    const old = s.sets.find(x => x.type === 'dbz-delta' && x.base_date === full.date)
    if (old?.sum === sum) return false // the database has not changed since the last backup
    const z = await zstd(delta)
    // Changed so much that a new whole copy is hardly bigger: that goes instead.
    if (z.length < (full.bytes || Infinity) * 0.4) {
      progress.bytes_total += z.length
      const parts = await sendSet(token, chat_id, password, z, `database-changes-${today()}`)
      s.sets = s.sets.filter(x => x.type !== 'dbz-delta')
      s.sets.push({ type: 'dbz-delta', date: new Date().toISOString(), base_date: full.date, parts, pages, sum })
      writeState(s)
      return false
    }
  }
  const z = await zstd(raw)
  progress.bytes_total += z.length
  const parts = await sendSet(token, chat_id, password, z, `database-${today()}`)
  s.sets = s.sets.filter(x => !['db', 'dbz', 'dbz-delta'].includes(x.type))
  s.sets.push({ type: 'dbz', date: new Date().toISOString(), parts, bytes: z.length, ps })
  fs.writeFileSync(BASE_HASHES, pageHashes(raw, ps))
  writeState(s)
  return true
}

/**
 * One backup run. `force` ignores the time window (the "Back up now" button);
 * otherwise it stops between sets when the window ends.
 */
export async function runBackup(db, { force = false, docsOnly = false, light = false, dbOnly = false } = {}) {
  if (progress.running) return { busy: true }
  const token = botToken(), password = getSecret('backup_password')
  const s = readState()
  const chat_id = chatOf(s)
  if (!password) throw new Error('Backup is not set up: the backup password is needed.')
  // No Telegram set up: the online storage alone carries it (when the online copy is on).
  if ((!token || !chat_id) && !(await cloudOf(db).catch(() => null))?.agency) throw new Error('Backup is not set up: no Telegram channel and the online copy is off.')
  Object.assign(route, { db, tgDown: false, online: 0 })
  Object.assign(progress, { running: true, started_at: new Date().toISOString(), step: docsOnly ? 'documents' : 'database', bytes_sent: 0, bytes_total: 0, percent: 0, files_done: 0, files_todo: 0, error: null, docs_only: docsOnly })
  s[docsOnly ? 'last_docs_run' : 'last_run'] = new Date().toISOString(); writeState(s)
  try {
    s.sent ||= {}; s.sets ||= []
    // 1. The database (the newest replaces the older ones in the index) —
    //    not on the quick runs that only carry new documents.
    // Everything this run will send, measured first, so it can say how far it is (percent).
    for (const n of dbOnly ? [] : listDocuments().filter(n => !s.sent[n])) { try { progress.bytes_total += fs.statSync(path.join(SAFE, n)).size } catch {} }
    let profilesAtSnap = null
    let sentWhole = false   // a whole database copy went up (only then is it read back to check it)
    if (!docsOnly) {
      try { profilesAtSnap = Number((await db('profiles').count({ n: '*' }).first())?.n) } catch {}
      if (HAS_ZSTD) sentWhole = await sendDatabase(s, token, chat_id, password)
      else {
        const snap = await databaseSnapshot(db)
        progress.bytes_total += snap.length
        const dbIds = await sendSet(token, chat_id, password, snap, `database-${today()}`)
        s.sets = s.sets.filter(x => !['db', 'dbz', 'dbz-delta'].includes(x.type))
        s.sets.push({ type: 'db', date: new Date().toISOString(), parts: dbIds })
        writeState(s)
        sentWhole = true
      }
    }

    // 2. Documents not sent yet, in sets of ~18 MB.
    progress.step = 'documents'
    // (dbOnly: the online copy still needs the line — documents wait.)
    const todo = dbOnly ? [] : listDocuments().filter(n => !s.sent[n])
    progress.files_todo = todo.length
    let group = [], size = 0
    const flush = async () => {
      if (!group.length) return
      const ids = await sendSet(token, chat_id, password, pack(group), `documents-${today()}-${s.sets.length}`)
      s.sets.push({ type: 'files', date: new Date().toISOString(), parts: ids, files: group })
      for (const n of group) s.sent[n] = true
      progress.files_done += group.length
      writeState(s)
      group = []; size = 0
    }
    // (Never waits for the robots: the backup goes now, one piece at a time while one works.)
    for (const name of todo) {
      let sz = 0
      try { sz = fs.statSync(path.join(SAFE, name)).size } catch { continue }
      group.push(name); size += sz
      if (size >= SET_TARGET) await flush()
    }
    await flush()

    // 3. The index — what a restore needs to find every piece.
    progress.step = 'index'
    // With the locked secrets (Musaned authenticators, keys, bot) and the chat account: a restored PC has them again.
    let chat = null
    try { chat = fs.readFileSync(path.join(BACKEND, '.adal_chat.json'), 'utf8') } catch {}
    const what = { sets: s.sets, vault_key: vaultKey(), secrets: secretBlobs(), chat_account: chat }
    // (The chat sign-in's expiry time moves by itself: it alone is no reason to send a new index.)
    const steady = (() => { try { const c = JSON.parse(chat); delete c.expires_at; return JSON.stringify(c) } catch { return chat } })()
    const whatHash = crypto.createHash('sha256').update(JSON.stringify({ ...what, chat_account: steady })).digest('hex')
    if (s.index_file_id && s.index_hash === whatHash) {
      // Nothing new since the last index: the one online already finds everything.
      s.last_ok = new Date().toISOString(); s.last_error = null
      if (!docsOnly) { s.last_day = today(); s.last_full_ok = s.last_ok }
      writeState(s)
      progress.percent = 100
      return { ok: true, documents_left: listDocuments().filter(n => !s.sent[n]).length, unchanged: true, route: route.online ? 'online storage' : 'telegram' }
    }
    const index = Buffer.from(JSON.stringify({ adal_backup: 1, made: new Date().toISOString(), ...what }))
    const indexId = await sendPiece(token, chat_id, lock(zlib.gzipSync(index), password), 'adal-backup-index.enc',
      `🗂 Adal Keep backup index · ${(await db('companies').first().catch(() => null))?.name || 'agency'} · ${new Date().toLocaleString()} · keep the NEWEST one — it is what a restore needs`)
    s.index_file_id = indexId
    s.index_hash = whatHash
    const done = listDocuments()
    await publishBackup(db, { file_id: indexId, key: password, at: new Date().toISOString(), files_sent: Object.keys(s.sent).length, files_total: done.length, error: null }).catch(() => {})

    const left = listDocuments().filter(n => !s.sent[n]).length
    s.last_ok = new Date().toISOString(); s.last_error = null
    if (!docsOnly) { s.last_day = today(); s.last_full_ok = s.last_ok }
    writeState(s)
    progress.percent = 100
    // 4. Proven, not hoped: the backup is read back from Telegram and opened.
    if (!docsOnly && sentWhole) {
      progress.step = 'checking'
      const verify = await verifyBackup(db, { token, password, indexId, profiles: profilesAtSnap })
      const st = readState(); st.verify = verify; writeState(st)
      await publishBackup(db, { verify }).catch(() => {})
      if (!verify.ok) console.error(`[backup] the backup did not read back: ${verify.why}`)
    }
    return { ok: true, documents_left: left, route: route.online ? `online storage (${route.online} piece(s); Telegram did not answer)` : 'telegram' }
  } catch (e) {
    const st = readState(); st.last_error = st.last_fail = e.message; st.last_error_at = st.last_fail_at = new Date().toISOString(); writeState(st)
    progress.error = e.message
    publishBackup(db, { error: e.message, error_at: new Date().toISOString() }).catch(() => {})
    throw e
  } finally {
    progress.running = false
    progress.finished_at = new Date().toISOString()
    fs.rmSync(TMP, { recursive: true, force: true })
  }
}

/**
 * Reads a backup back the way a restore would: the index, the whole database
 * (unlocked, unzipped and opened: its profiles counted), and that the newest
 * document pieces are still in Telegram. Never throws: { ok, why, … }.
 */
export async function verifyBackup(db, { token, password, indexId, profiles = null, fetch: get = fetchPiece, exists = pieceExists } = {}) {
  const at = new Date().toISOString()
  // Its own folder: the backup's folder is emptied when a run ends.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-verify-'))
  const tmp = path.join(dir, 'copy.sqlite')
  try {
    const index = JSON.parse(zlib.gunzipSync(unlock(await get(token, indexId), password)).toString())
    if (!index.adal_backup) return { ok: false, at, why: 'the index is not an Adal Keep backup' }
    const raw = await databaseFromIndex(index, setReader((id) => get(token, id), password))
    if (!raw) return { ok: false, at, why: 'the index has no database' }
    if (!raw.subarray(0, 15).equals(Buffer.from('SQLite format 3'))) return { ok: false, at, why: 'the database piece is not a database' }
    fs.writeFileSync(tmp, raw)
    const knex = (await import('knex')).default
    const copy = knex({ client: 'sqlite3', connection: { filename: tmp }, useNullAsDefault: true })
    let n = null
    try {
      const ok = (await copy.raw('PRAGMA quick_check'))?.[0]
      if (ok && Object.values(ok)[0] !== 'ok') return { ok: false, at, why: `the database copy is damaged (${Object.values(ok)[0]})` }
      n = Number((await copy('profiles').count({ n: '*' }).first())?.n)
    } finally { await copy.destroy().catch(() => {}) }
    if (profiles != null && n < profiles) return { ok: false, at, why: `the copy has ${n} profiles, the PC had ${profiles}` }
    // The newest document sets are still there (asked, not downloaded).
    const fileSets = index.sets.filter(x => x.type === 'files' || x.type === 'rfile')
    let checked = 0
    for (const set of fileSets.slice(-3)) for (const id of set.parts) { if (!(await exists(token, id))) return { ok: false, at, why: 'a document piece is missing in Telegram' }; checked++ }
    return { ok: true, at, profiles: n, database_mb: Math.round(raw.length / 104857.6) / 10, document_sets: fileSets.length, pieces_checked: checked }
  } catch (e) {
    return { ok: false, at, why: String(e.message || e).slice(0, 200) }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
async function pieceExists(token, fileId) {
  if (String(fileId).startsWith('sb:')) {
    try {
      const c = route.db && await cloudOf(route.db)
      return !!c && (await c.cloudCall(route.db, 'HEAD', `/storage/v1/object/authenticated/keep/${String(fileId).slice(3)}`, undefined, { raw: true, timeout: 60_000 })).ok
    } catch { return false }
  }
  try { return !!(await tg(token, 'getFile', JSON.stringify({ file_id: fileId })))?.file_path } catch { return false }
}

// Adal can always recover an agency: after every backup the agency's own
// Supabase rows hold the newest index's Telegram file id AND the key it is
// locked with (keep_meta "/_backup" — only that agency and Adal read it).
// Adal Keep Admin restores it on the agency's PC, onto a new PC, or downloads
// everything to Adal's own PC; a new PC of the agency finds it by itself.
const BACKUP_KEY = '/_backup'
async function cloudOf(db) {
  const { cloudOn } = await import('./cloudSync.js')
  if (!(await cloudOn(db))) return null
  const { cloudCall, cloudAgencyId } = await import('./chatCloud.js')
  return { cloudCall, agency: await cloudAgencyId(db) }
}
async function publishBackup(db, data) {
  const c = await cloudOf(db)
  if (!c?.agency) return
  const [old] = await c.cloudCall(db, 'GET', `/rest/v1/keep_meta?agency_id=eq.${c.agency}&key=eq.${encodeURIComponent(BACKUP_KEY)}&select=data`).catch(() => [])
  await c.cloudCall(db, 'POST', '/rest/v1/keep_meta?on_conflict=agency_id,key',
    [{ agency_id: c.agency, key: BACKUP_KEY, data: sealedForCloud({ ...(old?.data || {}), ...data }), updated_at: new Date().toISOString() }],
    { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } })
}
/** The newest backup: { index (buffer), key } — from this PC's notes or the agency's online rows. */
export async function newestBackup(db, { file_id, key } = {}) {
  if (!file_id) {
    const c = await cloudOf(db)
    if (c?.agency) {
      const rows = await c.cloudCall(db, 'GET', `/rest/v1/keep_meta?agency_id=eq.${c.agency}&key=in.(${BACKUP_KEY},/_backup_index)&select=key,data`).catch(() => [])
      const b = rows.find(r => r.key === BACKUP_KEY)?.data || rows.find(r => r.key === '/_backup_index')?.data
      // (A sealed key — ADAL_BACKUP_SEAL — is opened only by Adal; this PC's own key still works.)
      if (b?.file_id) { file_id = b.file_id; key ||= b.key || undefined }
    }
    file_id ||= readState().index_file_id
  }
  if (!file_id) throw new Error('No backup was found for this agency yet.')
  return { index: await fetchPiece(botToken(), file_id), key: key || getSecret('backup_password') }
}
export async function newestIndex(db) { return (await newestBackup(db)).index }

/** Every agency is backed up without setting anything up: no password yet → the PC makes a strong key itself. */
export function ensureBackupKey() {
  if (getSecret('backup_password')) return
  setSecret('backup_password', crypto.randomBytes(24).toString('base64url'))
  console.log('💾 Backup key made (Adal keeps a copy online for recovery)')
}

let timer = null
// "Back up now" (or a move from another system just ended): the whole backup
// goes at the next tick, not two hours later.
let wanted = false
export function backupSoon() { wanted = true }
/**
 * Backups never wait — not for the online copy to fill, not for a move, not
 * for the robots (while one works the pieces go one at a time):
 *   - new documents go within seconds of arriving (a quick run with only them
 *     and the small index a restore reads);
 *   - the whole database every 2 hours (once a day at least).
 * Each piece goes to Telegram when it answers, otherwise to the agency's
 * online storage; with neither, the run fails and is tried again soon
 * (1, 2, 4 … at most 15 minutes after, by itself). Nothing goes twice: what
 * was sent is in backup-state.json (documents by name, the database by hash).
 */
const DB_EVERY_MS = 2 * 3600 * 1000
const QUIET_MS = 10 * 60 * 1000          // full runs: at most one every 10 minutes
// Agency PCs are unplugged at night: a PC switched on whose last whole backup
// is older than this starts one within a few minutes of starting.
export const CATCH_UP_MS = 20 * 3600 * 1000
const BOOT_SETTLE_MS = 90 * 1000         // let the PC finish starting first
const BOOT_IDLE_MAX_MS = 5 * 60 * 1000   // waits this long at most for the robots to be quiet
const IDLE_MAX_LATE_MS = 30 * 60 * 1000  // a day-time run waits for quiet robots at most this long
const bootAt = Date.now()
const ms = (t) => t ? new Date(t).getTime() || 0 : 0

/** When the last whole backup (database + documents + index) went well. */
export function lastFullAt(s = readState()) {
  if (s.last_full_ok) return s.last_full_ok
  const lastDb = (s.sets || []).filter(x => /^(db|rdb)/.test(x.type)).map(x => ms(x.date)).sort((a, b) => a - b).pop()
  return lastDb ? new Date(lastDb).toISOString() : null
}

/**
 * Is a whole backup due now? (No time window: PCs are off at night.)
 *   - just switched on and the last one is older than 20 h: after 90 s, as
 *     soon as the robots are quiet, and after 5 minutes whatever they do;
 *   - otherwise every 2 hours, waiting for quiet robots at most 30 minutes;
 *   - never two within 10 minutes (a failed one is tried again by the retry).
 */
export function fullBackupDue({ now = Date.now(), lastFull = null, lastRun = null, bootAt: boot = bootAt, robots = 0 } = {}) {
  const since = now - ms(lastFull)
  const sinceBoot = now - boot
  if (now - ms(lastRun) < QUIET_MS && ms(lastRun) > boot) return false
  if (since > CATCH_UP_MS) {
    if (sinceBoot < BOOT_SETTLE_MS) return false
    return robots === 0 || sinceBoot >= BOOT_IDLE_MAX_MS
  }
  if (now - ms(lastRun) < QUIET_MS) return false
  if (since < DB_EVERY_MS) return false
  return robots === 0 || since >= DB_EVERY_MS + IDLE_MAX_LATE_MS
}

/**
 * The newest good backup, whoever made it: this PC, or a Companion from its
 * copy while this PC was off (it says so when it reaches this PC again).
 */
export function backupHealth(s = readState()) {
  const own = lastFullAt(s)
  const companion = s.companion_backup?.at || null
  const good = [own, companion].filter(Boolean).sort().pop() || null
  return {
    last_good_at: good,
    last_full_ok: own,
    last_ok: s.last_ok || null,
    last_error: s.last_error || null,
    last_error_at: s.last_error_at || null,
    companion_backup: s.companion_backup || null,
    enabled: s.enabled !== false,
    since: s.first_seen || null,   // backing up since (no backup yet is a warning only 48 h after this)
  }
}

/** A Companion backed up from its copy (this PC was off): it counts as a good backup. */
export function recordCompanionBackup({ at, index_file_id, by } = {}) {
  const t = ms(at)
  if (!t || t > Date.now() + 5 * 60000) throw new Error('A time is needed')
  const s = readState()
  if (ms(s.companion_backup?.at) >= t) return s.companion_backup
  s.companion_backup = { at: new Date(t).toISOString(), index_file_id: String(index_file_id || '').slice(0, 300) || null, by: String(by || 'a Companion').slice(0, 80) }
  writeState(s)
  return s.companion_backup
}
const DOCS_GAP_MS = 15 * 1000            // quick runs: at most one every 15 seconds
const TICK_MS = 10 * 1000
let kick = null
let failures = 0
/** After a failed run: when to try again (1, 2, 4, 8, 15 minutes). Exported for tests. */
export const retryAfterMs = (n) => Math.min(15, 2 ** Math.max(0, n - 1)) * 60 * 1000
export function startBackupSchedule(db) {
  if (timer) return
  route.db = db
  ensureBackupKey()
  try { const s = readState(); if (!s.first_seen) { s.first_seen = new Date().toISOString(); writeState(s) } } catch {}
  const done = (what) => (r) => { failures = 0; console.log(what, r) }
  const failed = (what) => (e) => { failures++; console.warn(`${what} ${e.message} — again in ${retryAfterMs(failures) / 60000} min`) }
  const tick = async () => {
    try {
      const cfg = getConfig()
      if (!cfg.enabled || !cfg.has_password || progress.running) return
      // A route: Telegram, or the online storage.
      if (!(cfg.has_token && cfg.chat_id) && !(await cloudOf(db).catch(() => null))?.agency) return
      const s = readState()
      const ago = (t) => t ? Date.now() - new Date(t).getTime() : Infinity
      if (failures && s.last_error && ago(s.last_error_at) < retryAfterMs(failures)) return

      // New documents: a quick run.
      const fresh = listDocuments().filter(n => !s.sent?.[n])
      if (fresh.length && ago(s.last_docs_run) >= DOCS_GAP_MS && !wanted) {
        runBackup(db, { docsOnly: true, light: true })
          .then(r => { failures = 0; console.log(`[backup] ${fresh.length} new document(s) backed up (${r.route})`, r.documents_left ? `(${r.documents_left} still to go)` : '') })
          .catch(failed('[backup] documents failed:'))
        return
      }

      // The database (text first: it goes before the documents in a full run).
      if (!wanted && !fullBackupDue({ now: Date.now(), lastFull: lastFullAt(s), lastRun: s.last_run, bootAt, robots: runsWorking() })) return
      wanted = false
      runBackup(db).then(done('[backup] done')).catch(failed('[backup] failed:'))
    } catch (e) { console.warn('[backup] schedule:', e.message) }
  }
  timer = setInterval(tick, TICK_MS)
  // A new document: look in 3 s instead of waiting for the next tick.
  try {
    fs.mkdirSync(SAFE, { recursive: true })
    fs.watch(SAFE, () => { clearTimeout(kick); kick = setTimeout(tick, 3000) }).on('error', () => {})
  } catch {}
  console.log('💾 Telegram backup: new documents within seconds, the database every 2 hours when the robots are free (and within minutes of switching on when the last one is older than 20 h)')
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Restore from the newest index file (downloaded from the channel). The
 * current database is kept as data.sqlite.before-restore-<time>; documents
 * that already exist are left alone. The server must restart afterwards.
 */
export async function restoreFrom(indexBuf, { bot_token, password, fromReplica = false }) {
  const token = String(bot_token || botToken() || '').trim()
  if ((!token && !fromReplica) || !password) throw new Error('The backup key is needed.')
  const index = JSON.parse(zlib.gunzipSync(unlock(indexBuf, password)).toString())
  if (!index.adal_backup) throw new Error('That is not an Adal Keep backup index.')
  Object.assign(progress, { running: true, step: 'restore', files_done: 0, error: null })
  try {
    const get = setReader((id) => fetchPiece(token, id), password)
    fs.mkdirSync(SAFE, { recursive: true })
    let files = 0
    for (const set of index.sets.filter(x => x.type === 'files' || x.type === 'rfile')) {
      if (set.type === 'files') files += unpack(await get(set), SAFE)
      else {
        const dest = path.join(SAFE, path.basename(set.name))
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, await get(set))
        files++
      }
      progress.files_done = files
    }
    const raw = await databaseFromIndex(index, get)
    if (raw) {
      if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, `${DB_FILE}.before-restore-${Date.now()}`)
      fs.writeFileSync(`${DB_FILE}.restored`, raw)
      fs.rmSync(BASE_HASHES, { force: true })   // this PC's next backup sends a whole copy again
      stageVaultKey(index.vault_key)   // the restored passwords open with it
      restoreSecretBlobs(index.secrets)  // and the authenticators, keys and bot with it
      if (index.chat_account && !fs.existsSync(path.join(BACKEND, '.adal_chat.json'))) fs.writeFileSync(path.join(BACKEND, '.adal_chat.json'), index.chat_account)
    }
    // The database is swapped in on the next start (the open one cannot be replaced live).
    return { ok: true, files, database: !!raw, made: index.made }
  } finally {
    progress.running = false
  }
}

/**
 * Restore from a Companion's copy on the office network (the main PC died, or
 * this is the new main PC). The Companion hands its copy as a backup index
 * whose pieces it serves itself, all still locked with the backup key.
 */
export async function restoreFromCompanion(address, { number, password } = {}) {
  const url = String(address || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[\w.:-]+$/.test(url)) throw new Error("Type the Companion's address, like http://192.168.1.20:47810")
  const num = String(number || '').replace(/\D/g, '')
  if (!num) throw new Error("The main PC's number is needed (the Companion checks it)")
  const r = await fetch(`${url}/replica/index`, { headers: { 'x-adal-number': num }, signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(r.status === 403 ? 'That Companion holds the copy of another main PC (the number does not match)' : `The Companion answered ${r.status}`)
  const indexBuf = Buffer.from(await r.arrayBuffer())
  route.replica = { url, number: num }
  try { return await restoreFrom(indexBuf, { password: password || getSecret('backup_password'), fromReplica: true }) }
  finally { route.replica = null }
}

/** On start: put a restored database in place before anything opens it. */
export function applyRestoredDatabase() {
  const r = `${DB_FILE}.restored`
  if (!fs.existsSync(r)) return false
  for (const ext of ['-wal', '-shm']) fs.rmSync(DB_FILE + ext, { force: true })
  fs.renameSync(r, DB_FILE)
  applyStagedVaultKey()
  console.log('💾 Restored database put in place')
  return true
}
