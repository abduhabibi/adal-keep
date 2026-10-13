/**
 * 027 — remove the "Enhanced Photo" and "Enhanced Full Body Photo" field templates.
 *
 * The Gemini enhancement feature that filled them has been removed. Only the
 * template rows are deleted here: profile_fields that already hold files are
 * left untouched, so no stored photo is lost by a migration.
 */
export async function up(knex) {
  await knex('field_templates').whereIn('name', ['Enhanced Photo', 'Enhanced Full Body Photo']).del()
  console.log('027: enhanced photo field templates removed')
}

export async function down() {
  // Templates are not restored: the feature they belonged to was removed.
}
