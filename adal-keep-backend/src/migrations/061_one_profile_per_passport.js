/**
 * 061 — One profile per passport number (asked on 2026-11-18). A unique index
 * on the passport number (case and spaces ignored; blank numbers are not
 * counted). If this PC already has two profiles with one number, the index is
 * NOT made and a warning is logged: run `node scripts/dedupe-profiles.mjs
 * --apply` (it keeps a backup) and start the app again.
 */
const NAME = 'profiles_one_passport_unique'
const EXPR = `UPPER(TRIM(passport_number))`

export async function up(knex) {
  if (!(await knex.schema.hasTable('profiles')) || !(await knex.schema.hasColumn('profiles', 'passport_number'))) return
  const [{ n }] = await knex.raw(`SELECT COUNT(*) AS n FROM (SELECT ${EXPR} AS k FROM profiles WHERE TRIM(passport_number) <> '' GROUP BY k HAVING COUNT(*) > 1)`)
  if (Number(n) > 0) {
    console.warn(`[061] ${n} passport number(s) have more than one profile: index not made. Run scripts/dedupe-profiles.mjs --apply`)
    return
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${NAME} ON profiles (${EXPR}) WHERE TRIM(passport_number) <> ''`)
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${NAME}`)
}
