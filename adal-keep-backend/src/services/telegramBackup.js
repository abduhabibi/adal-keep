/**
 * telegramBackup.js — an off-site copy of the main PC in a private Telegram
 * channel, so a stolen, broken or burnt PC loses nothing.
 *
 * WHEN  Once a day in the lunch break (default 12:30–13:30, Settings), so it
 *       never slows the office internet. Whatever is not sent by the end of
 *       the window is sent the next day. "Back up now" runs it at once.
 * WHAT  The whole database every time; documents only once (each new file is
 *       sent the first time it appears).
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
import { runsWorking } from './busy.js'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { getSecret, setSecret } from './secretStore.js'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = path.join(BACKEND, 'data')
const SAFE = path.join(DATA, 'SafeStorage')
const STATE = process.env.ADAL_BACKUP_STATE || path.join(DATA, 'backup-state.json')
const TMP = path.join(DATA, 'backup-tmp')
const DB_FILE = process.env.SQLITE_PATH ? path.resolve(process.env.SQLITE_PATH) : path.join(BACKEND, 'data.sqlite')

const PART = 4 * 1024 * 1024           // small pieces: each one gets through a slow office line (a bot downloads ≤ 20 MB)
const SET_TARGET = 18 * 1024 * 1024    // documents are grouped into sets of about this size
const MAGIC = Buffer.from('ADALBK1')

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
    window_start: s.window_start || '12:30',
    window_end: s.window_end || '13:30',
    enabled: s.enabled !== false,
    has_token: !!botToken(),
    has_password: !!getSecret('backup_password'),
    last_run: s.last_run || null,
    last_ok: s.last_ok || null,
    last_error: s.last_error || null,
    files_sent: Object.keys(s.sent || {}).length,
    files_total: listDocuments().length,
  }
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
  if (chat_id !== undefined) s.chat_id = String(chat_id).trim()
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
  if (window_start !== undefined) { if (!hhmm.test(window_start)) throw new Error('Start time like 12:30'); s.window_start = window_start }
  if (window_end !== undefined) { if (!hhmm.test(window_end)) throw new Error('End time like 13:30'); s.window_end = window_end }
  if (enabled !== undefined) s.enabled = !!enabled
  writeState(s)
  return getConfig()
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function tg(token, method, body, timeoutMs = 60000, tries = 0) {
  let r
  try {
    r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', body, signal: AbortSignal.timeout(timeoutMs),
    ...(body instanceof FormData ? {} : { headers: { 'content-type': 'application/json' } }),
  })
  } catch (e) {
    // The line dropped: wait a little and send it again (a few times).
    if (tries >= 4) throw new Error(`No connection to Telegram (${e.cause?.code || e.message})`)
    await new Promise(ok => setTimeout(ok, [5, 15, 30, 60][tries] * 1000))
    return tg(token, method, body, timeoutMs, tries + 1)
  }
  const j = await r.json().catch(() => ({}))
  // One channel serves many agencies: when Telegram says "too many", wait as it asks.
  if (j.error_code === 429 && tries < 6) {
    await new Promise(ok => setTimeout(ok, ((j.parameters?.retry_after || 5) + 1) * 1000))
    return tg(token, method, body, timeoutMs, tries + 1)
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

/** The channels/groups the bot has seen a post in (after it was made admin). */
export async function findChats() {
  const token = botToken()
  if (!token) throw new Error('Paste the bot token first.')
  const ups = await tg(token, 'getUpdates', JSON.stringify({ allowed_updates: ['channel_post', 'message', 'my_chat_member'] }))
  const seen = new Map()
  for (const u of ups) {
    const c = u.channel_post?.chat || u.message?.chat || u.my_chat_member?.chat
    if (c && c.type !== 'private') seen.set(c.id, { id: c.id, title: c.title || c.username || String(c.id), type: c.type })
  }
  return [...seen.values()]
}

async function sendPiece(token, chat_id, buf, filename, caption) {
  const fd = new FormData()
  fd.append('chat_id', String(chat_id))
  fd.append('caption', caption.slice(0, 1000))
  fd.append('disable_notification', 'true')
  fd.append('document', new Blob([buf]), filename)
  // Slow office lines: allow 10 minutes for one 19 MB piece.
  const res = await tg(token, 'sendDocument', fd, 10 * 60 * 1000)
  return res.document.file_id
}

