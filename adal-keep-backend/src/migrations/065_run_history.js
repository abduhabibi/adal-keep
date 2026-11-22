/**
 * run_history: one row for each time a robot ran (a run's try, or a move from
 * another system): who started it, on which PC, which site, when, how long, how
 * it ended and where it stopped. run_history_shots keeps the small picture of
 * the tab taken at the stop (services/runHistory.js; both pruned after 30 days).
 * They live in the main PC's database, so every PC reads the same history.
 */
export async function up(knex) {
  if (!(await knex.schema.hasTable('run_history'))) {
    await knex.schema.createTable('run_history', t => {
      t.increments('id').primary()
      t.integer('run_id').index()           // automation_queue id (null for a move)
      t.string('kind').defaultTo('run')     // run | move
      t.string('workflow_id')
      t.string('workflow')                  // its name in words
      t.string('site').index()              // Musaned, LMIS, Wafid …
      t.integer('profile_id').index()
      t.string('profile_name')
      t.string('account')                   // the site account it signed in with
      t.string('employee')                  // who started it
      t.string('pc')                        // the PC whose browser did it
      t.string('started_at').index()
      t.string('ended_at')
      t.integer('duration_s')
      t.string('outcome').defaultTo('running').index()   // running | done | failed | cancelled | paused | stopped
      t.text('reason')                      // why it failed, in words
      t.text('step')                        // the step it stopped at
      t.boolean('has_shot').defaultTo(false)
    })
  }
  if (!(await knex.schema.hasTable('run_history_shots'))) {
    await knex.schema.createTable('run_history_shots', t => {
      t.integer('history_id').primary()
      t.binary('jpg')
      t.string('taken_at')
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('run_history_shots')
  await knex.schema.dropTableIfExists('run_history')
}
