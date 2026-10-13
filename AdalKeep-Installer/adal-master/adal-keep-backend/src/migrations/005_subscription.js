export async function up(knex) {
  await knex.schema.createTable('subscriptions', (table) => {
    table.increments('id').primary()
    table.string('fingerprint').notNullable().unique()
    table.string('client_name')
    table.string('plan').defaultTo('monthly') // monthly, yearly
    table.timestamp('trial_start').notNullable()
    table.timestamp('trial_end').notNullable()
    table.timestamp('paid_until').nullable()
    table.string('payment_ref').nullable()
    table.boolean('approved').defaultTo(false)
    table.string('status').defaultTo('trial') // trial, active, expired, locked
    table.timestamps(true, true)
  })

  await knex.schema.createTable('subscription_payments', (table) => {
    table.increments('id').primary()
    table.integer('subscription_id').references('id').inTable('subscriptions')
    table.string('payment_ref').notNullable()
    table.string('method').notNullable() // telebirr, cbe
    table.decimal('amount', 10, 2)
    table.boolean('verified').defaultTo(false)
    table.timestamp('verified_at').nullable()
    table.timestamps(true, true)
  })
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('subscription_payments')
  await knex.schema.dropTableIfExists('subscriptions')
}