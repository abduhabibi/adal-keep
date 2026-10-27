/**
 * How long her medical (the Wafid slip) is valid — the battery on her profile:
 *   medical_valid_from   the slip's "Generated" date (YYYY-MM-DD)
 *   medical_valid_until  "Slip is valid only till" (YYYY-MM-DD)
 *   medical_alerts_sent  the warnings already given ("60", "30", "14", "7", "3", "1" days left)
 */
export async function up(knex) {
  for (const [col, make] of [
    ['medical_valid_from', t => t.string('medical_valid_from')],
    ['medical_valid_until', t => t.string('medical_valid_until')],
    ['medical_alerts_sent', t => t.text('medical_alerts_sent').defaultTo('[]')],
  ]) {
    if (!(await knex.schema.hasColumn('profiles', col))) await knex.schema.alterTable('profiles', make)
  }
}

export async function down() {}
