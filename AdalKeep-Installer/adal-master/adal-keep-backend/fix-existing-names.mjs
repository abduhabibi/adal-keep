import knex from 'knex'
import knexConfig from './knexfile.js'

const db = knex(knexConfig.development)

const profiles = await db('profiles').select('*')
let fixed = 0
for (const p of profiles) {
  const first = p.first_name || ''
  const last = p.last_name || ''
  // Only fix profiles where first_name looks like a surname — heuristic:
  // if full_name starts with last_name AND first_name is a single word
  // AND full_name contains first_name, they're reversed.
  if (first && last) {
    const correct = `${first} ${last}`.trim()
    if (correct && correct !== p.full_name && p.full_name.includes(last) && p.full_name.includes(first)) {
      const lastIdx = p.full_name.indexOf(last)
      const firstIdx = p.full_name.indexOf(first)
      // If last appears BEFORE first in the current full_name, it's reversed
      if (lastIdx !== -1 && firstIdx !== -1 && lastIdx < firstIdx) {
        console.log(`FIX profile ${p.id}: "${p.full_name}" → "${correct}"`)
        await db('profiles').where('id', p.id).update({ full_name: correct })
        fixed++
      }
    }
  }
}
console.log(`\n✅ Fixed ${fixed} profiles`)
await db.destroy()
