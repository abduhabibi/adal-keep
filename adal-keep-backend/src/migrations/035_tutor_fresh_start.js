/**
 * The tutor used to count every PC that was not signed in as one shared
 * "owner": one streak and one tour for everybody. Each person now has their own
 * (employee id, or the browser's own id). Start everyone fresh, once.
 * Only the tutor's own tables are touched.
 */
export async function up(knex) {
  for (const t of ['tutor_usage', 'tutor_days', 'tutor_prefs']) {
    if (await knex.schema.hasTable(t)) await knex(t).del()
  }
}

export async function down() {}
