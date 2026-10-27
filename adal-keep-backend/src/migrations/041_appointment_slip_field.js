/**
 * A file field for the Wafid appointment slip (the wafid_slip run saves the
 * slip's PDF there; the field has a Print button). Every profile shows it.
 */
export async function up(knex) {
  const now = new Date().toISOString()
  if (!(await knex('field_templates').where('name', 'Appointment Slip').first())) {
    await knex('field_templates').insert({ name: 'Appointment Slip', data_type: 'file', is_permanent: true, created_at: now, updated_at: now })
  }
}

export async function down() {}
