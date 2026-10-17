export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(profiles)')).map(c => c.name)
  const add = async (n, fn) => { if (!cols.includes(n)) await knex.schema.alterTable('profiles', fn) }
  await add('middle_name', t => t.string('middle_name'))
  await add('order_id',    t => t.string('order_id'))
  console.log('018: middle_name + order_id added to profiles')
}
export async function down(knex) {}
