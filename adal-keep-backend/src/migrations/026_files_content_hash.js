/**
 * 026 — files.content_hash
 *
 * SHA-256 of the stored original. Lets the ingest pipeline refuse a second
 * copy of the same document inside one profile field. Existing rows stay NULL
 * (they predate the check); only new ingests are compared.
 */
export async function up(knex) {
  const has = await knex.schema.hasColumn('files', 'content_hash')
  if (!has) {
    await knex.schema.alterTable('files', t => {
      t.string('content_hash', 64).nullable().index()
    })
  }
  console.log('026: files.content_hash added')
}

export async function down(knex) {
  const has = await knex.schema.hasColumn('files', 'content_hash')
  if (has) {
    await knex.schema.alterTable('files', t => t.dropColumn('content_hash'))
  }
}
