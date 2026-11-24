/**
 * engine.js — the agency's PCs keep one set of data between them, each with
 * its own full copy, each working on its own copy at once (no waiting for
 * another PC), all ending up the same.
 *
 * How a change travels
 *   1. A person (or a robot) changes a row on a PC. SQLite triggers on every
 *      copied table note which row and which fields changed, and when
 *      (sync_dirty). Nothing in Adal Keep's own code has to call anything.
 *   2. stamp() turns those notes into this PC's change log (sync_log): one
 *      entry per field — table, row id, field, the new value, a stamp from the
 *      hybrid clock (hlc.js) — numbered 1, 2, 3 … for this PC (origin, seq).
 *      A new row is all its fields plus "_alive = 1"; a deleted row is
 *      "_alive = 0" (a tombstone, kept).
 *   3. PCs swap entries (transport.js): "I have up to seq N of PC A, up to M of
 *      PC B …" (the vector) → the other sends what is after that, for every
 *      PC it knows of, its own and the ones it got from others. So a change
 *      reaches every PC by any path: straight, through a third PC, or through
 *      the online copy, days later.
 *   4. apply() keeps every entry it did not have (idempotent: an entry is its
 *      origin + seq) and, field by field, the newest stamp wins (sync_clock
 *      holds the winning stamp of every field). Two PCs changing different
 *      fields of the same girl both keep their change; the same field → the
 *      later one, the same on every PC.
 *
 * Two rows that must be one (the same passport made on two PCs, the same
 * setting …: a UNIQUE index) are merged, never refused and never lost: the
 * PC that finds it writes a "_merge" entry (so every PC merges the same two,
 * even one where the clash never shows), the smaller id stays, the fields go
 * together (newest non-empty value of each), what pointed at the other row
 * (her fields, files, CVs …) points at the one that stays, and the row that
 * went is kept in sync_conflicts.
 *
 * An entry that cannot go in yet (its row is not complete: an update came
 * before its insert; a field this PC's version does not have yet) waits in
 * sync_pending and goes in once it can — from the log, which holds it.
 *
 * The engine uses its own plain knex (no reading-side decryption: passwords
 * go between PCs as they are stored, locked with the agency's vault key).
 */
import { Clock } from './hlc.js'
import { LOCAL, SHARED_SYNC_TABLES, POINTERS, isInternal } from './tables.js'
import * as ids from './ids.js'

const NAME = /^\w+$/
const q = (n) => { if (!NAME.test(String(n))) throw new Error(`Bad name: ${n}`); return `"${n}"` }
const NOW_MS = `CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`
const BATCH = 2000
const MAX_BYTES = 8 * 1024 * 1024

/** A value as it travels (JSON text; null stays SQL NULL; a BLOB as base64). */
export const enc = (v) => (v == null ? null : Buffer.isBuffer(v) ? JSON.stringify({ $b: v.toString('base64') }) : JSON.stringify(v))
export function dec(s) {
  if (s == null) return null
  const v = JSON.parse(s)
  return v && typeof v === 'object' && typeof v.$b === 'string' ? Buffer.from(v.$b, 'base64') : v
}
const num = (s) => /^-?\d+$/.test(String(s))
/** Of two row ids, the one that stays when they merge (the older: the smaller). */
export function smaller(a, b) {
  a = String(a); b = String(b)
  if (num(a) && num(b)) return BigInt(a) <= BigInt(b) ? a : b
  return a <= b ? a : b
}
const better = (x, y) => {   // in a merged row: a value beats an empty one, then the newer stamp
  const xn = x.val != null && x.val !== '', yn = y.val != null && y.val !== ''
  if (xn !== yn) return xn
  return x.hlc > y.hlc
}
const isUnique = (e) => /UNIQUE constraint failed/i.test(e?.message || '')
const isNotNull = (e) => /NOT NULL constraint failed/i.test(e?.message || '')
const isNoColumn = (e) => /no such column|has no column/i.test(e?.message || '')

/** Unique indexes made of an expression: how to find the row that clashes. */
const EXPR_KEYS = {
  profiles_one_passport_unique: {
    cols: ['passport_number'],
    where: `UPPER(TRIM("passport_number")) = UPPER(TRIM(?)) AND TRIM("passport_number") <> ''`,
    args: (v) => [v.passport_number],
    applies: (v) => String(v.passport_number ?? '').trim() !== '',
  },
}

export class SyncEngine {
  /**
   * db: a plain knex for this PC's database (no postProcessResponse).
   * pcId: this PC (identity.js). slot: its id slot.
   */
  constructor(db, { pcId, slot = 0, now = () => Date.now(), log = console } = {}) {
    if (!/^[\w-]+$/.test(String(pcId || ''))) throw new Error('A PC id is needed')
    this.db = db
    this.pcId = String(pcId)
    this.slot = slot
    this.now = now
    this.log = log
    this.tables = new Map()   // name → { pk, pkInt, cols: [...], uniques: [...] }
    this.listeners = new Set()
    this.queue = Promise.resolve()
    this.ready = false
  }

