export async function up(knex) {
  await knex.schema.createTableIfNotExists('lmis_accounts', t => {
    t.increments('id').primary()
    t.string('name').notNullable()
    t.string('login_value').notNullable()
    t.string('password')
    t.string('phone')
    t.string('agency_name')
    t.boolean('is_default').defaultTo(false)
    t.timestamp('last_used_at')
    t.timestamps(true, true)
  })
  console.log('020: lmis_accounts created')
}
export async function down(knex) {
  await knex.schema.dropTableIfExists('lmis_accounts')
}
