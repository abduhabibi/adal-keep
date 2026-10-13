import knex from 'knex'
import knexConfig from './knexfile.js'

const db = knex(knexConfig.development)

const rows = await db('profiles').select('id','full_name','first_name','last_name','passport_number')
console.log('Scanning', rows.length, 'profiles...\n')

let fixed = 0
for (const r of rows) {
  const fn = (r.first_name || '').trim()
  const ln = (r.last_name  || '').trim()
  if (!fn || !ln) continue

  const expected = fn + ' ' + ln
  if (r.full_name === expected) continue

  console.log(`#${r.id}: "${r.full_name}"  →  "${expected}"`)
  await db('profiles').where('id', r.id).update({
    full_name: expected,
    updated_at: new Date().toISOString(),
  })
  fixed++
}

console.log(`\n✅ ${fixed} profiles fixed.`)
await db.destroy()
