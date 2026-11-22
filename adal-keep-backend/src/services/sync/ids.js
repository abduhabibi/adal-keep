/**
 * ids.js — new rows get ids that can never collide between the agency's PCs.
 *
 * Every PC of the agency is the same Adal Keep with its own database, and new
 * profiles, files, CVs … are made on any of them, often with the others off.
 * SQLite's own numbering (the biggest id + 1) would give two PCs the same id.
 * So every new row's id is
 *
 *     id = milliseconds now × 1000 + this PC's slot (0–999)
 *
 * (bigger than the one before on this PC, always). The slot is this PC's own,
 * handed out by the main PC when it joined (sync_pcs), so the last three
 * digits say which PC made the row and no two PCs ever make the same id.
 * The ids still grow with time, so "newest first" (ORDER BY id DESC) keeps
 * working across PCs, and they stay integers below 2^53 (JavaScript numbers,
 * SQLite INTEGER, Postgres bigint) until the year 2255. Rows made before
 * (1, 2, 3 …) keep their ids.
 *
 * It is done where knex turns an insert into SQL (SyncClient below), for the
 * tables that are copied between PCs (tables.js). An insert that names its
 * own id keeps it (a restore from the Trash).
 */
import Client_SQLite3 from 'knex/lib/dialects/sqlite3/index.js'
import QueryCompiler_SQLite3 from 'knex/lib/dialects/sqlite3/query/sqlite-querycompiler.js'
import { readIdentity } from './identity.js'
import { ID_TABLES } from './tables.js'

export const SLOTS = 1000
// Ids made this way are all above this (1e15 ms is 33658 AD: any id this
// big came from a clock, not from SQLite's counting).
export const TIME_ID_MIN = 1e15

let slot = null
const last = new Map()      // "slot:table" → the last id made there (one map: two knex of one PC share it)
const tables = new Set(ID_TABLES)

/** This PC's slot (from its identity; 0 until it has one). */
export function currentSlot() {
  if (slot == null) { try { slot = readIdentity().slot } catch { slot = 0 } }
  return slot
}
export function setSlot(s) {
  if (!Number.isInteger(s) || s < 0 || s >= SLOTS) throw new Error(`Bad PC slot ${s}`)
  slot = s
}
/** The ids of these tables are made here (the copied tables, found at start). */
export function useTables(list) { for (const t of list) tables.add(t) }
export const madeHere = (t) => tables.has(t)
/** The newest id this PC already has in that table (from its database, at start). */
export function primeIds(table, maxOwn, s = currentSlot()) {
  const k = `${s}:${table}`
  if (Number(maxOwn) > (last.get(k) || 0)) last.set(k, Number(maxOwn))
}
export const slotOf = (id) => (Number(id) >= TIME_ID_MIN ? Number(id) % SLOTS : null)

export function nextId(table, s = currentSlot(), now = Date.now()) {
  const k = `${s}:${table}`
  const prev = last.get(k) || 0
  let id = Math.floor(now) * SLOTS + s
  if (id <= prev) id = prev + SLOTS   // (prev is one of this slot's: primeIds takes only those)
  if (!Number.isSafeInteger(id)) throw new Error('Row id beyond 2^53')
  last.set(k, id)
  return id
}

// ── Where knex makes the SQL ────────────────────────────────────────────────

const given = new WeakMap()   // builder → its rows with their ids (compiled twice → the same ids)
const plain = (r) => r && typeof r === 'object' && !Array.isArray(r) && !Buffer.isBuffer(r)
  && typeof r.toSQL !== 'function' && !r.isRawInstance && Object.getPrototypeOf(r) === Object.prototype

class SyncQueryCompiler extends QueryCompiler_SQLite3 {
  insert() {
    const table = this.single.table
    const v = this.single.insert
    if (typeof table === 'string' && tables.has(table) && v && typeof v === 'object') {
      let rows = given.get(this.builder)
      if (!rows) {
        const list = Array.isArray(v) ? v : [v]
        if (list.length && list.every(plain) && list.some(r => r.id == null)) {
          // (A test runs several PCs in one process: each knex says its slot.)
          const s = Number.isInteger(this.client.config.syncSlot) ? this.client.config.syncSlot : currentSlot()
          rows = list.map(r => (r.id == null ? { ...r, id: nextId(table, s) } : r))
          given.set(this.builder, rows)
        }
      }
      if (rows) {
        const keep = this.single.insert
        this.single.insert = Array.isArray(v) ? rows : rows[0]
        try { return super.insert() } finally { this.single.insert = keep }
      }
    }
    return super.insert()
  }
}
/** knex's SQLite client with the ids above. knexfile.js uses it. */
export class SyncClient extends Client_SQLite3 {
  queryCompiler(builder, formatter) {
    return new SyncQueryCompiler(this, builder, formatter)
  }
}
