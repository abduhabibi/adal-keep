/**
 * relay.js — changes between PCs through the online copy, when there is no
 * office-network path between them (a PC at home, the main PC off, another
 * branch without Tailscale).
 *
 * Each PC puts its OWN log online, in pieces that never change once written:
 *     <agency>/sync/<pc id>/<from seq>-<to seq>.bin
 * and each document those entries name, once per content:
 *     <agency>/sync-docs/<sha256>
 * Every piece is locked with the agency's backup key before it leaves the PC
 * (AES-256-GCM): the online copy holds only locked bytes. A PC reads the other
 * PCs' pieces after what it has (its vector), in order, and fetches the
 * documents it lacks.
 *
 * Only what another PC of the agency has not had yet goes online (node.js
 * decides when): with all PCs on the office network nothing goes.
 */
import zlib from 'zlib'
import crypto from 'crypto'
import { DOC_COLUMNS } from './tables.js'
import { okName, docNameOf } from './docs.js'
import { dec } from './engine.js'

const MAGIC = Buffer.from('ADALSY1')
const keys = new Map()
function keyFor(secret, salt) {
  const k = `${secret}\0${salt.toString('hex')}`
  if (!keys.has(k)) keys.set(k, crypto.scryptSync(secret, salt, 32))
  return keys.get(k)
}
let mySalt = null
export function seal(buf, secret) {
  if (!secret) throw new Error('No agency key for the online copy')
  mySalt = mySalt || crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(secret, mySalt), iv)
  const ct = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([MAGIC, mySalt, iv, c.getAuthTag(), ct])
}
export function unseal(buf, secret) {
  if (!buf.subarray(0, 7).equals(MAGIC)) throw new Error('Not an Adal Keep sync piece')
  const salt = buf.subarray(7, 23), iv = buf.subarray(23, 35), tag = buf.subarray(35, 51)
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(secret, salt), iv)
  d.setAuthTag(tag)
  try { return Buffer.concat([d.update(buf.subarray(51)), d.final()]) } catch { throw new Error('A sync piece that does not open with this agency\'s key') }
}

const pad = (n) => String(n).padStart(12, '0')
const PIECE = /^(\d{12})-(\d{12})\.bin$/

/** An online store for tests: a folder (as if every PC reached the same online copy). */
export class DirStore {
  constructor(dir) { this.dir = dir }
  async put(p, buf) {
    const { default: fs } = await import('fs'), { default: path } = await import('path')
    const f = path.join(this.dir, p)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    if (fs.existsSync(f)) return false
    fs.writeFileSync(f, buf)
    return true
  }
  async get(p) {
    const { default: fs } = await import('fs'), { default: path } = await import('path')
    try { return fs.readFileSync(path.join(this.dir, p)) } catch { return null }
  }
  async list(prefix) {
    const { default: fs } = await import('fs'), { default: path } = await import('path')
    try { return fs.readdirSync(path.join(this.dir, prefix)) } catch { return [] }
  }
}

/**
 * The agency's online copy (Supabase Storage, bucket "keep", the agency's
 * folder — the same place the phones' copy uses). `token()` gives a signed-in
 * user's token: the agency's own on the main PC, the Companion's online
 * account on a Companion (it may add pieces, never change or remove one).
 */
