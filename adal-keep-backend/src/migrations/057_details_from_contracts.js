/**
 * 057 — Girls whose details are only in their Musaned contract data (added
 * from the Musaned list): date of birth, passport dates, place of birth,
 * religion … into their own fields, so CVs and robots see them. Empty fields only.
 */
import { fillFromContracts } from '../services/contractFields.js'
export async function up(knex) {
  try { const n = await fillFromContracts(knex); if (n) console.log(`[057] details filled from the contract for ${n} profile(s)`) } catch (e) { console.warn('[057]', e.message) }
}
export async function down() {}
