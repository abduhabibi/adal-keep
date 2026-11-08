/** Notes: written on the Notes page, alone or about one person. */
export async function up(knex) {
  if (await knex.schema.hasTable('notes')) return
  await knex.schema.createTable('notes', t => {
    t.increments('id')
    t.text('text').notNullable()
    t.integer('profile_id').nullable().references('id').inTable('profiles').onDelete('SET NULL')
    t.integer('done').defaultTo(0)
    t.string('created_by').nullable()
    t.string('created_at')
    t.string('updated_at')
    t.index(['profile_id'])
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('notes')
}