export class SupabaseStore {
  constructor({ url, anon, agency, token, fetch: f = fetch }) {
    Object.assign(this, { url: String(url).replace(/\/+$/, ''), anon, agency, token, f })
  }
  async headers(extra = {}) { return { apikey: this.anon, Authorization: `Bearer ${await this.token()}`, ...extra } }
  async put(p, buf) {
    const r = await this.f(`${this.url}/storage/v1/object/keep/${this.agency}/${p}`, {
      method: 'POST', headers: await this.headers({ 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }), body: buf, signal: AbortSignal.timeout(120000),
    })
    if (r.ok) return true
    const t = await r.text().catch(() => '')
    if (r.status === 409 || /exists|Duplicate/i.test(t)) return false
    throw new Error(`online copy: ${r.status} ${t.slice(0, 120)}`)
  }
  async get(p) {
    const r = await this.f(`${this.url}/storage/v1/object/authenticated/keep/${this.agency}/${p}`, { headers: await this.headers(), signal: AbortSignal.timeout(120000) })
    if (r.status === 404 || r.status === 400) return null
    if (!r.ok) throw new Error(`online copy: ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  async list(prefix) {
    const out = []
    for (let offset = 0; ; offset += 1000) {
      const r = await this.f(`${this.url}/storage/v1/object/list/keep`, {
        method: 'POST', headers: await this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefix: `${this.agency}/${prefix.replace(/\/+$/, '')}/`, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
        signal: AbortSignal.timeout(60000),
      })
      if (!r.ok) throw new Error(`online copy: ${r.status}`)
      const page = await r.json()
      out.push(...page.map(o => o.name))
      if (page.length < 1000) return out
    }
  }
}

export class Relay {
  constructor(node, store, { secret, batch = 2000 } = {}) {
    this.node = node
    this.store = store
    this.secret = secret
    this.batch = batch
  }
  get engine() { return this.node.engine }

  /** This PC's entries not online yet go up (with the documents they name). */
  async upload() {
    const e = this.engine
    await e.stampNow()
    await this.node.docs.index({ budgetMs: 3000 })
    const meta = await e.meta()
    let from = Number(meta.relay_up || 0)
    let sent = 0, docs = 0
    const online = new Set(await this.store.list('sync-docs'))
    while (from < e.seq) {
      const to = Math.min(e.seq, from + this.batch)
      const entries = await e.db.raw(`SELECT origin, seq, tbl, rid, col, val, hlc FROM sync_log WHERE origin = ? AND seq > ? AND seq <= ? ORDER BY seq`, [e.pcId, from, to])
      const named = {}
      for (const x of entries) {
        if (!DOC_COLUMNS[x.tbl]?.includes(x.col) || x.val == null) continue
        const name = docNameOf(dec(x.val))
        if (!name || !this.node.docs.has(name)) continue
        const r = await e.db.raw(`SELECT hash FROM sync_docs WHERE name = ?`, [name])
        if (r[0]?.hash) named[name] = r[0].hash
      }
      for (const [name, hash] of Object.entries(named)) {
        if (online.has(hash)) continue
        const fs = (await import('fs')).default
        await this.store.put(`sync-docs/${hash}`, seal(fs.readFileSync(this.node.docs.pathOf(name)), this.secret))
        online.add(hash)
        docs++
      }
      const body = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, origin: e.pcId, from: from + 1, to, entries, docs: named })))
      await this.store.put(`sync/${e.pcId}/${pad(from + 1)}-${pad(to)}.bin`, seal(body, this.secret))
      await e.setMeta(e.db, 'relay_up', to)
      sent += entries.length
      from = to
    }
    return { sent, docs }
  }

  /** The other PCs' pieces after what this PC has, in order; then their documents. */
  async download() {
    const e = this.engine
    let got = 0, docs = 0
    const vec = await e.vector()
    for (const origin of await this.store.list('sync')) {
      if (origin === e.pcId || !/^[\w-]+$/.test(origin)) continue
      const pieces = (await this.store.list(`sync/${origin}`))
        .map(n => { const m = PIECE.exec(n); return m ? { name: n, from: Number(m[1]), to: Number(m[2]) } : null })
        .filter(Boolean).sort((a, b) => a.from - b.from)
      let have = vec[origin] || 0
      for (const p of pieces) {
        if (p.to <= have) continue
        if (p.from > have + 1) break   // a piece not there (yet): the rest waits
        const buf = await this.store.get(`sync/${origin}/${p.name}`)
        if (!buf) break
        const body = JSON.parse(zlib.gunzipSync(unseal(buf, this.secret)).toString())
        if (body.origin !== origin) throw new Error(`A piece of ${origin} that says it is ${body.origin}`)
        await e.apply(body.entries || [], { [origin]: p.to })
        got += (body.entries || []).length
        have = p.to
        for (const [name, hash] of Object.entries(body.docs || {})) {
          if (!okName(name) || this.node.docs.has(name) || (name.startsWith('uploads/') && !this.node.docs.uploadsDir)) continue
          const local = await this.node.docs.byHash(hash)
          if (local) { await this.node.docs.copyLocal(local, name, hash); continue }
          const d = await this.store.get(`sync-docs/${hash}`)
          if (!d) continue
          await this.node.docs.put(name, unseal(d, this.secret), hash)
          docs++
        }
      }
    }
    return { got, docs }
  }
}
