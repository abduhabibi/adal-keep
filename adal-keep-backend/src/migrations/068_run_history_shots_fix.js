/**
 * Rows that say they have a stop picture but have none (2026-11-24): on a PC
 * with the copying on, every picture's insert failed (sync/ids.js gave the row
 * an "id" that run_history_shots does not have). Their "Picture" button only
 * said "No picture": it goes. A list index for the newest-first pages.
 */
export async function up(knex) {
  if (!(await knex.schema.hasTable('run_history')) || !(await knex.schema.hasTable('run_history_shots'))) return
  await knex.raw(`UPDATE run_history SET has_shot = 0 WHERE has_shot = 1 AND id NOT IN (SELECT history_id FROM run_history_shots)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS run_history_newest ON run_history (started_at DESC, id DESC)`)
}

export async function down() {}
