/**
 * docs.js — the documents (data/SafeStorage) on every PC of the agency.
 *
 * Every document is known by its content (sha256, worked out once per file
 * and kept in sync_docs with its size and time). A PC fetches what another
 * has and it has not, smallest first:
 *   • the same content already here under another name → copied here, not
 *     fetched again (one download per content, whatever its names);
 *   • what comes is checked against its sha256 before it is kept;
 *   • a document is never overwritten: it is written beside the folder and
 *     linked in under its name only if that name is still free. Another
 *     content under a name this PC has already → kept as "<name>.sync-<hash>"
 *     and noted in sync_conflicts; this PC's own stays as it is.
 *
 * Two folders (2026-11-22): data/SafeStorage (flat: the name is the file's
 * name) and backend/uploads (what people upload in the app, in folders per
 * profile and field: the name is "uploads/<its path>", the same as the
 * files.path column).
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const okPart = (n) => typeof n === 'string' && n.length > 0 && n.length < 250 && n === path.basename(n)
  && !n.startsWith('.') && !/[\0\\/]/.test(n) && !/\.sync-tmp-/.test(n)
/** A document's name: a file of SafeStorage, or "uploads/a/b/c" (every part a plain name: no "..", no "/x"). */
export const okName = (n) => okPart(n) || (typeof n === 'string' && n.length < 400 && /^uploads\//.test(n) && n.split('/').length <= 8 && n.split('/').slice(1).every(okPart))
/** The document a column names (files.path "uploads/…", "data/SafeStorage/x.pdf", or just "x.pdf"), or null. */
export function docNameOf(v) {
  const s = String(v || '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (/^uploads\//.test(s)) return okName(s) ? s : null
  const b = s.replace(/^data\/SafeStorage\//, '')
  return okPart(b) ? b : null
}
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

export class DocStore {
  constructor(db, dir, { log = console, now = () => Date.now(), uploadsDir = null } = {}) {
    this.db = db
    this.dir = dir
    this.uploadsDir = uploadsDir
    this.log = log
    this.now = now
    this.listCache = null
  }
  pathOf(name) {
    if (!okName(name) || (name.startsWith('uploads/') && !this.uploadsDir)) throw Object.assign(new Error('No such document'), { status: 404 })
    return name.startsWith('uploads/') ? path.join(this.uploadsDir, ...name.split('/').slice(1)) : path.join(this.dir, name)
  }
  /** Changed rows that name documents: the uploads folder is looked through at the next index. */
  touch() { this.uploadsDirty = true }
  uploadNames() {
    const out = []
    const walk = (dir, rel, depth) => {
      let es = []
      try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of es) {
        if (!okPart(e.name)) continue
        if (e.isDirectory() && depth < 6) walk(path.join(dir, e.name), `${rel}/${e.name}`, depth + 1)
        else if (e.isFile()) out.push(`${rel}/${e.name}`)
      }
    }
    if (this.uploadsDir) walk(this.uploadsDir, 'uploads', 0)
    return out
  }

  /** Fingerprint new and changed documents (a few seconds at a time); forget the gone ones. */
  async index({ budgetMs = 4000, force = false } = {}) {
    // (Thousands of documents on a slow disk: looked through again only when the
    // folder changed — a document added or removed — or every 10 minutes.)
    fs.mkdirSync(this.dir, { recursive: true })
    let dirAt = 0
    try { dirAt = fs.statSync(this.dir).mtimeMs } catch {}
    if (!force && !this.uploadsDirty && this.left === 0 && dirAt === this.dirAt && Date.now() - (this.lastIndex || 0) < 10 * 60 * 1000) return { added: 0, gone: 0, left: 0 }
    this.lastIndex = Date.now()
    this.dirAt = dirAt
    this.uploadsDirty = false
    const start = this.now()
    let names = []
    try { names = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isFile() && okPart(d.name)).map(d => d.name) } catch {}
    names.push(...this.uploadNames())
    const known = new Map((await this.db.raw(`SELECT name, size, mtime, hash FROM sync_docs`)).map(r => [r.name, r]))
    let added = 0, left = 0
    const here = new Set(names)
    for (const name of names) {
      let st
      try { st = fs.statSync(this.pathOf(name)) } catch { continue }
      const k = known.get(name)
      if (k && Number(k.size) === st.size && Number(k.mtime) === Math.round(st.mtimeMs) && k.hash) continue
      if (this.now() - start > budgetMs) { left++; continue }
      try {
        const hash = await hashFile(this.pathOf(name))
        await this.db.raw(`INSERT INTO sync_docs (name, size, mtime, hash) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash`, [name, st.size, Math.round(st.mtimeMs), hash])
        added++
      } catch {}
    }
    const gone = [...known.keys()].filter(n => !here.has(n))
    for (let i = 0; i < gone.length; i += 400) {
      const part = gone.slice(i, i + 400)
      await this.db.raw(`DELETE FROM sync_docs WHERE name IN (${part.map(() => '?').join(', ')})`, part)
    }
    if (added || gone.length) this.listCache = null
    this.left = left
    return { added, gone: gone.length, left }
  }

  /** Every fingerprinted document: name, size, sha256 — and one hash of the whole list. */
  async list() {
    if (this.listCache) return this.listCache
    const docs = await this.db.raw(`SELECT name, size, hash FROM sync_docs WHERE hash IS NOT NULL ORDER BY name`)
    const h = crypto.createHash('sha1')
    for (const d of docs) h.update(`${d.name}\0${d.size}\0${d.hash}\n`)
    this.listCache = { hash: h.digest('hex'), docs: docs.map(d => ({ name: d.name, size: Number(d.size), hash: d.hash })) }
    return this.listCache
  }
  async byHash(hash) {
    const r = await this.db.raw(`SELECT name FROM sync_docs WHERE hash = ? LIMIT 1`, [hash])
    return r[0] && this.has(r[0].name) ? r[0].name : null
  }
  has(name) { try { return okName(name) && fs.existsSync(this.pathOf(name)) } catch { return false } }
  /** A file written beside the place it goes (the same folder: a hard link works). */
  tmpFor(name) { const p = this.pathOf(name); fs.mkdirSync(path.dirname(p), { recursive: true }); return path.join(path.dirname(p), `.sync-tmp-${crypto.randomBytes(6).toString('hex')}`) }
  besideOf(name, hash) { const ext = path.extname(name); return `${name.slice(0, name.length - ext.length)}.sync-${hash.slice(0, 12)}${ext}` }

  /**
   * Keep a document that came from another PC (or the online copy): checked,
   * never over one that is here. 'kept' | 'same' | 'conflict'.
   */
  async put(name, buf, hash) {
    if (!okName(name)) throw new Error(`Bad document name: ${name}`)
    const got = sha256(buf)
    if (hash && got !== hash) throw new Error(`${name}: damaged on the way (its fingerprint does not match)`)
    const tmp = this.tmpFor(name)
    fs.writeFileSync(tmp, buf)
    try {
      const r = await this.linkIn(tmp, name, got)
      if (r !== 'same') await this.note(r === 'kept' ? name : r, buf.length, got)
      return r === 'kept' || r === 'same' ? r : 'conflict'
    } finally { fs.rmSync(tmp, { force: true }) }
  }

  async linkIn(tmp, name, hash) {
    const dest = this.pathOf(name)
    if (await place(tmp, dest)) return 'kept'
    // The name is taken: the same content → nothing to do; another → beside it.
    if (await hashFile(dest) === hash) return 'same'
    const other = this.besideOf(name, hash)
    if (!fs.existsSync(this.pathOf(other))) await place(tmp, this.pathOf(other))
    try {
      await this.db.raw(`INSERT INTO sync_conflicts (at, tbl, rid, other, kind, data) VALUES (?, 'document', ?, ?, 'document', ?)`,
        [new Date(this.now()).toISOString(), name, other, JSON.stringify({ kept: name, theirs: other, hash })])
    } catch {}
    this.log.warn?.(`[sync] ${name}: another PC has a different document under the same name — kept as ${other}`)
    return other
  }

  async note(name, size, hash) {
    let st = null
    try { st = fs.statSync(this.pathOf(name)) } catch {}
    await this.db.raw(`INSERT INTO sync_docs (name, size, mtime, hash) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash`,
      [name, size, st ? Math.round(st.mtimeMs) : 0, hash])
    this.listCache = null
  }

  /** The same content is here under another name: a copy, no download. */
  async copyLocal(from, name, hash) {
    const tmp = this.tmpFor(name)
    fs.copyFileSync(this.pathOf(from), tmp)
    try {
      const r = await this.linkIn(tmp, name, hash)
      if (r !== 'same') await this.note(r === 'kept' ? name : r, fs.statSync(this.pathOf(r === 'kept' ? name : r)).size, hash)
      return r === 'kept' || r === 'same' ? r : 'conflict'
    } finally { fs.rmSync(tmp, { force: true }) }
  }

  /**
   * What another PC's list has that this PC has not: smallest first, the
   * ones with a copy here marked (no download needed).
   */
  async missing(theirs = []) {
    const out = []
    const mine = new Map((await this.db.raw(`SELECT name, hash FROM sync_docs`)).map(r => [r.name, r.hash]))
    for (const d of theirs) {
      if (!okName(d?.name) || !/^[0-9a-f]{64}$/.test(String(d.hash || ''))) continue
      if (d.name.startsWith('uploads/') && !this.uploadsDir) continue
      if (this.has(d.name)) {
        // The same name with another content: theirs is kept beside (once).
        const h = mine.get(d.name)
        if (!h || h === d.hash || this.has(this.besideOf(d.name, d.hash))) continue
      }
      out.push({ ...d, copyOf: await this.byHash(d.hash) })
    }
    return out.sort((a, b) => (a.copyOf ? 0 : 1) - (b.copyOf ? 0 : 1) || a.size - b.size)
  }
}

/** Put tmp in at dest only if dest does not exist (never over a document). */
async function place(tmp, dest) {
  try { fs.linkSync(tmp, dest); return true } catch (e) {
    if (e.code === 'EEXIST') return false
    // No hard links here (some USB / network drives): a copy that refuses to overwrite.
    try { fs.copyFileSync(tmp, dest, fs.constants.COPYFILE_EXCL); return true } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2 }
  }
}
