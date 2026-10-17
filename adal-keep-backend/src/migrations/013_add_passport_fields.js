export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(profiles)')).map(c => c.name)
  const add = async (name, fn) => {
    if (!cols.includes(name)) await knex.schema.alterTable('profiles', fn)
  }
  await add('place_of_birth', t => t.string('place_of_birth').nullable())
  await add('surname_am',     t => t.string('surname_am').nullable())
  await add('given_names_am', t => t.string('given_names_am').nullable())
  await add('mrz_raw',        t => t.text('mrz_raw').nullable())
  console.log('013: place_of_birth, surname_am, given_names_am, mrz_raw ready')
}
export async function down(knex) {}
