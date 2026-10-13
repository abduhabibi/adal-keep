export async function up(knex) {
  // 1. Create checklists table if it doesn't exist
  const hasChecklists = await knex.schema.hasTable('checklists')
  if (!hasChecklists) {
    await knex.schema.createTable('checklists', (table) => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.timestamps(true, true)
    })
  }

  // 2. Create checklist_profiles linking table if it doesn't exist
  const hasChecklistProfiles = await knex.schema.hasTable('checklist_profiles')
  if (!hasChecklistProfiles) {
    await knex.schema.createTable('checklist_profiles', (table) => {
      table.increments('id').primary()
      table.integer('checklist_id').unsigned().references('id').inTable('checklists').onDelete('CASCADE')
      table.integer('profile_id').unsigned().references('id').inTable('profiles').onDelete('CASCADE')
      table.unique(['checklist_id', 'profile_id']) // Prevents adding the same profile twice
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('checklist_profiles')
  await knex.schema.dropTableIfExists('checklists')
}