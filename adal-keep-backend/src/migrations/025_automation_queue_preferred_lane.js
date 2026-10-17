/**
 * 025 — automation_queue.preferred_lane
 *
 * Lets the operator pick WHICH of the numbered agents runs a given job at the
 * moment they click a workflow (e.g. "Musaned"). The chosen agent's lane id is
 * stored here; the worker only lets that lane claim the row (any other lane
 * skips it). NULL = the job is unassigned and any agent may take it, exactly
 * as before.
 */
export async function up(knex) {
  const has = await knex.schema.hasColumn('automation_queue', 'preferred_lane')
  if (!has) {
    await knex.schema.alterTable('automation_queue', t => t.integer('preferred_lane').nullable())
  }
  console.log('025: automation_queue.preferred_lane added')
}

export async function down(knex) {
  const has = await knex.schema.hasColumn('automation_queue', 'preferred_lane')
  if (has) {
    await knex.schema.alterTable('automation_queue', t => t.dropColumn('preferred_lane'))
  }
}
