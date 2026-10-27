/**
 * What this PC already put in its online copy (services/cloudSync.js):
 * key = an API path ("/profiles/59") or "file:<id>", hash = what was sent.
 */
export async function up(knex) {
  if (!(await knex.schema.hasTable('cloud_sync'))) {
    await knex.schema.createTable('cloud_sync', t => {
      t.string('key').primary()
      t.string('hash')
      t.string('at')
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('cloud_sync')
}
