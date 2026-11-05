/** Labor IDs are capitals: the ones typed before that rule too. */
export async function up(knex) {
  for (const c of ['labor_id', 'emergency_labor_id']) {
    if (await knex.schema.hasColumn('profiles', c)) await knex('profiles').whereNotNull(c).update({ [c]: knex.raw('UPPER(TRIM(??))', [c]) })
  }
}

export async function down() {}
