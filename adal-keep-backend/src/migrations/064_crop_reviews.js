/**
 * Crops waiting for a person's OK (asked on 2026-11-20: "after I upload a
 * photo that should be cropped, show a human the crop before approving it").
 * One row per picture JEV cut into parts; parts is JSON [{ kind, box, path }].
 */
export async function up(knex) {
  if (await knex.schema.hasTable('crop_reviews')) return
  await knex.schema.createTable('crop_reviews', t => {
    t.increments('id').primary()
    t.integer('profile_id').notNullable().index()
    t.integer('file_id')
    t.string('field_name')
    t.text('parts')
    t.string('dir')
    t.string('status').defaultTo('waiting').index()
    t.timestamps(true, true)
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('crop_reviews')
}