async function fetchPiece(token, fileId) {
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

async function databaseSnapshot(db) {
  fs.mkdirSync(TMP, { recursive: true })
  const out = path.join(TMP, `db-${Date.now()}.sqlite`)
  // A consistent copy while the app keeps running.
  await db.raw('VACUUM INTO ?', [out])
  const buf = zlib.gzipSync(fs.readFileSync(out), { level: 9 })
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
  const ids = []
  const count = Math.ceil(locked.length / PART)
  for (let i = 0; i < count; i++) {
    const piece = locked.subarray(i * PART, (i + 1) * PART)
    ids.push(await sendPiece(token, chat_id, piece, `adal-${label}-${i + 1}of${count}.bin`, `Adal Keep backup · ${label} · ${i + 1}/${count}`))
    progress.bytes_sent = (progress.bytes_sent || 0) + piece.length
  }
  return ids
}

/**
 * One backup run. `force` ignores the time window (the "Back up now" button);
 * otherwise it stops between sets when the window ends.
 */
export async function runBackup(db, { force = false } = {}) {
  if (progress.running) return { busy: true }
  const token = botToken(), password = getSecret('backup_password')
  const s = readState()
  const chat_id = chatOf(s)
  if (!token || !password || !chat_id) throw new Error('Backup is not set up: the backup password is needed.')
  Object.assign(progress, { running: true, started_at: new Date().toISOString(), step: 'database', bytes_sent: 0, files_done: 0, files_todo: 0, error: null })
  s.last_run = new Date().toISOString(); writeState(s)
  const cfg = getConfig()
  try {
    s.sent ||= {}; s.sets ||= []
    // 1. The database, every run (the newest replaces the older ones in the index).
    const dbIds = await sendSet(token, chat_id, password, await databaseSnapshot(db), `database-${today()}`)
    s.sets = s.sets.filter(x => x.type !== 'db')
    s.sets.push({ type: 'db', date: new Date().toISOString(), parts: dbIds })
    writeState(s)

    // 2. Documents not sent yet, in sets of ~18 MB.
    progress.step = 'documents'
    const todo = listDocuments().filter(n => !s.sent[n])
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
    for (const name of todo) {
      if (!force && runsWorking() > 0) break // a run needs the internet: the rest goes when it is free again
      let sz = 0
      try { sz = fs.statSync(path.join(SAFE, name)).size } catch { continue }
      group.push(name); size += sz
      if (size >= SET_TARGET) await flush()
    }
    if (force || runsWorking() === 0) await flush()

    // 3. The index — what a restore needs to find every piece.
    progress.step = 'index'
    const index = Buffer.from(JSON.stringify({ adal_backup: 1, made: new Date().toISOString(), sets: s.sets }))
    const indexId = await sendPiece(token, chat_id, lock(zlib.gzipSync(index), password), 'adal-backup-index.enc',
      `🗂 Adal Keep backup index · ${(await db('companies').first().catch(() => null))?.name || 'agency'} · ${new Date().toLocaleString()} · keep the NEWEST one — it is what a restore needs`)
    s.index_file_id = indexId
    const done = listDocuments()
    await publishBackup(db, { file_id: indexId, key: password, at: new Date().toISOString(), files_sent: Object.keys(s.sent).length, files_total: done.length, error: null }).catch(() => {})

    const left = listDocuments().filter(n => !s.sent[n]).length
    s.last_ok = new Date().toISOString(); s.last_day = today(); s.last_error = null
    writeState(s)
    return { ok: true, documents_left: left }
  } catch (e) {
    const st = readState(); st.last_error = e.message; writeState(st)
    progress.error = e.message
    publishBackup(db, { error: e.message, error_at: new Date().toISOString() }).catch(() => {})
    throw e
  } finally {
    progress.running = false
    progress.finished_at = new Date().toISOString()
    fs.rmSync(TMP, { recursive: true, force: true })
  }
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
    [{ agency_id: c.agency, key: BACKUP_KEY, data: { ...(old?.data || {}), ...data }, updated_at: new Date().toISOString() }],
    { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } })
}
/** The newest backup: { index (buffer), key } — from this PC's notes or the agency's online rows. */
export async function newestBackup(db, { file_id, key } = {}) {
  if (!file_id) {
    const c = await cloudOf(db)
    if (c?.agency) {
      const rows = await c.cloudCall(db, 'GET', `/rest/v1/keep_meta?agency_id=eq.${c.agency}&key=in.(${BACKUP_KEY},/_backup_index)&select=key,data`).catch(() => [])
      const b = rows.find(r => r.key === BACKUP_KEY)?.data || rows.find(r => r.key === '/_backup_index')?.data
      if (b?.file_id) { file_id = b.file_id; key ||= b.key }
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
/**
 * Whenever the robots are free (no run working or waiting), any time of day:
 * new documents go online within minutes, the database every 2 hours (and
 * once a day at least). A run that starts pauses the backup between sets; it
 * carries on when the runs are free again.
 */
const DB_EVERY_MS = 2 * 3600 * 1000
const QUIET_MS = 10 * 60 * 1000          // at most one run every 10 minutes
export function startBackupSchedule(db) {
  if (timer) return
  if (botToken()) ensureBackupKey()
  timer = setInterval(async () => {
    try {
      const cfg = getConfig()
      if (!cfg.enabled || !cfg.has_token || !cfg.has_password || !cfg.chat_id || progress.running) return
      if (runsWorking() > 0) return
      const waiting = Number((await db('automation_queue').where('status', 'pending').count({ c: '*' }).first().catch(() => null))?.c || 0)
      if (waiting > 0) return
      const s = readState()
      const since = s.last_run ? Date.now() - new Date(s.last_run).getTime() : Infinity
      if (since < QUIET_MS) return
      // Failed lately? again after 15 minutes.
      if (s.last_error && since < 15 * 60 * 1000) return
      const newDocs = listDocuments().some(n => !s.sent?.[n])
      const lastDb = (s.sets || []).filter(x => x.type === 'db').map(x => new Date(x.date).getTime()).pop() || 0
      if (!newDocs && Date.now() - lastDb < DB_EVERY_MS && s.last_day === today()) return
      runBackup(db).then(r => console.log('[backup] done', r)).catch(e => console.warn('[backup] failed:', e.message))
    } catch (e) { console.warn('[backup] schedule:', e.message) }
  }, 2 * 60 * 1000)
  console.log('💾 Telegram backup: whenever the robots are free (new documents within minutes, the database every 2 hours)')
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Restore from the newest index file (downloaded from the channel). The
 * current database is kept as data.sqlite.before-restore-<time>; documents
 * that already exist are left alone. The server must restart afterwards.
 */
export async function restoreFrom(indexBuf, { bot_token, password }) {
  const token = String(bot_token || botToken() || '').trim()
  if (!token || !password) throw new Error('The backup key is needed.')
  const index = JSON.parse(zlib.gunzipSync(unlock(indexBuf, password)).toString())
  if (!index.adal_backup) throw new Error('That is not an Adal Keep backup index.')
  Object.assign(progress, { running: true, step: 'restore', files_done: 0, error: null })
  try {
    const get = async (set) => {
      const bufs = []
      for (const id of set.parts) bufs.push(await fetchPiece(token, id))
      return unlock(Buffer.concat(bufs), password)
    }
    fs.mkdirSync(SAFE, { recursive: true })
    let files = 0
    for (const set of index.sets.filter(x => x.type === 'files')) {
      files += unpack(await get(set), SAFE)
      progress.files_done = files
    }
    const dbSet = index.sets.find(x => x.type === 'db')
    if (dbSet) {
      const raw = zlib.gunzipSync(await get(dbSet))
      if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, `${DB_FILE}.before-restore-${Date.now()}`)
      fs.writeFileSync(`${DB_FILE}.restored`, raw)
    }
    // The database is swapped in on the next start (the open one cannot be replaced live).
    return { ok: true, files, database: !!dbSet, made: index.made }
  } finally {
    progress.running = false
  }
}

/** On start: put a restored database in place before anything opens it. */
export function applyRestoredDatabase() {
  const r = `${DB_FILE}.restored`
  if (!fs.existsSync(r)) return false
  for (const ext of ['-wal', '-shm']) fs.rmSync(DB_FILE + ext, { force: true })
  fs.renameSync(r, DB_FILE)
  console.log('💾 Restored database put in place')
  return true
}
