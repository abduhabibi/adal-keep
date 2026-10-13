export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(cv_templates)')).map(c => c.name)
  const add = async (n, fn) => { if (!cols.includes(n)) await knex.schema.alterTable('cv_templates', fn) }
  await add('passport_h1',             t => t.string('passport_h1'))
  await add('passport_h1_color',       t => t.string('passport_h1_color').defaultTo('#000000'))
  await add('passport_include_header', t => t.boolean('passport_include_header').defaultTo(true))
  await add('passport_include_footer', t => t.boolean('passport_include_footer').defaultTo(true))
  console.log('017: passport page config columns added')
}
export async function down(knex) {}
