export async function up(knex) {
  const exists = await knex.schema.hasTable('quick_links')
  if (!exists) {
    await knex.schema.createTable('quick_links', (table) => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.string('url').notNullable()
      table.string('thumbnail_url')
      table.integer('sort_order').defaultTo(0)
      table.timestamp('created_at').defaultTo(knex.fn.now())
      table.timestamp('updated_at').defaultTo(knex.fn.now())
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('quick_links')
}
