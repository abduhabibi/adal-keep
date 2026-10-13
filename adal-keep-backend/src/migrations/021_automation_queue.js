export async function up(knex) {
  await knex.schema.createTableIfNotExists('automation_queue', t => {
    t.increments('id').primary()
    t.integer('profile_id').notNullable()
    t.string('workflow_id').notNullable()
    t.integer('account_id').nullable()
    t.string('status').defaultTo('pending')       // pending | running | paused | done | failed | cancelled
    t.integer('current_step').defaultTo(0)
    t.text('context')                             // JSON credentials snapshot
    t.text('log')                                 // JSON [{ts, level, msg}]
    t.string('pause_reason')
    t.timestamp('started_at')
    t.timestamp('finished_at')
    t.timestamps(true, true)
  })
  console.log('021: automation_queue created')
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('automation_queue')
}