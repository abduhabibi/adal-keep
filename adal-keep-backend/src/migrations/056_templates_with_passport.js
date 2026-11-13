/**
 * 056 — Templates that came from a file (dropped in, a move, an agent from
 * Adal) show her passport page too (asked on 2026-11-13). One that someone
 * switches off afterwards stays off: this runs once.
 */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('cv_templates', 'include_passport'))) return
  await knex('cv_templates').whereNotNull('source_file').where(q => q.where('include_passport', 0).orWhereNull('include_passport'))
    .update({ include_passport: 1, passport_h1: knex.raw("coalesce(nullif(passport_h1, ''), 'Passport')"), passport_include_header: 1 }).catch(() => {})
}
export async function down() {}
