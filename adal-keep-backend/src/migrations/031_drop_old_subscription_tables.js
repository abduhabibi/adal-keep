/**
 * The old telebirr/CBE subscription tables were never used (the licence now
 * lives in subscription.js). Dropped only when empty, so no record is lost.
 */
export async function up(knex) {
  for (const t of ['subscription_payments', 'subscriptions']) {
    if (!(await knex.schema.hasTable(t))) continue
    const [{ n }] = await knex(t).count('* as n')
    if (Number(n) === 0) await knex.schema.dropTable(t)
  }
}

export async function down() {}
