export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(profiles)')).map(c => c.name)
  if (!cols.includes('destination_country')) {
    await knex.schema.alterTable('profiles', t => t.string('destination_country'))
  }
  console.log('022: profiles.destination_country added')
}
export async function down(knex) {}