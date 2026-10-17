/**
 * 029 — an empty children_count means 0 (Musaned's Number Of Children needs a
 * number). Values already in the database are kept.
 */
export async function up(knex) {
  const n = await knex('profiles')
    .whereNull('children_count').orWhere('children_count', '')
    .update({ children_count: 0 })
  console.log(`029: children_count set to 0 on ${n} profile(s)`)
}

export async function down() {}
