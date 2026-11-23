/**
 * Data protection: the candidate's consent on her profile ("agreed to share her
 * data for recruitment", who recorded it and when) and the audit log (who
 * viewed, exported, changed consent for or erased what). The log keeps no
 * personal data of an erased candidate: only her id and the word "erased".
 */
export async function up(knex) {
  for (const [col, make] of [
    ['data_consent', t => t.boolean('data_consent').defaultTo(false)],
    ['data_consent_at', t => t.string('data_consent_at')],
    ['data_consent_by', t => t.string('data_consent_by')],
  ]) {
    if (!(await knex.schema.hasColumn('profiles', col))) await knex.schema.alterTable('profiles', make)
  }
  if (!(await knex.schema.hasTable('audit_log'))) {
    await knex.schema.createTable('audit_log', t => {
      t.increments('id').primary()
      t.string('at').index()
      t.string('who')            // the employee's name (or "this PC", "phone")
      t.string('from_pc')
      t.string('action').index() // viewed | downloaded | exported | consent | erased
      t.string('target_kind')    // profile | file
      t.integer('target_id').index()
      t.string('target_name')
      t.text('detail')
    })
  }
}

export async function down() {}
