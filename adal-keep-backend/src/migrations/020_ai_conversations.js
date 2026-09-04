/**
 * AI chat persistence
 */
export async function up(knex) {
  const hasConv = await knex.schema.hasTable('ai_conversations')
  if (!hasConv) {
    await knex.schema.createTable('ai_conversations', (t) => {
      t.increments('id').primary()
      t.integer('company_id').defaultTo(1).notNullable()
      t.integer('user_id').nullable()
      t.string('title', 255).defaultTo('New Chat')
      t.timestamp('created_at').defaultTo(knex.fn.now())
      t.timestamp('updated_at').defaultTo(knex.fn.now())
    })
  }

  const hasMsg = await knex.schema.hasTable('ai_messages')
  if (!hasMsg) {
    await knex.schema.createTable('ai_messages', (t) => {
      t.increments('id').primary()
      t.integer('conversation_id').notNullable().references('id').inTable('ai_conversations').onDelete('CASCADE')
      t.string('role', 20).notNullable()   // user | assistant
      t.text('content').notNullable()
      t.timestamp('created_at').defaultTo(knex.fn.now())
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('ai_messages')
  await knex.schema.dropTableIfExists('ai_conversations')
}
