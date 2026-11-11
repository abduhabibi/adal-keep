/**
 * 054 — No admin employees: everyone does everything (WhatsApp CVs too), and
 * no employee is asked for a password. The admin employees become employees.
 */
export async function up(knex) {
  await knex('users').where({ role: 'admin' }).whereNot({ username: 'admin' }).update({ role: 'employee' }).catch(() => {})
}
export async function down() {}
