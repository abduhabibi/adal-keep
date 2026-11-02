/**
 * WhatsApp agents (Settings → WhatsApp): the Saudi agents the agency sends CVs
 * to, each with its CV template(s) and the name of its office on Musaned; and
 * every CV sent, so a girl chosen by one agent is taken back from the others.
 */
export async function up(knex) {
  if (!(await knex.schema.hasTable('whatsapp_agents'))) {
    await knex.schema.createTable('whatsapp_agents', t => {
      t.increments('id')
      t.string('name').notNullable()
      t.string('chat_id').notNullable()          // 9665…@c.us or a group …@g.us
      t.text('template_ids')                     // JSON [cv_template id, …]
      t.string('musaned_office')                 // its office as Musaned shows it (musaned_pro)
      t.boolean('active').defaultTo(true)
      t.timestamps(true, true)
    })
  }
  if (!(await knex.schema.hasTable('whatsapp_sends'))) {
    await knex.schema.createTable('whatsapp_sends', t => {
      t.increments('id')
      t.integer('profile_id').references('id').inTable('profiles').onDelete('CASCADE')
      t.integer('agent_id').references('id').inTable('whatsapp_agents').onDelete('CASCADE')
      t.integer('template_id')
      t.string('chat_id')
      t.string('message_id')                     // serialized WhatsApp message id
      t.string('status').defaultTo('sent')       // sent · chosen_here · withdrawn · marked · failed
      t.text('error')
      t.timestamp('sent_at')
      t.timestamp('closed_at')
      t.index(['profile_id'])
    })
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('whatsapp_sends')
  await knex.schema.dropTableIfExists('whatsapp_agents')
}
