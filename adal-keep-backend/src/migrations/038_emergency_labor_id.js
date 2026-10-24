/**
 * 038 — the emergency contact person's LMIS Labor ID (EM…). A Saudi LMIS
 * contract adds that person on its "Emergency Contact" tab.
 */
export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(profiles)')).map(c => c.name)
  if (!cols.includes('emergency_labor_id')) await knex.schema.alterTable('profiles', t => t.string('emergency_labor_id'))
}

export async function down() {}
