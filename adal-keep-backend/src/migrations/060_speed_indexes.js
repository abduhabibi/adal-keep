/**
 * 060 — Indexes for what every page asks most: a profile's fields and their
 * files, her runs, her CVs and checks. Without them each ask read the whole
 * table (a profile page asked profile_fields ~30 times, each a full scan).
 * Only indexes: no data changes. A table or column missing on this PC is skipped.
 */
const INDEXES = [
  ['profile_fields', ['profile_id', 'name']],
  ['files', ['profile_field_id']],
  ['automation_queue', ['profile_id', 'workflow_id']],
  ['automation_queue', ['status']],
  ['generated_cvs', ['profile_id']],
  ['document_verifications', ['profile_id']],
  ['profile_automations', ['profile_id']],
  ['ai_messages', ['conversation_id']],
]

const nameOf = (table, cols) => `${table}_${cols.join('_')}_speed_index`

export async function up(knex) {
  for (const [table, cols] of INDEXES) {
    try {
      if (!(await knex.schema.hasTable(table))) continue
      let ok = true
      for (const c of cols) if (!(await knex.schema.hasColumn(table, c))) ok = false
      if (!ok) continue
      await knex.raw(`CREATE INDEX IF NOT EXISTS ?? ON ?? (${cols.map(() => '??').join(', ')})`, [nameOf(table, cols), table, ...cols])
    } catch (e) { console.warn('[060]', table, e.message) }
  }
}

export async function down(knex) {
  for (const [table, cols] of INDEXES) await knex.raw('DROP INDEX IF EXISTS ??', [nameOf(table, cols)]).catch(() => {})
}