  /** Every change of the database goes one after the other (one SQLite writer anyway). */
  serial(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }
  async tx(fn) {
    return this.serial(() => this.db.transaction(async (trx) => fn(trx)))
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  emit(what) { for (const fn of this.listeners) { try { fn(what) } catch {} } }

  // ── Setting up ────────────────────────────────────────────────────────────

  async init({ adopt = true } = {}) {
    const db = this.db
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v TEXT)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_ctl (one INTEGER PRIMARY KEY CHECK (one = 1), applying INTEGER NOT NULL DEFAULT 0)`)
    await db.raw(`INSERT OR IGNORE INTO sync_ctl (one, applying) VALUES (1, 0)`)
    await db.raw(`UPDATE sync_ctl SET applying = 0`)   // (a crash in the middle of an apply)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_dirty (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, rid TEXT NOT NULL, col TEXT NOT NULL, at INTEGER NOT NULL)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_log (origin TEXT NOT NULL, seq INTEGER NOT NULL, tbl TEXT NOT NULL, rid TEXT NOT NULL, col TEXT NOT NULL, val TEXT, hlc TEXT NOT NULL, PRIMARY KEY (origin, seq)) WITHOUT ROWID`)
    await db.raw(`CREATE INDEX IF NOT EXISTS sync_log_field ON sync_log (tbl, rid, col, hlc)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_clock (tbl TEXT NOT NULL, rid TEXT NOT NULL, col TEXT NOT NULL, hlc TEXT NOT NULL, PRIMARY KEY (tbl, rid, col)) WITHOUT ROWID`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_vector (origin TEXT PRIMARY KEY, seq INTEGER NOT NULL)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_pending (tbl TEXT NOT NULL, rid TEXT NOT NULL, why TEXT, at INTEGER, PRIMARY KEY (tbl, rid)) WITHOUT ROWID`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_alias (tbl TEXT NOT NULL, rid TEXT NOT NULL, root TEXT NOT NULL, PRIMARY KEY (tbl, rid)) WITHOUT ROWID`)
    await db.raw(`CREATE INDEX IF NOT EXISTS sync_alias_root ON sync_alias (tbl, root)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, tbl TEXT, rid TEXT, other TEXT, kind TEXT, data TEXT)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_peers (pc_id TEXT PRIMARY KEY, url TEXT, last_ok INTEGER, last_try INTEGER, last_error TEXT, via TEXT)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_docs (name TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, hash TEXT) WITHOUT ROWID`)
    await db.raw(`CREATE INDEX IF NOT EXISTS sync_docs_hash ON sync_docs (hash)`)
    // Shared by every PC (copied like any table): the PCs, and who holds the main PC's role.
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_pcs (pc_id TEXT PRIMARY KEY, name TEXT, slot INTEGER, key_hash TEXT, access_id TEXT, joined_at TEXT, seen_at TEXT, suspended_at TEXT, revoked_at TEXT, lan TEXT, port INTEGER, vector TEXT, version TEXT)`)
    await db.raw(`CREATE TABLE IF NOT EXISTS sync_role (k TEXT PRIMARY KEY, holder TEXT, data TEXT, at TEXT)`)
    // Each PC's network cards (peers.js finds a PC by them when its address changed).
    if (!(await db.raw(`SELECT name FROM pragma_table_info('sync_pcs')`)).some(c => c.name === 'macs')) await db.raw(`ALTER TABLE sync_pcs ADD COLUMN macs TEXT`)

    let meta = await this.meta()
    if (meta.pc_id && meta.pc_id !== this.pcId) {
      if (!adopt) throw new Error(`This database belongs to PC ${meta.pc_id}`)
      await this.adopt(meta.pc_id)
      meta = await this.meta()
    }
    await this.setMeta(db, 'pc_id', this.pcId)
    this.clock = new Clock(this.pcId, meta.hlc || '', this.now)
    const mine = await db.raw(`SELECT MAX(seq) AS s FROM sync_log WHERE origin = ?`, [this.pcId])
    const v = await db.raw(`SELECT seq FROM sync_vector WHERE origin = ?`, [this.pcId])
    this.seq = Math.max(Number(meta.seq || 0), Number(mine[0]?.s || 0), Number(v[0]?.seq || 0))
    await this.refreshTables()
    await this.primeIds()
    this.ready = true
    await this.tx(async (trx) => { await this.stamp(trx); await this.retryPending(trx, 5000) })
    return this
  }

  /**
   * The database came from another PC (a Companion's first copy, or a backup
   * put on a new PC): its log, its vector and its merges stay (they are the
   * agency's), what was that PC's own goes.
   */
  async adopt(from) {
    const db = this.db
    this.log.info?.(`[sync] this database came from PC ${from}: taking it as PC ${this.pcId}`)
    await db.raw(`DELETE FROM sync_dirty`)   // that PC's changes not yet in its log: it sends them itself
    await db.raw(`DELETE FROM sync_peers`)
    await db.raw(`DELETE FROM sync_docs`)
    for (const t of ['ingest_queue', 'downloads_state', 'cloud_sync']) {
      try { await db.raw(`DELETE FROM ${q(t)}`) } catch {}
    }
    await db.raw(`DELETE FROM sync_meta WHERE k IN ('seq', 'relay_up', 'relay_docs')`)
    await this.setMeta(db, 'adopted_from', from)
  }

  async meta(db = this.db) {
    const rows = await db.raw(`SELECT k, v FROM sync_meta`)
    return Object.fromEntries(rows.map(r => [r.k, r.v]))
  }
  async setMeta(db, k, v) { await db.raw(`INSERT INTO sync_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, [k, v == null ? null : String(v)]) }

  /** Which tables are copied, their columns and keys; the triggers that watch them. */
  async refreshTables() {
    const db = this.db
    const all = await db.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    const meta = await this.meta()
    const seen = new Set()
    for (const { name } of all) {
      if (!NAME.test(name) || LOCAL.has(name) || (isInternal(name) && !SHARED_SYNC_TABLES.includes(name))) continue
      const cols = await db.raw(`SELECT name, type, pk, "notnull" AS nn, dflt_value AS dflt FROM pragma_table_info(?)`, [name])
      const pks = cols.filter(c => c.pk > 0)
      if (pks.length !== 1 || cols.some(c => !NAME.test(c.name))) continue   // (no one-column key: stays on this PC)
      const pk = pks[0].name
      const info = {
        name, pk,
        pkInt: /^INTEGER$/i.test(pks[0].type),
        cols: cols.map(c => c.name),
        colSet: new Set(cols.map(c => c.name)),
        uniques: await this.uniquesOf(name, pk),
      }
      this.tables.set(name, info)
      seen.add(name)
      const sig = JSON.stringify([pk, info.cols, 2])
      if (meta[`trig:${name}`] !== sig) {
        await this.makeTriggers(info)
        await this.setMeta(db, `trig:${name}`, sig)
      }
    }
    for (const name of [...this.tables.keys()]) if (!seen.has(name)) this.tables.delete(name)
    // Triggers of tables no longer copied (or gone).
    const trig = await db.raw(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync\\_%' ESCAPE '\\'`)
    for (const t of trig) if (!seen.has(t.tbl_name)) await db.raw(`DROP TRIGGER IF EXISTS ${q(t.name)}`)
    ids.useTables([...this.tables.values()].filter(t => t.pkInt && !isInternal(t.name)).map(t => t.name))
  }

  async uniquesOf(name, pk) {
    const out = []
    const list = await this.db.raw(`SELECT name, "unique" AS u, origin, partial FROM pragma_index_list(?)`, [name])
    for (const ix of list) {
      if (!ix.u || ix.origin === 'pk') continue
      if (EXPR_KEYS[ix.name]) { out.push({ name: ix.name, expr: EXPR_KEYS[ix.name] }); continue }
      const cols = await this.db.raw(`SELECT name FROM pragma_index_info(?)`, [ix.name])
      if (ix.partial || cols.some(c => !c.name)) { out.push({ name: ix.name, unknown: true }); continue }
      if (cols.length === 1 && cols[0].name === pk) continue
      out.push({ name: ix.name, cols: cols.map(c => c.name) })
    }
    return out
  }

  async makeTriggers(info) {
    const db = this.db, t = info.name, pk = q(info.pk)
    const W = `WHEN (SELECT applying FROM sync_ctl WHERE one = 1) = 0`
    for (const k of ['i', 'u', 'd']) await db.raw(`DROP TRIGGER IF EXISTS ${q(`sync_${k}_${t}`)}`)
    await db.raw(`CREATE TRIGGER ${q(`sync_i_${t}`)} AFTER INSERT ON ${q(t)} ${W} BEGIN
      INSERT INTO sync_dirty (tbl, rid, col, at) VALUES ('${t}', NEW.${pk}, '*', ${NOW_MS}); END`)
    await db.raw(`CREATE TRIGGER ${q(`sync_d_${t}`)} AFTER DELETE ON ${q(t)} ${W} BEGIN
      INSERT INTO sync_dirty (tbl, rid, col, at) VALUES ('${t}', OLD.${pk}, '-', ${NOW_MS}); END`)
    const changed = info.cols.filter(c => c !== info.pk)
      .map(c => `SELECT '${c}' AS c WHERE OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' UNION ALL ')
    await db.raw(`CREATE TRIGGER ${q(`sync_u_${t}`)} AFTER UPDATE ON ${q(t)} ${W} BEGIN
      INSERT INTO sync_dirty (tbl, rid, col, at) SELECT '${t}', OLD.${pk}, '-', ${NOW_MS} WHERE OLD.${pk} IS NOT NEW.${pk};
      INSERT INTO sync_dirty (tbl, rid, col, at) SELECT '${t}', NEW.${pk}, '*', ${NOW_MS} WHERE OLD.${pk} IS NOT NEW.${pk};
      ${changed ? `INSERT INTO sync_dirty (tbl, rid, col, at) SELECT '${t}', NEW.${pk}, c, ${NOW_MS} FROM (${changed}) WHERE OLD.${pk} IS NEW.${pk};` : ''}
    END`)
  }

  /** The newest id this PC made in each table, so the next is bigger (ids.js). */
  async primeIds() {
    const lo = ids.TIME_ID_MIN
    for (const t of this.tables.values()) {
      if (!t.pkInt || isInternal(t.name)) continue
      const r = await this.db.raw(`SELECT MAX(${q(t.pk)}) AS m FROM ${q(t.name)} WHERE ${q(t.pk)} >= ? AND ${q(t.pk)} % ? = ?`, [lo, ids.SLOTS, this.slot])
      ids.primeIds(t.name, r[0]?.m || 0, this.slot)
      const l = await this.db.raw(`SELECT MAX(CAST(rid AS INTEGER)) AS m FROM sync_log WHERE origin = ? AND tbl = ?`, [this.pcId, t.name])
      if (Number(l[0]?.m) >= lo && Number(l[0].m) % ids.SLOTS === this.slot) ids.primeIds(t.name, l[0].m, this.slot)
    }
  }

  // ── 2. This PC's changes into its log ─────────────────────────────────────

  async stampNow() { return this.tx((trx) => this.stamp(trx)) }

  async stamp(trx) {
    let total = 0
    for (;;) {
      const rows = await trx.raw(`SELECT seq, tbl, rid, col, at FROM sync_dirty ORDER BY seq LIMIT ?`, [BATCH])
      if (!rows.length) break
      const groups = new Map()
      for (const r of rows) {
        const k = `${r.tbl}\u0000${r.rid}`
        const g = groups.get(k) || { tbl: r.tbl, rid: String(r.rid), cols: new Set(), whole: false, at: 0 }
        if (r.col === '*' || r.col === '-') g.whole = true; else g.cols.add(r.col)
        g.at = Math.max(g.at, Number(r.at) || 0)
        groups.set(k, g)
      }
      const touched = new Set()
      for (const g of groups.values()) {
        const info = this.tables.get(g.tbl)
        if (!info) continue
        const row = (await trx.raw(`SELECT * FROM ${q(g.tbl)} WHERE ${q(info.pk)} = ?`, [g.rid]))[0]
        if (row) {
          const cols = g.whole ? info.cols.filter(c => c !== info.pk) : [...g.cols].filter(c => info.colSet.has(c))
          if (g.whole) await this.writeOwn(trx, g.tbl, g.rid, '_alive', 1, g.at)
          for (const c of cols) await this.writeOwn(trx, g.tbl, g.rid, c, row[c], g.at)
        } else {
          await this.writeOwn(trx, g.tbl, g.rid, '_alive', 0, g.at)
        }
        touched.add(g.tbl)
      }
      await trx.raw(`DELETE FROM sync_dirty WHERE seq <= ?`, [rows[rows.length - 1].seq])
      total += rows.length
      if (touched.size) this.emit({ stamped: [...touched] })
      if (rows.length < BATCH) break
    }
    if (total) await this.saveClock(trx)
    return total
  }

  async writeOwn(trx, tbl, rid, col, val, at) {
    const hlc = this.clock.tick(Math.max(Number(at) || 0, 0))
    const seq = ++this.seq
    const v = col === '_alive' ? JSON.stringify(val) : enc(val)
    await trx.raw(`INSERT INTO sync_log (origin, seq, tbl, rid, col, val, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)`, [this.pcId, seq, tbl, String(rid), col, v, hlc])
    if (tbl !== '_merge') await this.setClock(trx, tbl, rid, col, hlc)
    return { origin: this.pcId, seq, tbl, rid: String(rid), col, val: v, hlc }
  }

  async saveClock(trx) {
    await this.setMeta(trx, 'hlc', this.clock.last)
    await this.setMeta(trx, 'seq', this.seq)
    await trx.raw(`INSERT INTO sync_vector (origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = MAX(seq, excluded.seq)`, [this.pcId, this.seq])
  }

  async clockOf(trx, tbl, rid, col) {
    const r = await trx.raw(`SELECT hlc FROM sync_clock WHERE tbl = ? AND rid = ? AND col = ?`, [tbl, String(rid), col])
    return r[0]?.hlc || ''
  }
  async setClock(trx, tbl, rid, col, hlc) {
    await trx.raw(`INSERT INTO sync_clock (tbl, rid, col, hlc) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, rid, col) DO UPDATE SET hlc = excluded.hlc`, [tbl, String(rid), col, hlc])
  }

  // ── 3. What another PC does not have yet ──────────────────────────────────

  async vector(db = this.db) {
    const rows = await db.raw(`SELECT origin, seq FROM sync_vector`)
    return Object.fromEntries(rows.map(r => [r.origin, Number(r.seq)]))
  }

  /**
   * The entries after `their` vector, every PC's, oldest first per PC (at most
   * `limit`). complete[origin] = all of that PC's this PC has were sent.
   */
  async changesSince(their = {}, limit = BATCH) {
    await this.stampNow()
    return this.serial(async () => {
      const vec = await this.vector()
      const entries = [], complete = {}
      let left = Math.max(1, Math.min(Number(limit) || BATCH, 10000))
      // (and at most ~8 MB: a CV's saved data is 1–2 MB, and a request is 15 MB at most)
      let bytes = 0
      for (const origin of Object.keys(vec).sort()) {
        const from = Math.max(0, Number(their?.[origin]) || 0)
        const upto = vec[origin]
        if (upto <= from) continue
        if (left <= 0) break
        const rows = await this.db.raw(`SELECT origin, seq, tbl, rid, col, val, hlc FROM sync_log WHERE origin = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`, [origin, from, upto, left])
        let taken = 0
        for (const r of rows) {
          const size = 80 + (r.val ? r.val.length : 0)
          if (entries.length && bytes + size > MAX_BYTES) { left = 0; break }
          bytes += size
          entries.push({ ...r, seq: Number(r.seq) })
          taken++
        }
        if (left === 0) break
        left -= taken
        if (left > 0) complete[origin] = upto
      }
      return { entries, complete, vector: vec, more: left <= 0 }
    })
  }

  // ── 4. Entries from other PCs ──────────────────────────────────────────────

  /**
   * Takes entries (from any PC, in any order, as often as they come) and
   * `complete` (that PC had sent all it has of an origin up to there).
   */
  async apply(entries = [], complete = {}) {
    const touchedTables = new Set()
    const r = await this.tx(async (trx) => {
      await this.stamp(trx)   // this PC's own changes first: their stamps must be in before any compare
      await trx.raw(`UPDATE sync_ctl SET applying = 1`)
      try {
        const fresh = []
        const vec = await this.vector(trx)
        const top = {}
        for (const e of entries) {
          if (!valid(e)) continue
          const got = await trx.raw(`INSERT OR IGNORE INTO sync_log (origin, seq, tbl, rid, col, val, hlc) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`, [e.origin, e.seq, e.tbl, String(e.rid), e.col, e.val ?? null, e.hlc])
          top[e.origin] = Math.max(top[e.origin] || 0, Number(e.seq))
          if (!got.length) continue
          fresh.push(e)
          this.clock.recv(e.hlc)
        }
        for (const [o, s] of Object.entries(complete || {})) if (/^[\w-]+$/.test(o) && Number.isFinite(Number(s))) top[o] = Math.max(top[o] || 0, Number(s))
        for (const [o, s] of Object.entries(top)) {
          if (o === this.pcId) continue   // (this PC's own count is its own)
          if (s > (vec[o] || 0)) await trx.raw(`INSERT INTO sync_vector (origin, seq) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET seq = MAX(seq, excluded.seq)`, [o, s])
        }

        const rows = new Map()   // tbl\0rid → { tbl, rid, cols: Map, group }
        const mark = (tbl, rid, group = false) => {
          const k = `${tbl}\u0000${rid}`
          const m = rows.get(k) || { tbl, rid: String(rid), cols: new Map(), group: false }
          m.group = m.group || group
          rows.set(k, m)
          return m
        }
        const merges = []
        // Tables with merged rows (most have none: no lookups for them).
        this.grouped = new Set((await trx.raw(`SELECT DISTINCT tbl FROM sync_alias`)).map(r => r.tbl))
        for (const e of fresh) {
          if (e.tbl === '_merge') { merges.push(e); continue }
          const info = this.tables.get(e.tbl)
          if (!info) { await this.pend(trx, e.tbl, e.rid, 'table'); continue }
          if (this.grouped.has(e.tbl)) {
            const root = await this.rootOf(trx, e.tbl, e.rid)
            if (root !== String(e.rid) || await this.isGroupRoot(trx, e.tbl, e.rid)) { mark(e.tbl, root, true); continue }
          }
          // The field's stamp moves only for a newer one: then this entry wins.
          const won = await trx.raw(`INSERT INTO sync_clock (tbl, rid, col, hlc) VALUES (?, ?, ?, ?)
            ON CONFLICT(tbl, rid, col) DO UPDATE SET hlc = excluded.hlc WHERE excluded.hlc > sync_clock.hlc RETURNING hlc`, [e.tbl, String(e.rid), e.col, e.hlc])
          if (!won.length) continue
          mark(e.tbl, e.rid).cols.set(e.col, e.col === '_alive' ? JSON.parse(e.val) : dec(e.val))
        }
        for (const m of merges) {
          if (!this.tables.has(m.rid)) { await this.pend(trx, m.rid, `merge:${m.col}`, 'table'); continue }
          await this.union(trx, m.rid, m.col, dec(m.val))
          touchedTables.add(m.rid)
        }
        for (const m of rows.values()) {
          touchedTables.add(m.tbl)
          // (A merge in this same batch may have made it part of a group since it was marked.)
          const root = this.grouped.has(m.tbl) ? await this.rootOf(trx, m.tbl, m.rid) : m.rid
          if (m.group || root !== m.rid || (this.grouped.has(m.tbl) && await this.isGroupRoot(trx, m.tbl, m.rid))) await this.rebuildGroup(trx, m.tbl, root)
          else await this.materialize(trx, m)
        }
        await this.retryPending(trx, 200)
        await this.saveClock(trx)
        return { applied: fresh.length, received: entries.length }
      } finally {
        await trx.raw(`UPDATE sync_ctl SET applying = 0`)
      }
    })
    if (touchedTables.size) this.emit({ applied: [...touchedTables] })
    return r
  }

  async pend(trx, tbl, rid, why) {
    await trx.raw(`INSERT INTO sync_pending (tbl, rid, why, at) VALUES (?, ?, ?, ?) ON CONFLICT(tbl, rid) DO UPDATE SET why = excluded.why`, [tbl, String(rid), why, this.now()])
  }
  async unpend(trx, tbl, rid) { await trx.raw(`DELETE FROM sync_pending WHERE tbl = ? AND rid = ?`, [tbl, String(rid)]) }

  async retryPending(trx, limit = 200) {
    const rows = await trx.raw(`SELECT tbl, rid, why FROM sync_pending ORDER BY at LIMIT ?`, [limit])
    for (const p of rows) {
      const info = this.tables.get(p.tbl)
      if (!info) continue
      const root = await this.rootOf(trx, p.tbl, p.rid)
      if (root !== String(p.rid)) { await this.unpend(trx, p.tbl, p.rid); await this.rebuildGroup(trx, p.tbl, root); continue }
      if (await this.isGroupRoot(trx, p.tbl, p.rid)) await this.rebuildGroup(trx, p.tbl, p.rid)
      else await this.rebuildPlain(trx, p.tbl, p.rid)
    }
  }

  async exists(trx, info, rid) {
    return (await trx.raw(`SELECT 1 AS x FROM ${q(info.name)} WHERE ${q(info.pk)} = ?`, [String(rid)])).length > 0
  }

  /** Pointers (profile_id …) to a merged row point at the row that stayed. */
  async repointValues(trx, info, values) {
    for (const [c, target] of Object.entries(POINTERS)) {
      if (!info.colSet.has(c) || values[c] == null || !this.tables.has(target)) continue
      const root = await this.rootOf(trx, target, values[c])
      if (root !== String(values[c])) values[c] = num(root) ? Number(root) : root
    }
    return values
  }

  /** The new winning fields of one row go in. */
  async materialize(trx, m) {
    const info = this.tables.get(m.tbl)
    const alive = m.cols.has('_alive') ? m.cols.get('_alive') : undefined
    const here = await this.exists(trx, info, m.rid)
    if (alive === 0) {
      if (here) await trx.raw(`DELETE FROM ${q(info.name)} WHERE ${q(info.pk)} = ?`, [m.rid])
      await this.unpend(trx, m.tbl, m.rid)
      return
    }
    if (!here) return this.rebuildPlain(trx, m.tbl, m.rid)
    const set = {}
    let unknown = false
    for (const [c, v] of m.cols) {
      if (c === '_alive') continue
      if (!info.colSet.has(c) || c === info.pk) { unknown = true; continue }
      set[c] = v
    }
    if (unknown) await this.pend(trx, m.tbl, m.rid, 'column')
    if (!Object.keys(set).length) return
    await this.repointValues(trx, info, set)
    try {
      await this.update(trx, info, m.rid, set)
    } catch (e) {
      if (isUnique(e)) {
        const cur = (await trx.raw(`SELECT * FROM ${q(info.name)} WHERE ${q(info.pk)} = ?`, [m.rid]))[0]
        return this.clash(trx, info, m.rid, { ...cur, ...set })
      }
      if (isNoColumn(e)) return this.pend(trx, m.tbl, m.rid, 'column')
      throw e
    }
  }

  async update(trx, info, rid, set) {
    const cols = Object.keys(set)
    await trx.raw(`UPDATE ${q(info.name)} SET ${cols.map(c => `${q(c)} = ?`).join(', ')} WHERE ${q(info.pk)} = ?`, [...cols.map(c => set[c]), String(rid)])
  }
  async insert(trx, info, values) {
    const cols = Object.keys(values)
    await trx.raw(`INSERT INTO ${q(info.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => values[c]))
  }

  /** The winning entry of every field of one row, from the log. */
  async winners(trx, tbl, rids) {
    const list = rids.map(String)
    const rows = await trx.raw(`SELECT rid, col, val, hlc FROM sync_log WHERE tbl = ? AND rid IN (${list.map(() => '?').join(', ')})`, [tbl, ...list])
    return rows
  }

  /** One row (not merged) made again from the log: inserted, updated or deleted. */
  async rebuildPlain(trx, tbl, rid) {
    const info = this.tables.get(tbl)
    const best = new Map()
    for (const e of await this.winners(trx, tbl, [rid])) {
      const b = best.get(e.col)
      if (!b || e.hlc > b.hlc) best.set(e.col, e)
    }
    const aliveE = best.get('_alive')
    const here = await this.exists(trx, info, rid)
    const alive = aliveE ? JSON.parse(aliveE.val) : (here ? 1 : null)
    if (alive === 0) {
      if (here) await trx.raw(`DELETE FROM ${q(tbl)} WHERE ${q(info.pk)} = ?`, [String(rid)])
      return this.unpend(trx, tbl, rid)
    }
    if (alive == null) return this.pend(trx, tbl, rid, 'waiting for its row')
    const values = {}
    let unknown = false
    for (const [c, e] of best) {
      if (c === '_alive' || c === info.pk) continue
      if (!info.colSet.has(c)) { unknown = true; continue }
      values[c] = dec(e.val)
    }
    await this.repointValues(trx, info, values)
    try {
      if (here) { if (Object.keys(values).length) await this.update(trx, info, rid, values) }
      else await this.insert(trx, info, { [info.pk]: info.pkInt ? Number(rid) : String(rid), ...values })
    } catch (e) {
      if (isUnique(e)) {
        const cur = here ? (await trx.raw(`SELECT * FROM ${q(tbl)} WHERE ${q(info.pk)} = ?`, [String(rid)]))[0] : {}
        return this.clash(trx, info, rid, { ...cur, ...values })
      }
      if (isNotNull(e)) return this.pend(trx, tbl, rid, 'incomplete')
      if (isNoColumn(e)) return this.pend(trx, tbl, rid, 'column')
      throw e
    }
    if (unknown) return this.pend(trx, tbl, rid, 'column')
    await this.unpend(trx, tbl, rid)
  }

  // ── Merging two rows that must be one ─────────────────────────────────────

  async rootOf(trx, tbl, rid) {
    const r = await trx.raw(`SELECT root FROM sync_alias WHERE tbl = ? AND rid = ?`, [tbl, String(rid)])
    return r[0] ? String(r[0].root) : String(rid)
  }
  async isGroupRoot(trx, tbl, rid) {
    return (await trx.raw(`SELECT 1 AS x FROM sync_alias WHERE tbl = ? AND root = ? LIMIT 1`, [tbl, String(rid)])).length > 0
  }
  async members(trx, tbl, root) {
    const r = await trx.raw(`SELECT rid FROM sync_alias WHERE tbl = ? AND root = ?`, [tbl, String(root)])
    return [String(root), ...r.map(x => String(x.rid)).filter(x => x !== String(root))]
  }

  /** The row (other than rid) these values clash with on a UNIQUE index, if any. */
  async twinOf(trx, info, rid, values) {
    for (const u of info.uniques) {
      if (u.unknown) continue
      let rows
      if (u.expr) {
        if (!u.expr.applies(values)) continue
        rows = await trx.raw(`SELECT ${q(info.pk)} AS id FROM ${q(info.name)} WHERE ${u.expr.where} AND ${q(info.pk)} <> ? LIMIT 1`, [...u.expr.args(values), String(rid)])
      } else {
        if (u.cols.some(c => values[c] == null)) continue
        rows = await trx.raw(`SELECT ${q(info.pk)} AS id FROM ${q(info.name)} WHERE ${u.cols.map(c => `${q(c)} = ?`).join(' AND ')} AND ${q(info.pk)} <> ? LIMIT 1`, [...u.cols.map(c => values[c]), String(rid)])
      }
      if (rows[0]) return String(rows[0].id)
    }
    return null
  }

  /** These values of row rid clash with another row: the two become one, on every PC. */
  async clash(trx, info, rid, values, depth = 0) {
    const twin = await this.twinOf(trx, info, rid, values)
    if (!twin || depth > 6) {
      await this.pend(trx, info.name, rid, 'unique')
      await this.conflict(trx, info.name, rid, twin, 'unique-unsolved', values)
      return
    }
    const a = smaller(rid, twin), b = a === String(rid) ? twin : String(rid)
    await this.writeOwn(trx, '_merge', info.name, a, b, this.now())
    await this.union(trx, info.name, a, b, depth + 1)
  }

  async conflict(trx, tbl, rid, other, kind, data) {
    let text = null
    try { text = JSON.stringify(data, (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? `<${v.data.length} bytes>` : v)) } catch {}
    await trx.raw(`INSERT INTO sync_conflicts (at, tbl, rid, other, kind, data) VALUES (?, ?, ?, ?, ?, ?)`, [new Date(this.now()).toISOString(), tbl, String(rid), other == null ? null : String(other), kind, text])
  }

  /** a and b are the same row: their groups join; the smallest id of all stays. */
  async union(trx, tbl, a, b, depth = 0) {
    const ra = await this.rootOf(trx, tbl, a), rb = await this.rootOf(trx, tbl, b)
    if (ra === rb) return
    const root = smaller(ra, rb)
    const all = new Set([...(await this.members(trx, tbl, ra)), ...(await this.members(trx, tbl, rb))])
    for (const m of all) {
      if (m === root) continue
      await trx.raw(`INSERT INTO sync_alias (tbl, rid, root) VALUES (?, ?, ?) ON CONFLICT(tbl, rid) DO UPDATE SET root = excluded.root`, [tbl, m, root])
    }
    await trx.raw(`DELETE FROM sync_alias WHERE tbl = ? AND rid = ?`, [tbl, root])
    this.grouped?.add(tbl)
    await this.rebuildGroup(trx, tbl, root, depth)
  }

  /**
   * A merged row made again from everything known of its members: the newest
   * non-empty value of each field (a value already in the row counts, oldest),
   * alive or deleted by the newest stamp. The other members' rows go (kept in
   * sync_conflicts); what pointed at them points at the one that stays.
   */
  async rebuildGroup(trx, tbl, root, depth = 0) {
    const info = this.tables.get(tbl)
    if (!info) return
    const members = await this.members(trx, tbl, root)
    const others = members.filter(m => m !== root)
    const ph = (l) => l.map(() => '?').join(', ')
    const current = await trx.raw(`SELECT * FROM ${q(tbl)} WHERE ${q(info.pk)} IN (${ph(members)})`, members)
    current.sort((x, y) => (String(x[info.pk]) === root ? -1 : String(y[info.pk]) === root ? 1 : 0))
    const best = new Map()
    let aliveE = null
    for (const row of current) {
      for (const c of info.cols) {
        if (c === info.pk) continue
        const cand = { val: row[c], hlc: '' }
        const b = best.get(c)
        if (!b || better(cand, b)) best.set(c, cand)
      }
    }
    for (const e of await this.winners(trx, tbl, members)) {
      if (e.col === '_alive') { if (!aliveE || e.hlc > aliveE.hlc) aliveE = e; continue }
      const cand = { val: dec(e.val), hlc: e.hlc }
      const b = best.get(e.col)
      if (!b || better(cand, b)) best.set(e.col, cand)
    }
    const alive = aliveE ? JSON.parse(aliveE.val) : (current.length ? 1 : null)
    // The rows that went: kept as they were, then out.
    for (const row of current) {
      if (String(row[info.pk]) === root) continue
      await this.conflict(trx, tbl, row[info.pk], root, 'merged', row)
    }
    if (others.length) await trx.raw(`DELETE FROM ${q(tbl)} WHERE ${q(info.pk)} IN (${ph(others)})`, others)
    if (others.length) await this.repointChildren(trx, tbl, root, others, depth)
    if (alive === 0) {
      await trx.raw(`DELETE FROM ${q(tbl)} WHERE ${q(info.pk)} = ?`, [root])
      for (const m of members) await this.unpend(trx, tbl, m)
      return
    }
    if (alive == null) return this.pend(trx, tbl, root, 'waiting for its row')
    const values = {}
    for (const [c, b] of best) if (info.colSet.has(c) && c !== info.pk) values[c] = b.val
    await this.repointValues(trx, info, values)
    const here = current.some(r => String(r[info.pk]) === root)
    try {
      if (here) await this.update(trx, info, root, values)
      else await this.insert(trx, info, { [info.pk]: info.pkInt ? Number(root) : root, ...values })
    } catch (e) {
      if (isUnique(e)) return this.clash(trx, info, root, values, depth + 1)
      if (isNotNull(e)) return this.pend(trx, tbl, root, 'incomplete')
      throw e
    }
    for (const m of members) await this.unpend(trx, tbl, m)
  }

  /** Rows of other tables that pointed at a merged-away row point at the one that stayed. */
  async repointChildren(trx, tbl, root, others, depth) {
    const ph = others.map(() => '?').join(', ')
    for (const [c, target] of Object.entries(POINTERS)) {
      if (target !== tbl) continue
      for (const child of this.tables.values()) {
        if (!child.colSet.has(c)) continue
        const rootV = num(root) ? Number(root) : root
        await trx.raw(`UPDATE OR IGNORE ${q(child.name)} SET ${q(c)} = ? WHERE ${q(c)} IN (${ph})`, [rootV, ...others])
        // Those that could not (the merged row has one already: the same day, the same checklist …) merge too.
        const left = await trx.raw(`SELECT * FROM ${q(child.name)} WHERE ${q(c)} IN (${ph})`, others)
        for (const row of left) await this.clash(trx, child, row[child.pk], { ...row, [c]: rootV }, depth + 1)
      }
    }
  }

  // ── Upkeep ────────────────────────────────────────────────────────────────

  /**
   * Entries nobody can need any more: one with a newer entry for the same
   * field that wins both ways (newer, and not emptier). Merges and the
   * newest of every field stay for good.
   */
  async compact() {
    await this.stampNow()
    return this.serial(async () => {
      const before = (await this.db.raw(`SELECT COUNT(*) AS n FROM sync_log`))[0].n
      await this.db.raw(`DELETE FROM sync_log WHERE tbl <> '_merge' AND EXISTS (
        SELECT 1 FROM sync_log b WHERE b.tbl = sync_log.tbl AND b.rid = sync_log.rid AND b.col = sync_log.col
          AND b.hlc > sync_log.hlc AND (b.val IS NOT NULL OR sync_log.val IS NULL))`)
      const after = (await this.db.raw(`SELECT COUNT(*) AS n FROM sync_log`))[0].n
      return { before, after }
    })
  }

  async stats() {
    const one = async (sql) => Number((await this.db.raw(sql))[0]?.n || 0)
    return {
      pc_id: this.pcId,
      seq: this.seq,
      log: await one(`SELECT COUNT(*) AS n FROM sync_log`),
      dirty: await one(`SELECT COUNT(*) AS n FROM sync_dirty`),
      pending: await one(`SELECT COUNT(*) AS n FROM sync_pending`),
      merged: await one(`SELECT COUNT(*) AS n FROM sync_alias`),
      conflicts: await one(`SELECT COUNT(*) AS n FROM sync_conflicts`),
      vector: await this.vector(),
      tables: this.tables.size,
    }
  }
}

function valid(e) {
  return e && /^[\w-]+$/.test(String(e.origin || '')) && Number.isSafeInteger(Number(e.seq)) && Number(e.seq) > 0
    && NAME.test(String(e.tbl || '')) && e.rid != null && String(e.rid).length <= 200
    && (NAME.test(String(e.col || '')) || /^-?\d+$/.test(String(e.col || ''))) && /^\d{16}\.\d{4,}\.[\w-]+$/.test(String(e.hlc || ''))
    && (e.val == null || typeof e.val === 'string')
}
