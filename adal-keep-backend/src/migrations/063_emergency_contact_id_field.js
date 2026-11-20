/**
 * A document box for her emergency contact's own ID card (asked on 2026-11-19):
 * what is put there is read at once and fills her emergency details
 * (services/emergencyId.js). Every profile shows it.
 */
export async function up(knex) {
  const now = new Date().toISOString()
  if (!(await knex('field_templates').where('name', 'Emergency Contact ID').first())) {
    await knex('field_templates').insert({ name: 'Emergency Contact ID', data_type: 'file', is_permanent: true, created_at: now, updated_at: now })
  }
}

export async function down() {}
