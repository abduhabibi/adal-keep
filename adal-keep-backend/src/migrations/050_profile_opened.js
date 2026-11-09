/** When a profile was last opened: an opened profile is the most recent on the list. */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('profiles', 'last_opened_at'))) {
    await knex.schema.alterTable('profiles', t => { t.string('last_opened_at').nullable() })
  }
}

export async function down() {}
