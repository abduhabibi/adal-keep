/** A second phone number for the worker (added with the passport-first form). */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('profiles', 'phone_number_2'))) {
    await knex.schema.alterTable('profiles', t => t.string('phone_number_2'))
  }
}

export async function down() {}
