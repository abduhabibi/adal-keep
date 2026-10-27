/**
 * Checklists choose their own columns (documents, profile details, their own
 * tick/text columns) — checklists.columns, a JSON list — and keep what is
 * written in their own columns per profile (checklist_cells).
 */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('checklists', 'columns'))) {
    await knex.schema.alterTable('checklists', t => { t.text('columns') })
  }
  if (!(await knex.schema.hasTable('checklist_cells'))) {
    await knex.schema.createTable('checklist_cells', t => {
      t.increments('id')
      t.integer('checklist_id').references('id').inTable('checklists').onDelete('CASCADE')
      t.integer('profile_id').references('id').inTable('profiles').onDelete('CASCADE')
      t.string('column')
      t.text('value')
      t.unique(['checklist_id', 'profile_id', 'column'])
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('checklist_cells')
}
