/**
 * WhatsApp per person: whose WhatsApp an agent belongs to and which WhatsApp
 * sent a CV (only that one can delete it again). Empty = the first account.
 */
export async function up(knex) {
  for (const t of ['whatsapp_agents', 'whatsapp_sends']) {
    if (!(await knex.schema.hasColumn(t, 'user_key'))) await knex.schema.table(t, c => { c.string('user_key') })
  }
}

export async function down(knex) {
  for (const t of ['whatsapp_agents', 'whatsapp_sends']) {
    if (await knex.schema.hasColumn(t, 'user_key')) await knex.schema.table(t, c => { c.dropColumn('user_key') })
  }
}
