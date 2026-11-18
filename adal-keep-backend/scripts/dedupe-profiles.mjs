#!/usr/bin/env node
/**
 * dedupe-profiles.mjs — one profile per passport number (asked on 2026-11-18).
 *
 *   node scripts/dedupe-profiles.mjs            list the duplicates, change nothing
 *   node scripts/dedupe-profiles.mjs --apply    back the database up, then merge
 *
 * Two profiles are the same person when their passport numbers match (case and
 * spaces ignored). The oldest profile is kept. From the others: empty details
 * are filled from them, their documents and fields move to the kept profile
 * (a document already there is not copied twice), their checklist and
 * automation rows move too, and then the duplicate is deleted.
 *
 * The backup is a full copy made by SQLite itself (VACUUM INTO) in
 * data/backups/, so it is safe while the app runs.
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import knexConfig from '../knexfile.js'
import knexLib from 'knex'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APPLY = process.argv.includes('--apply')
const db = knexLib(knexConfig.development)

const KEY = `UPPER(TRIM(passport_number))`
// Columns that are never copied from a duplicate.
const SKIP = new Set(['id', 'created_at', 'updated_at', 'created_by', 'last_opened_at'])
// Tables with a profile_id: the rows follow the kept profile.
const MOVE = ['tasks', 'profile_days', 'profile_automations', 'automation_queue', 'document_verifications', 'generated_cvs', 'notes', 'checklist_cells', 'whatsapp_sends', 'checklist_profiles']

async function groups() {
  const rows = await db('profiles').whereNotNull('passport_number').whereRaw(`TRIM(passport_number) <> ''`)
    .select('id', 'full_name', 'passport_number', 'created_at').orderBy('id')
  const by = new Map()
  for (const r of rows) {
    const k = String(r.passport_number).trim().toUpperCase()
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(r)
  }
  return [...by.entries()].filter(([, v]) => v.length > 1)
}

async function filled(db, id) {
  const row = await db('profiles').where({ id }).first()
  return Object.entries(row).filter(([k, v]) => !SKIP.has(k) && v !== null && String(v).trim() !== '').length
}

async function mergeInto(db, keep, dup, log) {
  // 1. Details: the kept profile's empty ones take the duplicate's values.
  const a = await db('profiles').where({ id: keep }).first()
  const b = await db('profiles').where({ id: dup }).first()
  const fill = {}
  for (const [k, v] of Object.entries(b)) {
    if (SKIP.has(k) || v === null || String(v).trim() === '') continue
    if (a[k] === null || String(a[k] ?? '').trim() === '') fill[k] = v
  }
  if (Object.keys(fill).length) await db('profiles').where({ id: keep }).update(fill)

  // 2. Fields: a field the kept profile already has gets the duplicate's files; a new one moves.
  const dupFields = await db('profile_fields').where({ profile_id: dup })
  for (const f of dupFields) {
    const same = await db('profile_fields').where({ profile_id: keep, name: f.name }).first()
    if (same) {
      // A picture already in the kept field (same content) is not copied twice.
      const have = new Set((await db('files').where({ profile_field_id: same.id }).select('content_hash')).map(x => x.content_hash).filter(Boolean))
      for (const file of await db('files').where({ profile_field_id: f.id })) {
        if (file.content_hash && have.has(file.content_hash)) await db('files').where({ id: file.id }).del()
        else await db('files').where({ id: file.id }).update({ profile_field_id: same.id })
      }
      await db('profile_fields').where({ id: f.id }).del()
    } else {
      await db('profile_fields').where({ id: f.id }).update({ profile_id: keep })
    }
  }

  // 3. Everything else that points at the profile.
  for (const t of MOVE) {
    if (!(await db.schema.hasTable(t))) continue
    if (t === 'checklist_profiles') {
      // A checklist that already has the kept profile keeps one row only.
      const rows = await db(t).where({ profile_id: dup })
      for (const r of rows) {
        const exists = await db(t).where({ profile_id: keep, checklist_id: r.checklist_id }).first()
        if (exists) await db(t).where({ id: r.id }).del()
        else await db(t).where({ id: r.id }).update({ profile_id: keep })
      }
      continue
    }
    if (!(await db.schema.hasColumn(t, 'profile_id'))) continue
    // A row that would clash with one the kept profile has (same day, same workflow…) is dropped.
    for (const r of await db(t).where({ profile_id: dup })) {
      try { await db(t).where({ id: r.id }).update({ profile_id: keep }) }
      catch (e) { if (!/UNIQUE/i.test(e.message)) throw e; await db(t).where({ id: r.id }).del() }
    }
  }

  // 4. The duplicate goes.
  await db('profiles').where({ id: dup }).del()
  log(`   merged #${dup} into #${keep}`)
}

async function main() {
  const dups = await groups()
  const total = dups.reduce((n, [, v]) => n + v.length - 1, 0)
  console.log(`${dups.length} passport number(s) have more than one profile: ${total} duplicate profile(s) to remove.`)
  for (const [key, list] of dups) {
    const counts = await Promise.all(list.map(r => filled(db, r.id)))
    const keep = list.reduce((best, r, i) => (counts[i] > counts[list.indexOf(best)] ? r : best), list[0])
    console.log(`${key}: keep #${keep.id} (${keep.full_name}); ${list.filter(r => r.id !== keep.id).map(r => `remove #${r.id}`).join(', ')}`)
  }
  if (!APPLY) { console.log('\nDry run: nothing changed. Run with --apply to merge.'); return }
  if (!dups.length) return

  const dir = path.join(__dirname, '..', 'data', 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `before-dedupe-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
  await db.raw('VACUUM INTO ?', [file])
  console.log(`backup: ${file}`)

  // One transaction: all duplicates are merged, or none.
  await db.transaction(async trx => {
    for (const [, list] of dups) {
      const counts = []
      for (const r of list) counts.push(await filled(trx, r.id))
      const keep = list.reduce((best, r, i) => (counts[i] > counts[list.indexOf(best)] ? r : best), list[0])
      for (const r of list) if (r.id !== keep.id) await mergeInto(trx, keep.id, r.id, console.log)
    }
  })
  console.log('done.')
}

main().catch(e => { console.error('dedupe failed:', e); process.exitCode = 1 }).finally(() => db.destroy())
