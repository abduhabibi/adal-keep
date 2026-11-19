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
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

export const okName = (n) => typeof n === 'string' && n.length > 0 && n.length < 250 && n === path.basename(n)
  && !n.startsWith('.') && !/[\0\\/]/.test(n) && !/\.sync-tmp-/.test(n)
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

export class DocStore {
  constructor(db, dir, { log = console, now = () => Date.now() } = {}) {
    this.db = db
    this.dir = dir
    this.log = log
    this.now = now
    this.listCache = null
  }
  pathOf(name) { if (!okName(name)) throw Object.assign(new Error('No such document'), { status: 404 }); return path.join(this.dir, name) }

  /** Fingerprint new and changed documents (a few seconds at a time); forget the gone ones. */
  async index({ budgetMs = 4000 } = {}) {
    fs.mkdirSync(this.dir, { recursive: true })
    const start = this.now()
    let names = []
    try { names = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isFile() && okName(d.name)).map(d => d.name) } catch {}
    const known = new Map((await this.db.raw(`SELECT name, size, mtime, hash FROM sync_docs`)).map(r => [r.name, r]))
    let added = 0, left = 0
    const here = new Set(names)
    for (const name of names) {
      let st
      try { st = fs.statSync(path.join(this.dir, name)) } catch { continue }
      const k = known.get(name)
      if (k && Number(k.size) === st.size && Number(k.mtime) === Math.round(st.mtimeMs) && k.hash) continue
      if (this.now() - start > budgetMs) { left++; continue }
      try {
        const hash = await hashFile(path.join(this.dir, name))
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
    return r[0] && fs.existsSync(path.join(this.dir, r[0].name)) ? r[0].name : null
  }
  has(name) { return okName(name) && fs.existsSync(path.join(this.dir, name)) }

  /**
   * Keep a document that came from another PC (or the online copy): checked,
   * never over one that is here. 'kept' | 'same' | 'conflict'.
   */
  async put(name, buf, hash) {
    if (!okName(name)) throw new Error(`Bad document name: ${name}`)
    const got = sha256(buf)
    if (hash && got !== hash) throw new Error(`${name}: damaged on the way (its fingerprint does not match)`)
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = path.join(this.dir, `.sync-tmp-${crypto.randomBytes(6).toString('hex')}`)
    fs.writeFileSync(tmp, buf)
    try {
      const r = await this.linkIn(tmp, name, got)
      if (r !== 'same') await this.note(r === 'kept' ? name : r, buf.length, got)
      return r === 'kept' || r === 'same' ? r : 'conflict'
    } finally { fs.rmSync(tmp, { force: true }) }
  }

  async linkIn(tmp, name, hash) {
    const dest = path.join(this.dir, name)
    if (await place(tmp, dest)) return 'kept'
    // The name is taken: the same content → nothing to do; another → beside it.
    if (await hashFile(dest) === hash) return 'same'
    const ext = path.extname(name)
    const other = `${name.slice(0, name.length - ext.length)}.sync-${hash.slice(0, 12)}${ext}`
    if (!fs.existsSync(path.join(this.dir, other))) await place(tmp, path.join(this.dir, other))
    try {
      await this.db.raw(`INSERT INTO sync_conflicts (at, tbl, rid, other, kind, data) VALUES (?, 'document', ?, ?, 'document', ?)`,
        [new Date(this.now()).toISOString(), name, other, JSON.stringify({ kept: name, theirs: other, hash })])
    } catch {}
    this.log.warn?.(`[sync] ${name}: another PC has a different document under the same name — kept as ${other}`)
    return other
  }

  async note(name, size, hash) {
    let st = null
    try { st = fs.statSync(path.join(this.dir, name)) } catch {}
    await this.db.raw(`INSERT INTO sync_docs (name, size, mtime, hash) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, hash = excluded.hash`,
      [name, size, st ? Math.round(st.mtimeMs) : 0, hash])
    this.listCache = null
  }

  /** The same content is here under another name: a copy, no download. */
  async copyLocal(from, name, hash) {
    const tmp = path.join(this.dir, `.sync-tmp-${crypto.randomBytes(6).toString('hex')}`)
    fs.copyFileSync(path.join(this.dir, from), tmp)
    try {
      const r = await this.linkIn(tmp, name, hash)
      if (r !== 'same') await this.note(r === 'kept' ? name : r, fs.statSync(path.join(this.dir, r === 'kept' ? name : r)).size, hash)
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
    const beside = new Set(fs.existsSync(this.dir) ? fs.readdirSync(this.dir).filter(n => /\.sync-[0-9a-f]{12}/.test(n)) : [])
    for (const d of theirs) {
      if (!okName(d?.name) || !/^[0-9a-f]{64}$/.test(String(d.hash || ''))) continue
      if (this.has(d.name)) {
        // The same name with another content: theirs is kept beside (once).
        const h = mine.get(d.name)
        const ext = path.extname(d.name)
        if (!h || h === d.hash || beside.has(`${d.name.slice(0, d.name.length - ext.length)}.sync-${d.hash.slice(0, 12)}${ext}`)) continue
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
