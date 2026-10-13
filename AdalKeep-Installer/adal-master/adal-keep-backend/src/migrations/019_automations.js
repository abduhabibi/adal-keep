export async function up(knex) {
  await knex.schema.createTableIfNotExists('profile_automations', t => {
    t.increments('id').primary()
    t.integer('profile_id').notNullable()
    t.string('workflow_id').notNullable()
    t.string('workflow_name')
    t.string('status').defaultTo('pending')   // pending | running | paused | done | failed | cancelled
    t.integer('current_step').defaultTo(0)
    t.text('context')                          // JSON — step outputs, token, etc.
    t.text('log')                              // JSON array of { ts, level, msg }
    t.string('pause_reason')
    t.timestamps(true, true)
  })
  console.log('019: profile_automations created')
}
export async function down(knex) {
  await knex.schema.dropTableIfExists('profile_automations')
}
