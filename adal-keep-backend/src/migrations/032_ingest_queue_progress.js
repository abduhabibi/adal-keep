/**
 * What the Tasks page shows for each document: the step it is on while it is
 * read (stage) and what came of it (result).
 */
export async function up(knex) {
  for (const [col, add] of [['stage', t => t.string('stage')], ['result', t => t.text('result')]]) {
    if (!(await knex.schema.hasColumn('ingest_queue', col))) await knex.schema.alterTable('ingest_queue', add)
  }
}

export async function down() {}
