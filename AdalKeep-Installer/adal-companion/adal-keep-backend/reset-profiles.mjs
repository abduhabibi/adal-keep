import knex from 'knex'
import knexConfig from './knexfile.js'

const db = knex(knexConfig.development)

console.log('Wiping profiles, fields, files, tasks...')

// Order matters: files -> profile_fields -> tasks -> profiles
await db('files').del()
await db('profile_fields').del()
await db('tasks').del()
await db('profiles').del()

// Reset the AUTOINCREMENT counters so IDs start fresh
try {
  await db.raw("DELETE FROM sqlite_sequence WHERE name IN ('profiles','profile_fields','files','tasks')")
} catch (e) {
  // sqlite_sequence only exists if AUTOINCREMENT was used — ignore if missing
  console.log('(sqlite_sequence reset skipped:', e.message + ')')
}

console.log('✅ All profiles, fields, files, tasks deleted.')

// Also clear SafeStorage so leftover files don't confuse future runs
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const store = path.join(__dirname, 'data/SafeStorage')
if (fs.existsSync(store)) {
  const entries = fs.readdirSync(store)
  let n = 0
  for (const f of entries) {
    const fp = path.join(store, f)
    try { if (fs.statSync(fp).isFile()) { fs.unlinkSync(fp); n++ } } catch {}
  }
  console.log(`✅ Cleared ${n} files from SafeStorage`)
}

await db.destroy()
