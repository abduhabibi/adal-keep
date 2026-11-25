/**
 * pictures.js — the small copies of the pictures a page shows (a document's
 * thumbnail, the pictures inside a CV). Each is made once and kept on disk
 * (data/pic-cache): made again on every start, they took seconds on a weak PC.
 *
 *   - few at a time: the picture work and the database share the same few
 *     threads, so six CVs opened at once made every other click wait for them.
 *     A thumbnail goes before the CV pictures in the line.
 *   - the same picture asked for twice at once is made once.
 *   - a deleted or replaced document's copies go with it (forgetPictures).
 *   - a PDF's first page is drawn in its own thread (pdfPageWorker.js): drawn
 *     on the main one, nothing else answered meanwhile.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIR = process.env.ADAL_PIC_CACHE || path.join(here, '../../data/pic-cache')
const MAX_BYTES = 300 * 1024 * 1024
const sha = (s) => createHash('sha1').update(s).digest('hex')
// Named by the document's file name first: all its copies are found without knowing what was made of it.
const prefixOf = (abs) => sha(path.basename(abs)).slice(0, 16)

// ---------------------------------------------------------------- the line
// Two lanes, one on a PC with two threads: the rest of the threads stay free for the database.
export const LANES = Math.max(1, Math.min(2, (os.availableParallelism?.() || os.cpus().length) - 1))
let working = 0
const line = []
function next() {
  while (working < LANES && line.length) {
    const job = line.shift()
    working++
    Promise.resolve().then(job.fn).then(job.ok, job.no).finally(() => { working--; next() })
  }
}
/** fn in its turn; first: before the ones waiting (a thumbnail before CV pictures). */
export function inLine(fn, { first = false } = {}) {
  return new Promise((ok, no) => {
    const job = { fn, ok, no, first }
    const at = first ? line.findIndex(j => !j.first) : -1
    if (at >= 0) line.splice(at, 0, job); else line.push(job)
    next()
  })
}

// ---------------------------------------------------------------- kept on disk
const copyFile = (abs, st, name, ext) => path.join(DIR, `${prefixOf(abs)}-${sha(`${abs}:${st.mtimeMs}:${st.size}:${name}`).slice(0, 16)}.${ext}`)
const making = new Map()
/** The copy of `abs` called `name` (its settings), as { file, buf }; made by make(abs) → Buffer the first time. */
export async function smallCopy(abs, name, ext, make, opts = {}) {
  const file = copyFile(abs, await fs.promises.stat(abs), name, ext)
  if (making.has(file)) return making.get(file)
  const p = (async () => {
    try { return { file, buf: await fs.promises.readFile(file), kept: true } } catch {}
    const buf = await inLine(() => make(abs), opts)
    try {
      await fs.promises.mkdir(DIR, { recursive: true })
      const tmp = `${file}.${process.pid}.${sha(String(Math.random())).slice(0, 6)}.tmp`
      await fs.promises.writeFile(tmp, buf)
      // Deleted while it was being made: not kept.
      if (fs.existsSync(abs)) await fs.promises.rename(tmp, file); else await fs.promises.rm(tmp, { force: true })
      prune()
    } catch {}   // a full disk: shown, not kept
    return { file, buf, kept: false }
  })()
  making.set(file, p)
  p.catch(() => {}).finally(() => making.delete(file))
  return p
}

/** Is that copy there already? */
export async function isKept(abs, name, ext) {
  try { await fs.promises.access(copyFile(abs, await fs.promises.stat(abs), name, ext)); return true } catch { return false }
}

/** A document was deleted or replaced: its small copies go too. */
export function forgetPictures(abs) {
  if (!abs) return
  const pre = prefixOf(abs)
  let names = []
  try { names = fs.readdirSync(DIR) } catch { return }
  for (const n of names) if (n.startsWith(pre)) { try { fs.rmSync(path.join(DIR, n), { force: true }) } catch {} }
}

