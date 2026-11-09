// CV headers cut from the CVs a move brought in (services/cvHeader.js): the
// choices "Add CV template" offers.
export async function up(knex) {
  if (await knex.schema.hasTable('cv_headers')) return
  await knex.schema.createTable('cv_headers', t => {
    t.increments('id')
    t.string('name')
    t.string('path')
    t.string('source')
    t.string('hash').index()
    t.integer('width')
    t.integer('height')
    t.string('created_at')
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('cv_headers')
}
