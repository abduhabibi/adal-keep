export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(profiles)')).map(c => c.name)
  const add = async (n, fn) => { if (!cols.includes(n)) await knex.schema.alterTable('profiles', fn) }
  await add('region',                 t => t.string('region'))
  await add('zone_subcity',           t => t.string('zone_subcity'))
  await add('labor_id',               t => t.string('labor_id'))
  await add('personal_number',        t => t.string('personal_number'))
  await add('emergency_name',         t => t.string('emergency_name'))
  await add('emergency_phone',        t => t.string('emergency_phone'))
  await add('emergency_gender',       t => t.string('emergency_gender'))
  await add('emergency_relationship', t => t.string('emergency_relationship'))
  await add('cooking_skill',          t => t.string('cooking_skill'))

  const tcols = (await knex.raw('PRAGMA table_info(cv_templates)')).map(c => c.name)
  if (!tcols.includes('header_path')) {
    await knex.schema.alterTable('cv_templates', t => t.string('header_path'))
  }
  if (!tcols.includes('include_passport')) {
    await knex.schema.alterTable('cv_templates', t => t.boolean('include_passport').defaultTo(false))
  }
  console.log('015: profiles + cv_templates extended')
}
export async function down(knex) {}
