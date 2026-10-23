/**
 * 037 — Visa & Contract: what the Musaned employment request (the contract a
 * Saudi employer made for the candidate) says, read every 4 hours
 * (services/musanedContracts.js). Visa / Tasheer / LMIS details come here too.
 */
export const CONTRACT_COLUMNS = [
  'musaned_stage', 'musaned_payment', 'musaned_pro', 'contract_number', 'visa_number', 'tawassut_number',
  'employer_name', 'employer_id', 'employer_phone', 'employer_address', 'work_city', 'salary',
  'contract_date', 'issuing_authority', 'job_title', 'chosen_at', 'contract_checked_at',
]

export async function up(knex) {
  for (const c of CONTRACT_COLUMNS) {
    if (!(await knex.schema.hasColumn('profiles', c))) await knex.schema.alterTable('profiles', t => t.string(c).nullable())
  }
  // Everything else the contract and its page show, label → value.
  if (!(await knex.schema.hasColumn('profiles', 'contract_data'))) await knex.schema.alterTable('profiles', t => t.text('contract_data').nullable())
}

export async function down(knex) {
  for (const c of [...CONTRACT_COLUMNS, 'contract_data']) {
    if (await knex.schema.hasColumn('profiles', c)) await knex.schema.alterTable('profiles', t => t.dropColumn(c))
  }
}
