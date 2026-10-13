export async function up(knex) {
  await knex.schema.table('tasks', (table) => {
    table.index('status')
    table.index('created_at')
  })
  await knex.schema.table('updates', (table) => {
    table.index('created_at')
    table.index('type')
  })
  await knex.schema.table('ai_conversations', (table) => {
    table.index('created_at')
  })
  await knex.schema.table('profiles', (table) => {
    table.index('status')
    table.index('broker_id')
    table.index('created_at')
  })
}

export async function down(knex) {
  // SQLite doesn't support dropIndex easily — safe to leave
}