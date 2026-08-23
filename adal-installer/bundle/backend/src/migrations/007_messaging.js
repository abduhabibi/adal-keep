export async function up(knex) {
  // AI Instance Registry
  await knex.schema.createTable('ai_instances', (table) => {
    table.string('ai_id').primary()
    table.string('client_name').notNullable()
    table.string('fingerprint')
    table.text('capabilities')
    table.timestamp('last_seen')
    table.boolean('is_online').defaultTo(false)
    table.timestamps(true, true)
  })

  // Portal Messages (You ↔ AI)
  await knex.schema.createTable('portal_messages', (table) => {
    table.increments('id').primary()
    table.string('to_ai_id').nullable()
    table.string('from').notNullable()
    table.text('message').notNullable()
    table.boolean('is_group').defaultTo(false)
    table.string('group_name').nullable()
    table.boolean('is_from_admin').defaultTo(false)
    table.boolean('is_read').defaultTo(false)
    table.timestamps(true, true)
  })

  // Portal Groups
  await knex.schema.createTable('portal_groups', (table) => {
    table.increments('id').primary()
    table.string('name').notNullable()
    table.text('ai_ids') // JSON array of ai_id strings
    table.timestamps(true, true)
  })

  // Indexes
  await knex.schema.table('portal_messages', (table) => {
    table.index('to_ai_id')
    table.index('from')
    table.index('group_name')
    table.index('created_at')
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('portal_groups')
  await knex.schema.dropTableIfExists('portal_messages')
  await knex.schema.dropTableIfExists('ai_instances')
}