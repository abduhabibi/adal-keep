/**
 * In-app tutor (routes/tutor.js):
 *   tutor_usage  which features each person has used, and how often
 *   tutor_days   one row per person per day: today's lesson, goals done (streak)
 *   tutor_prefs  each person's tutor language
 * `who` is the employee id, or 'owner' when no employee is signed in on the PC.
 */
export async function up(knex) {
  if (!(await knex.schema.hasTable('tutor_usage'))) {
    await knex.schema.createTable('tutor_usage', t => {
      t.increments('id')
      t.string('who').notNullable()
      t.string('feature').notNullable()
      t.integer('count').notNullable().defaultTo(0)
      t.string('first_at')
      t.string('last_at')
      t.unique(['who', 'feature'])
    })
  }
  if (!(await knex.schema.hasTable('tutor_days'))) {
    await knex.schema.createTable('tutor_days', t => {
      t.increments('id')
      t.string('who').notNullable()
      t.string('day').notNullable()          // YYYY-MM-DD, local time
      t.string('lesson_id')
      t.boolean('lesson_done').defaultTo(false)
      t.text('goals_done').defaultTo('[]')   // goal ids ticked today
      t.string('opened_at')
      t.unique(['who', 'day'])
    })
  }
  if (!(await knex.schema.hasTable('tutor_prefs'))) {
    await knex.schema.createTable('tutor_prefs', t => {
      t.string('who').primary()
      t.string('lang').defaultTo('am')
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('tutor_usage')
  await knex.schema.dropTableIfExists('tutor_days')
  await knex.schema.dropTableIfExists('tutor_prefs')
}
