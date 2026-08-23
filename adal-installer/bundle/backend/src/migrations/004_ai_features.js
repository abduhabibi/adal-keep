export async function up(knex) {
  // Knowledge base table
  await knex.schema.createTable('knowledge_base', (table) => {
    table.increments('id').primary()
    table.text('content').notNullable()
    table.string('category').defaultTo('general')
    table.boolean('is_active').defaultTo(true)
    table.timestamps(true, true)
  })

  // AI conversations log
  await knex.schema.createTable('ai_conversations', (table) => {
    table.increments('id').primary()
    table.text('user_message').notNullable()
    table.text('ai_response').notNullable()
    table.string('model')
    table.timestamps(true, true)
  })

  // Tasks table
  await knex.schema.createTable('tasks', (table) => {
    table.increments('id').primary()
    table.string('title').notNullable()
    table.text('description')
    table.string('status').defaultTo('todo') // todo, in_progress, done
    table.string('priority').defaultTo('medium') // low, medium, high
    table.date('due_date')
    table.integer('assigned_to').nullable()
    table.boolean('is_ai_created').defaultTo(false)
    table.timestamps(true, true)
  })

  // Updates/Feed table
  await knex.schema.createTable('updates', (table) => {
    table.increments('id').primary()
    table.string('type').notNullable() // info, alert, success, ai_generated
    table.string('title').notNullable()
    table.text('body')
    table.string('icon').defaultTo('info')
    table.boolean('is_ai_generated').defaultTo(false)
    table.timestamps(true, true)
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('updates')
  await knex.schema.dropTableIfExists('tasks')
  await knex.schema.dropTableIfExists('ai_conversations')
  await knex.schema.dropTableIfExists('knowledge_base')
} 