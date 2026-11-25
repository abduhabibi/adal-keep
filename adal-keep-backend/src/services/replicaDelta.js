/**
 * replicaDelta.js — a Companion's locked copy takes what changed, not whole pieces (2026-11-25: a main
 * PC on a Wi-Fi stick gave each Companion 0.9–2.8 MB about every minute, and its list of 2,466
 * documents each time).
 *
 *   frames   a 1 MB database chunk is compressed in 16 KB frames, one after the other, with their
 *            lengths in a skippable frame at the end: any zstd reader still reads the whole chunk (the
 *            restore is as before), and a Companion swaps the changed frames without unpacking any.
 *   delta    the frames that differ from the piece the Companion holds (its fingerprint, `base`)
 *   docs     the documents that changed since the list it has (a watch on the folder, not a listing)
 *   idle     a new snapshot of the database only when something a person or a robot made changed
 *
 * Off: ADAL_REPLICA_DELTA=0 (whole pieces and lists, as before).
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import crypto from 'crypto'

export const deltaOn = () => process.env.ADAL_REPLICA_DELTA !== '0'
export const FRAME = 16 * 1024
const ZL = zlib.constants, MAGIC = 0x184D2A50, MARK = Buffer.from('ADALFR1\0')
const zc = (b) => new Promise((ok, no) => zlib.zstdCompress(b, { params: { [ZL.ZSTD_c_compressionLevel]: 6 } }, (e, r) => e ? no(e) : ok(r)))

export async function framesOf(buf) {
  const out = []
  for (let i = 0; i < buf.length; i += FRAME) out.push(await zc(buf.subarray(i, i + FRAME)))
  return out
}
export function joinFrames(frames) {
  const t = Buffer.alloc(8 + MARK.length + frames.length * 4)
  t.writeUInt32LE(MAGIC, 0); t.writeUInt32LE(t.length - 8, 4); MARK.copy(t, 8)
  frames.forEach((f, i) => t.writeUInt32LE(f.length, 8 + MARK.length + i * 4))
  return Buffer.concat([...frames, t])
}
/** The changed frames: "ADALSUB1" | json length u32 | { n, sha256 (the whole new piece), set: [[index, length]…] } | frames. */
export function subPiece(frames, changed) {
  const set = changed.filter(i => i < frames.length)
  const head = Buffer.from(JSON.stringify({ n: frames.length, sha256: crypto.createHash('sha256').update(joinFrames(frames)).digest('hex'), set: set.map(i => [i, frames[i].length]) }))
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length)
  return Buffer.concat([Buffer.from('ADALSUB1'), len, head, ...set.map(i => frames[i])])
}

/** The page fingerprints of the chunks handed out lately: which frames differ between two versions. */
export class Versions {
  constructor({ keep = 8, file = null } = {}) { this.keep = keep; this.file = file; this.map = new Map(); this.savedAt = 0; if (file) this.load() }
  add(i, sum, fp) {
    const k = `${i}`, list = this.map.get(k) || new Map()
    if (!list.has(sum)) { list.set(sum, Buffer.from(fp)); while (list.size > this.keep) list.delete(list.keys().next().value) }
    else { const v = list.get(sum); list.delete(sum); list.set(sum, v) }
    this.map.set(k, list)
  }
  /** The frames of chunk i that differ, or null (the other version is not known any more). */
  changed(i, from, to, pagesPerFrame) {
    const l = this.map.get(`${i}`), a = l?.get(from), b = l?.get(to)
    if (!a || !b) return null
    const out = new Set(), n = Math.max(a.length, b.length) / 8
    for (let p = 0; p < n; p++) if (!a.subarray(p * 8, p * 8 + 8).equals(b.subarray(p * 8, p * 8 + 8))) out.add(Math.floor(p / pagesPerFrame))
    return [...out]
  }
  // (Kept over a restart of the server, else every Companion takes its changed pieces whole after each.)
  load() { try { for (const [i, l] of Object.entries(JSON.parse(zlib.gunzipSync(fs.readFileSync(this.file)).toString()))) this.map.set(i, new Map(Object.entries(l).map(([s, f]) => [s, Buffer.from(f, 'base64')]))) } catch {} }
  async save(every = 10 * 60000) {
    if (!this.file || Date.now() - this.savedAt < every) return
    this.savedAt = Date.now()
    try {
      const o = {}
      for (const [i, l] of this.map) o[i] = Object.fromEntries([...l].slice(-3).map(([s, f]) => [s, f.toString('base64')]))
      const b = await new Promise((ok, no) => zlib.gzip(JSON.stringify(o), (e, r) => e ? no(e) : ok(r)))
      await fs.promises.writeFile(this.file + '.tmp', b); await fs.promises.rename(this.file + '.tmp', this.file)
    } catch {}
  }
}

/** The documents of a folder and what changed since a revision. The folder is listed once; then its own change notices. */
export class DocsFeed {
  constructor(dir, entry, { listEvery = 30 * 60000, now = Date.now } = {}) {
    Object.assign(this, { dir, entry, listEvery, now })
    this.epoch = crypto.randomBytes(5).toString('hex')
    this.map = new Map(); this.rev = 0; this.log = []; this.listedAt = 0; this.dirty = new Set(); this.watcher = null; this.waiting = new Set()
  }
  watch() {
    if (this.watcher || process.env.ADAL_DOCS_WATCH === '0') return
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_e, name) => { if (name) this.dirty.add(String(name)); else this.listedAt = 0; this.poke() })
      this.watcher.on('error', () => { this.watcher = null; this.listedAt = 0 })
    } catch { this.watcher = null }
  }
  poke() { clearTimeout(this.t); this.t = setTimeout(() => { this.refresh(); for (const w of [...this.waiting]) w() }, 1500); this.t.unref?.() }
  one(name) {
    let e = null
    try { const st = fs.statSync(path.join(this.dir, name)); if (st.isFile()) e = this.entry(name, st) } catch {}
    const was = this.map.get(name)
    if (e ? was?.sum === e.sum : !was) return
    if (e) this.map.set(name, e); else this.map.delete(name)
    this.log.push({ rev: ++this.rev, name })
    if (this.log.length > 4000) this.log.splice(0, 2000)
  }
  refresh() {
    this.watch()
    const first = !this.listedAt
    if (first || !this.watcher || this.now() - this.listedAt > this.listEvery) {
      this.listedAt = this.now(); this.dirty.clear()
      let names = []
      try { names = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name) } catch {}
      const here = new Set(names)
      for (const n of names) this.one(n)
      for (const n of [...this.map.keys()]) if (!here.has(n)) this.one(n)
    } else if (this.dirty.size) { const d = [...this.dirty]; this.dirty.clear(); for (const n of d) this.one(n) }
    return this
  }
  get at() { return `${this.epoch}:${this.rev}` }
  all() { return [...this.map.values()] }
  /** What changed since `at`: { set, gone }, or null (unknown: the whole list). */
  since(at) {
    const [e, r] = String(at || '').split(':')
    const rev = Number(r)
    if (e !== this.epoch || !Number.isInteger(rev) || rev > this.rev) return null
    if (this.log.length && rev < this.log[0].rev - 1) return null
    const names = new Set(this.log.filter(x => x.rev > rev).map(x => x.name))
    return { set: [...names].map(n => this.map.get(n)).filter(Boolean), gone: [...names].filter(n => !this.map.has(n)) }
  }
  stop() { clearTimeout(this.t); try { this.watcher?.close() } catch {} this.watcher = null }
}
