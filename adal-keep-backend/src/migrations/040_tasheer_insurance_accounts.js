/**
 * 040 — Login accounts for Tasheer and the insurance platform
 * (agency.niscofetap.com), one of each for every run, like Musaned's.
 */
const TABLES = ['tasheer_accounts', 'insurance_accounts']

export async function up(knex) {
  for (const name of TABLES) {
    if (await knex.schema.hasTable(name)) continue
    await knex.schema.createTable(name, t => {
      t.increments('id').primary()
      t.string('name').notNullable()
      t.string('username').notNullable()
      t.string('password').notNullable()
      t.string('phone').nullable()
      t.string('notes').nullable()
      t.boolean('is_default').defaultTo(false)
      t.timestamp('last_used_at')
      t.timestamps(true, true)
    })
  }
}

export async function down(knex) {
  for (const name of TABLES) await knex.schema.dropTableIfExists(name)
}
