export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(cv_templates)')).map(c => c.name)
  if (!cols.includes('footer_path')) {
    await knex.schema.alterTable('cv_templates', t => t.string('footer_path'))
  }
  console.log('016: cv_templates.footer_path added')
}
export async function down(knex) {}
