/**
 * 055 — Each profile's status, day by day (services/profileDays.js): one row
 * per profile per day — her stage and every journey step (FMOL approved or
 * not, …) as they were at the end of that day.
 */
export async function up(knex) {
  if (await knex.schema.hasTable('profile_days')) return
  await knex.schema.createTable('profile_days', t => {
    t.increments('id').primary()
    t.integer('profile_id').notNullable().index()
    t.string('day', 10).notNullable()
    t.text('data')
    t.string('updated_at')
    t.unique(['profile_id', 'day'])
  })
}
export async function down(knex) { await knex.schema.dropTableIfExists('profile_days') }
