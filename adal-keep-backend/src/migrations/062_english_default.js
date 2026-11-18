/**
 * English is the default language for everyone. Once, every saved tutor
 * language goes back to English; people can pick another by hand afterwards.
 * (The screen language is saved per browser under a new key, so it also
 * starts at English once.)
 */
export async function up(knex) {
  if (await knex.schema.hasTable('tutor_prefs')) await knex('tutor_prefs').update({ lang: 'en' })
}

export async function down() {}
