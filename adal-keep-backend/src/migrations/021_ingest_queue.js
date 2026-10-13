export async function up(knex) {
  await knex.schema.createTableIfNotExists('ingest_queue', t => {
    t.increments('id').primary()
    t.string('filename').notNullable()
    t.string('full_path').notNullable()
    t.integer('file_size')
    t.string('status').defaultTo('pending')
    t.integer('attempts').defaultTo(0)
    t.text('last_error')
    t.timestamp('started_at')
    t.timestamp('finished_at')
    t.timestamps(true, true)
    t.index('status')
  })
  console.log('021: ingest_queue created')
}
export async function down(knex) {
  await knex.schema.dropTableIfExists('ingest_queue')
}
