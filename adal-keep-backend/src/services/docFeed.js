/**
 * docFeed.js — what changed among the photos and documents, for the Companions that keep the ones
 * their people use on their own disk (adal-companion owndocs.go; the owner, 2026-11-25: "not only the
 * update, also files, normal photos and files").
 *
 * Nothing is listed or compared: the folders' own change notices (fs.watch) and the change log of the
 * files' rows (sync_log) go into a small journal. A Companion says up to where it knows and gets what
 * changed since, at once when something does (it waits on one open question). After a restart here, or
 * a journal too old, it sends the documents it holds (by name, size and time) and is told which differ.
 *
 * Off: ADAL_OWN_DOCS=0.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { docSum } from './replica.js'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const docsOn = () => process.env.ADAL_OWN_DOCS !== '0'
export const dirs = () => ({ safe: process.env.ADAL_BACKUP_SAFE || path.join(BACKEND, 'data', 'SafeStorage'), uploads: process.env.ADAL_UPLOADS_DIR || path.join(BACKEND, 'uploads') })

const epoch = crypto.randomBytes(5).toString('hex')
let rev = 0, log = [], vec = null
const waiting = new Set(), watchers = []
function add(e) { log.push({ rev: ++rev, ...e }); if (log.length > 3000) log.splice(0, 1500); clearTimeout(add.t); add.t = setTimeout(() => { for (const w of [...waiting]) w() }, 300); add.t.unref?.() }

export function startDocFeed(db) {
  if (!docsOn() || watchers.length) return
  for (const [k, d] of Object.entries(dirs())) {
    try {
      fs.mkdirSync(d, { recursive: true })
      const w = fs.watch(d, { persistent: false, recursive: k === 'uploads' }, (_e, name) => { if (name) add({ name: (k === 'uploads' ? 'uploads/' : '') + String(name).split(path.sep).join('/') }) })
      w.on('error', () => {})
      watchers.push(w)
    } catch (e) { console.warn(`[docs] ${k} is not watched: ${e.message}`) }
  }
  import('./changes.js').then(c => watchers.push({ close: c.onChanged(e => { if (e?.tables?.includes('files')) look(db) }) })).catch(() => {})
}
export function stopDocFeed() { for (const w of watchers.splice(0)) try { w.close() } catch {} }
let soon = null
function look(db) { soon ||= setTimeout(() => { soon = null; readRows(db).catch(() => {}) }, 1500); soon.unref?.() }
/** The files' rows changed since the last look, from the change log. */
export async function readRows(db) {
  const top = Object.fromEntries((await db.raw('SELECT origin, MAX(seq) AS s FROM sync_log GROUP BY origin')).map(r => [r.origin, Number(r.s)]))
  if (vec) for (const [o, s] of Object.entries(top)) {
    if (s <= (vec[o] || 0)) continue
    const rows = (await db.raw("SELECT DISTINCT rid FROM sync_log WHERE origin = ? AND seq > ? AND tbl = 'files' LIMIT 500", [o, vec[o] || 0])).map(r => r.rid)
    for (const id of rows) {
      const f = await db('files').leftJoin('profile_fields', 'files.profile_field_id', 'profile_fields.id').where('files.id', id).first('files.mimetype', 'files.size', 'profile_fields.profile_id').catch(() => null)
      add({ id: String(id), profile: f?.profile_id ?? null, gone: !f, mime: f?.mimetype || '', size: f?.size || 0 })
    }
  }
  vec = top
}

export const at = () => `${epoch}:${rev}`
export function since(a) {
  const [e, r] = String(a || '').split(':'); const n = Number(r)
  if (e !== epoch || !Number.isInteger(n) || n > rev || (log.length && n < log[0].rev - 1)) return { at: at(), reset: true }
  const c = log.filter(x => x.rev > n)
  return { at: at(), names: [...new Set(c.filter(x => x.name).map(x => x.name))], rows: [...new Map(c.filter(x => x.id).map(x => [x.id, { id: x.id, profile: x.profile, gone: x.gone, mime: x.mime, size: x.size }])).values()] }
}
/** since(), or (nothing changed) the next change, at most waitMs later. */
export async function next(db, a, waitMs, signal) {
  await readRows(db).catch(() => {})
  const now = since(a)
  if (now.reset || now.names.length || now.rows.length || !waitMs) return now
  await new Promise(ok => {
    const done = () => { clearTimeout(t); waiting.delete(done); ok() }
    const t = setTimeout(done, waitMs)
    waiting.add(done)
    signal?.addEventListener?.('abort', done, { once: true })
  })
  return since(a)
}

/** The name a stored file has for the Companions (SafeStorage: its name; uploads: its path), or null. */
export function nameOf(file) {
  const { safe, uploads } = dirs(), p = path.resolve(file)
  if (path.dirname(p) === path.resolve(safe)) return path.basename(p)
  const r = path.relative(uploads, p)
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? 'uploads/' + r.split(path.sep).join('/') : null
}
function fileOf(name) {
  const { safe, uploads } = dirs()
  if (typeof name !== 'string' || name.length > 300 || /(^|\/)\.\.(\/|$)|\\|\0/.test(name)) return null
  if (name.startsWith('uploads/')) return path.join(uploads, name.slice(8))
  return name.includes('/') ? null : path.join(safe, name)
}
export const versionOf = (name, st) => docSum(name, st)
/** Of the documents a Companion holds ([name, version]): the names that are not so any more. */
export async function differ(list) {
  const out = []
  let n = 0
  for (const [name, v] of list.slice(0, 20000)) {
    const f = fileOf(name)
    try { if (!f || versionOf(name, fs.statSync(f)) !== v) out.push(name) } catch { out.push(name) }
    if (++n % 100 === 0) await new Promise(r => setImmediate(r))
  }
  return out
}

const hashes = new Map()   // file → "size|mtime" → sha256
export async function hashOf(file, st = fs.statSync(file)) {
  const k = `${st.size}|${st.mtimeMs}`, was = hashes.get(file)
  if (was?.k === k) return was.h
  const h = await new Promise((ok, no) => { const x = crypto.createHash('sha256'); fs.createReadStream(file).on('data', d => x.update(d)).on('error', no).on('end', () => ok(x.digest('hex'))) })
  if (hashes.size > 5000) hashes.clear()
  hashes.set(file, { k, h })
  return h
}
