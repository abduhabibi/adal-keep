/**
 * feature_use: how often each Adal Keep feature is used, one row per day and
 * feature (services/featureUse.js). Only counts — no names, no profiles.
 */
export async function up(knex) {
  if (!(await knex.schema.hasTable('feature_use'))) {
    await knex.schema.createTable('feature_use', t => {
      t.string('day').notNullable()        // YYYY-MM-DD, local time
      t.string('feature').notNullable()
      t.integer('count').notNullable().defaultTo(0)
      t.primary(['day', 'feature'])
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('feature_use')
}
