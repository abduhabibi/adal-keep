export async function up(knex) {
  await knex.schema.createTableIfNotExists('musaned_accounts', t => {
    t.increments('id').primary()
    t.string('name').notNullable()          // friendly label e.g. "Nuzla Musaned"
    t.string('username').notNullable()      // Keycloak username
    t.string('password').notNullable()
    t.string('phone').nullable()            // optional
    t.string('notes').nullable()
    t.boolean('is_default').defaultTo(false)
    t.timestamp('last_used_at')
    t.timestamps(true, true)
  })
  console.log('023: musaned_accounts created')
}
export async function down(knex) {
  await knex.schema.dropTableIfExists('musaned_accounts')
}