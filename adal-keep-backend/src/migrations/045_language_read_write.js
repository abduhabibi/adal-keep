/**
 * Languages on the CV: speaks_english / speaks_arabic are "Speak"; reading and
 * writing are their own ticks (off unless ticked on the CV page).
 */
const COLS = ['english_read', 'english_write', 'arabic_read', 'arabic_write']

export async function up(knex) {
  for (const c of COLS) {
    if (!(await knex.schema.hasColumn('profiles', c))) {
      await knex.schema.alterTable('profiles', t => { t.boolean(c).defaultTo(false) })
    }
  }
}

export async function down(knex) {
  for (const c of COLS) {
    if (await knex.schema.hasColumn('profiles', c)) await knex.schema.alterTable('profiles', t => { t.dropColumn(c) })
  }
}
