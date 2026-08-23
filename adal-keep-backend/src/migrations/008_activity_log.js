export async function up(knex) {
  const exists = await knex.schema.hasTable('activity_log')
  if (!exists) {
    await knex.schema.createTable('activity_log', (table) => {
      table.increments('id').primary()
      table.string('client_id').notNullable()
      table.string('event_type').notNullable()
      table.text('event_data')
      table.timestamp('created_at').notNullable()
      table.index('client_id')
      table.index('event_type')
      table.index('created_at')
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('activity_log')
}
