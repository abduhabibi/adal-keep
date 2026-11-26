// READ-ONLY: lists the profiles the contracts check made with a one-word name (what the owner moves to the Trash).
//   node scripts/one-name-profiles.mjs            (from the backend folder, on the PC whose database it is; stop Adal Keep first if it is busy)
// Rule (services/passportOnly.js ONE_WORD_RULE): created_by = 'Musaned list' AND the full name is ONE word. Nothing is changed.
import knex from 'knex'
import cfg from '../knexfile.js'
import { ONE_WORD_RULE } from '../src/services/passportOnly.js'
const db = knex({ ...cfg.development, pool: { min: 1, max: 1 } })
const rows = await db('profiles').whereRaw(ONE_WORD_RULE).select('id', 'full_name', 'passport_number', 'created_at', 'updated_at', 'notes').orderBy('id')
console.log(`${rows.length} profile(s): created_by = 'Musaned list' and a one-word full_name`)
for (const r of rows) {
  const files = (await db('files as f').join('profile_fields as pf', 'pf.id', 'f.profile_field_id').where('pf.profile_id', r.id).count({ c: '*' }).first()).c
  console.log(`#${r.id}  ${r.full_name.padEnd(18)} ${String(r.passport_number || '-').padEnd(12)} made ${String(r.created_at).slice(0, 16)}  files ${files}  ${r.updated_at !== r.created_at ? 'EDITED later' : 'untouched'}  ${String(r.notes || '').startsWith('Added from the Musaned list') ? '' : 'NOTES CHANGED'}`)
}
await db.destroy()
process.exit(0)
