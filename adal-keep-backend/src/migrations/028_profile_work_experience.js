/**
 * 028 — profiles.work_experience + profiles.experience_country
 *
 * Musaned's required "Experience" field. work_experience is
 * 'No experience' (default) or 'Have experience'; experience_country is the
 * Gulf country the worker has experience in (only with 'Have experience').
 */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('profiles', 'work_experience'))) {
    await knex.schema.alterTable('profiles', t => t.string('work_experience').defaultTo('No experience'))
  }
  if (!(await knex.schema.hasColumn('profiles', 'experience_country'))) {
    await knex.schema.alterTable('profiles', t => t.string('experience_country').nullable())
  }
  console.log('028: profiles.work_experience + experience_country added')
}

export async function down(knex) {
  for (const c of ['work_experience', 'experience_country']) {
    if (await knex.schema.hasColumn('profiles', c)) {
      await knex.schema.alterTable('profiles', t => t.dropColumn(c))
    }
  }
}
