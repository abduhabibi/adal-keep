export async function up(knex) {
  await knex.schema.createTableIfNotExists('downloads_state', t => {
    t.increments('id').primary()
    t.string('filename').unique().notNullable()
    t.integer('size')
    t.bigInteger('mtime')            // ms since epoch
    t.timestamps(true, true)
  })
  console.log('022: downloads_state created')
}
export async function down(knex) {
  await knex.schema.dropTableIfExists('downloads_state')
}
