/**
 * "Wafid Slip" was made for a moment on 2026-11-09, but the Wafid medical slip
 * already has its field — "Appointment Slip", where the robot saves it. The
 * extra field goes again where it holds no file.
 */
export async function up(knex) {
  const empty = await knex('profile_fields').leftJoin('files', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.name', 'Wafid Slip').whereNull('files.id').select('profile_fields.id')
  const ids = empty.map(r => r.id)
  for (let i = 0; i < ids.length; i += 500) await knex('profile_fields').whereIn('id', ids.slice(i, i + 500)).del()
  const used = await knex('profile_fields').where('name', 'Wafid Slip').first()
  if (!used) await knex('field_templates').where('name', 'Wafid Slip').del()
}

export async function down() {}
