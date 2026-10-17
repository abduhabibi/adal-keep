/**
 * 030 — profiles.experience_years: Years Of Experience, asked together with
 * the experience country when work_experience is 'Have experience'.
 */
export async function up(knex) {
  if (!(await knex.schema.hasColumn('profiles', 'experience_years'))) {
    await knex.schema.alterTable('profiles', t => t.integer('experience_years').nullable())
  }
  console.log('030: profiles.experience_years added')
}

export async function down(knex) {
  if (await knex.schema.hasColumn('profiles', 'experience_years')) {
    await knex.schema.alterTable('profiles', t => t.dropColumn('experience_years'))
  }
}
