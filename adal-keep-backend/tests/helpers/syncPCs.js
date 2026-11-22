/**
 * Several Adal Keep PCs of one agency in one test: each its own database file
 * (and documents folder) in a scratch folder, its own slot and PC id. The
 * "app" knex is the one Adal Keep's code uses (ids.js's SyncClient); the
 * engine has its own plain one, as on a real PC.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import knex from 'knex'
import { SyncClient } from '../../src/services/sync/ids.js'
import { SyncEngine } from '../../src/services/sync/engine.js'

export const scratch = (tag = 'sync') => fs.mkdtempSync(path.join(os.tmpdir(), `adal-${tag}-`))

/** The tables, as Adal Keep has them (the parts that matter here). */
export async function makeSchema(db) {
  await db.schema.createTable('profiles', t => {
    t.increments('id').primary(); t.string('full_name'); t.string('passport_number'); t.string('phone_number')
    t.string('status'); t.string('notes'); t.string('photo_path'); t.string('created_at'); t.string('updated_at')
  })
  await db.raw(`CREATE UNIQUE INDEX profiles_one_passport_unique ON profiles (UPPER(TRIM(passport_number))) WHERE TRIM(passport_number) <> ''`)
  await db.schema.createTable('profile_fields', t => {
    t.increments('id').primary(); t.integer('profile_id'); t.integer('field_template_id'); t.string('name'); t.text('value_text')
  })
  await db.schema.createTable('files', t => {
    t.increments('id').primary(); t.integer('profile_field_id'); t.string('original_name'); t.string('path'); t.string('mimetype'); t.integer('size'); t.string('content_hash')
  })
  await db.schema.createTable('generated_cvs', t => {
    t.increments('id').primary(); t.integer('profile_id'); t.integer('template_id'); t.string('filename'); t.string('pdf_path'); t.string('created_at')
  })
  await db.schema.createTable('settings', t => { t.increments('id').primary(); t.string('key').notNullable().unique(); t.text('value') })
  await db.schema.createTable('profile_days', t => {
    t.increments('id').primary(); t.integer('profile_id').notNullable(); t.string('day', 10).notNullable(); t.text('data'); t.unique(['profile_id', 'day'])
  })
  await db.schema.createTable('ingest_queue', t => { t.increments('id').primary(); t.string('filename') })   // this PC's own
}

export async function makePC(name, { dir = scratch(name), slot, pcId, schema = true, now } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'data.sqlite')
  const pragmas = { afterCreate(conn, done) { conn.run('PRAGMA journal_mode = WAL;'); conn.run('PRAGMA synchronous = NORMAL;'); conn.run('PRAGMA busy_timeout = 8000;', () => done(null, conn)) } }
  const app = knex({ client: SyncClient, connection: { filename: file }, useNullAsDefault: true, syncSlot: slot, pool: pragmas })
  const db = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true, pool: pragmas })
  if (schema) await makeSchema(app)
  const engine = new SyncEngine(db, { pcId: pcId || `pc${name}`.toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12), slot, now, log: { info() {}, warn() {} } })
  await engine.init()
  const safe = path.join(dir, 'SafeStorage')
  fs.mkdirSync(safe, { recursive: true })
  return { name, dir, file, app, db, engine, safe, slot, close: async () => { await app.destroy(); await db.destroy() } }
}

/** Swap everything between two PCs, as the LAN round does (both ways until nothing is left). */
export async function syncPair(a, b) {
  for (let i = 0; i < 100; i++) {
    const pull = await b.engine.changesSince(await a.engine.vector(), 500)
    await a.engine.apply(pull.entries, pull.complete)
    const push = await a.engine.changesSince(await b.engine.vector(), 500)
    await b.engine.apply(push.entries, push.complete)
    if (!pull.more && !push.more) return
  }
  throw new Error('sync did not end')
}

/** What a table holds, the same way on every PC (to compare them). */
export async function dump(pc, table, cols = '*') {
  return pc.db.raw(`SELECT ${cols} FROM "${table}" ORDER BY id`)
}
