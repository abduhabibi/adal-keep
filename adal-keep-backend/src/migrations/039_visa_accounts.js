/**
 * 039 — Visa platform (visa.mofa.gov.sa): its own login (one for every visa
 * run, like the Musaned and LMIS accounts), and where each profile stands
 * with her visa (profiles.visa_stage, visa_application_number).
 */
export async function up(knex) {
  if (!(await knex.schema.hasTable('visa_accounts'))) await knex.schema.createTable('visa_accounts', t => {
    t.increments('id').primary()
    t.string('name').notNullable()          // friendly label e.g. "Nuzla visa"
    t.string('username').notNullable()      // Login Name
    t.string('password').notNullable()
    t.string('phone').nullable()
    t.string('notes').nullable()
    t.boolean('is_default').defaultTo(false)
    t.timestamp('last_used_at')
    t.timestamps(true, true)
  })
  for (const c of ['visa_stage', 'visa_application_number', 'visa_applied_at']) {
    if (!(await knex.schema.hasColumn('profiles', c))) await knex.schema.alterTable('profiles', t => t.string(c).nullable())
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('visa_accounts')
  for (const c of ['visa_stage', 'visa_application_number', 'visa_applied_at']) {
    if (await knex.schema.hasColumn('profiles', c)) await knex.schema.alterTable('profiles', t => t.dropColumn(c))
  }
}
