/**
 * Appointment slips (asked for on 2026-11-09): Tasheer (the visa biometrics)
 * and the Wafid medical — each her slip file (a field like Passport) and its
 * date, time, place and reference number. A reminder goes the day before
 * (appointment_alerts_sent: the appointments already reminded of).
 *
 * And: the emergency contact is her father — where it is empty, it takes the
 * father's name.
 */
const COLUMNS = [
  'tasheer_date', 'tasheer_time', 'tasheer_center', 'tasheer_ref',
  'wafid_appt_date', 'wafid_appt_time', 'wafid_center', 'wafid_slip_number',
]

export async function up(knex) {
  for (const col of COLUMNS) {
    if (!(await knex.schema.hasColumn('profiles', col))) await knex.schema.alterTable('profiles', t => t.string(col))
  }
  if (!(await knex.schema.hasColumn('profiles', 'appointment_alerts_sent'))) {
    await knex.schema.alterTable('profiles', t => t.text('appointment_alerts_sent').defaultTo('[]'))
  }
  // The Wafid slip already has its field: "Appointment Slip" (the robot saves it there).
  for (const name of ['Tasheer Slip']) {
    await knex('field_templates').insert({ name, data_type: 'file', is_permanent: true }).onConflict('name').ignore()
  }
  if (await knex.schema.hasColumn('profiles', 'father_name')) {
    await knex('profiles')
      .where(q => q.whereNull('emergency_name').orWhere('emergency_name', ''))
      .whereNotNull('father_name').andWhere('father_name', '!=', '')
      .update({ emergency_name: knex.ref('father_name') })
  }
}

export async function down() {}
