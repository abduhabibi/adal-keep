/**
 * Every CV sent on WhatsApp: who sent it and from which PC, which CV, and how far it
 * went (ack: 1 on WhatsApp, 2 delivered, 3 read) — the WhatsApp page. The table is
 * copied between the agency's PCs like the rest; updated_at: a page asks only for
 * what changed since.
 */
const COLS = { sent_by: 'string', sent_from: 'string', cv_id: 'integer', ack: 'integer', acked_at: 'string', updated_at: 'string' }
export async function up(knex) {
  if (!(await knex.schema.hasTable('whatsapp_sends'))) return
  for (const [c, type] of Object.entries(COLS)) {
    if (!(await knex.schema.hasColumn('whatsapp_sends', c))) await knex.schema.table('whatsapp_sends', t => { t[type](c) })
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS whatsapp_sends_updated ON whatsapp_sends (updated_at)')
  await knex.raw('CREATE INDEX IF NOT EXISTS whatsapp_sends_agent ON whatsapp_sends (agent_id)')
}
export async function down() {}