// The oldest go when there is too much (looked at once in 50 new ones).
let made = 0
async function prune() {
  if (++made % 50) return
  try {
    const all = []
    for (const n of await fs.promises.readdir(DIR)) {
      const s = await fs.promises.stat(path.join(DIR, n)).catch(() => null)
      if (s) all.push({ n, at: s.mtimeMs, size: s.size })
    }
    let sum = all.reduce((t, f) => t + f.size, 0)
    for (const f of all.sort((a, b) => a.at - b.at)) {
      if (sum <= MAX_BYTES) break
      await fs.promises.rm(path.join(DIR, f.n), { force: true })
      sum -= f.size
    }
  } catch {}
}

// ---------------------------------------------------------------- thumbnails
const THUMB_PX = 400                  // the cards are up to ~370 px wide; a square, as they show it
const THUMB_FROM = 60 * 1024          // a smaller file is its own thumbnail
const THUMB = `thumb${THUMB_PX}`
const BEHIND_MS = 500
const behind = new Set()
/**
 * A picture's thumbnail file, or null (not a picture sharp reads, a small
 * file, or not ready within `waitMs`: it goes on behind and is there next time).
 * With other pictures being made it is not waited for at all: the whole file
 * goes at once, and the small one is made a moment later.
 */
export async function thumbnailFile(abs, mimetype = '', waitMs = 100) {
  if (!/^image\/(jpe?g|png|webp)$/i.test(mimetype || '') && !/\.(jpe?g|png|webp)$/i.test(abs)) return null
  const st = await fs.promises.stat(abs).catch(() => null)
  if (!st || st.size < THUMB_FROM) return null
  const make = () => smallCopy(abs, THUMB, 'webp', async (a) => {
    const sharp = (await import('sharp')).default
    return sharp(a).rotate().resize(THUMB_PX, THUMB_PX, { fit: 'cover', position: 'center', withoutEnlargement: true }).webp({ quality: 80, effort: 1 }).toBuffer()
  }, { first: true }).then(async r => (r.kept || await fs.promises.access(r.file).then(() => true, () => false)) ? r.file : null, () => null)
  const file = copyFile(abs, st, THUMB, 'webp')
  if (await fs.promises.access(file).then(() => true, () => false)) return file
  if (working || line.length) {
    if (!behind.has(file)) { behind.add(file); setTimeout(() => make().finally(() => behind.delete(file)), BEHIND_MS).unref?.() }
    return null
  }
  let t
  const late = new Promise(r => { t = setTimeout(() => r(null), waitMs) })
  try { return await Promise.race([make(), late]) } finally { clearTimeout(t) }
}

// ---------------------------------------------------------------- a PDF's first page
let worker = null, idle = null, seq = 0
const asked = new Map()
function pageWorker() {
  if (worker) return worker
  const w = worker = new Worker(new URL('./pdfPageWorker.js', import.meta.url))
  w.on('message', ({ id, png, error }) => { const a = asked.get(id); asked.delete(id); error ? a?.no(new Error(error)) : a?.ok(Buffer.from(png)) })
  const gone = (e) => {
    if (worker === w) worker = null
    for (const [id, a] of asked) if (a.w === w) { asked.delete(id); a.no(e instanceof Error ? e : new Error('the PDF drawer stopped')) }
  }
  w.on('error', gone); w.on('exit', gone)
  w.unref()   // (after its listeners: they would hold the program open)
  return w
}
/** The first page of a PDF as a PNG (twice its size), drawn off the main thread. */
export function pdfFirstPagePng(abs) {
  clearTimeout(idle)
  return new Promise((ok, no) => {
    const w = pageWorker(), id = ++seq
    asked.set(id, { ok, no, w })
    w.ref()
    w.postMessage({ id, abs })
  }).finally(() => {
    if (!asked.size) worker?.unref()
    clearTimeout(idle)
    idle = setTimeout(() => { if (!asked.size) { worker?.terminate(); worker = null } }, 60000)
    idle.unref?.()
  })
}
