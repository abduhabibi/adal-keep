/** The Trash: everything deleted, restorable from the main PC (services/trash.js). */
export async function up(knex) {
  if (await knex.schema.hasTable('trash')) return
  await knex.schema.createTable('trash', t => {
    t.increments('id').primary()
    t.string('kind').notNullable()
    t.integer('item_id')
    t.string('title')
    t.text('payload')          // the rows, as they were
    t.text('files')            // [{ from, to }] moved into data/Trash/<id>/
    t.string('deleted_by')
    t.string('deleted_from')
    t.string('deleted_at')
    t.index('deleted_at')
  })
}

export async function down(knex) { await knex.schema.dropTableIfExists('trash') }
