/**
 * automation_queue.priority: the person can move a waiting run up or down the line,
 * or make it run next (Robot history → Waiting). The worker starts the highest
 * priority first, then the oldest. 0 = the normal place. The table is copied between
 * PCs like the rest, so the order is the same on every PC.
 */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('automation_queue', 'priority'))) {
    await knex.schema.alterTable('automation_queue', t => t.integer('priority').defaultTo(0))
  }
}
export async function down() {}
