export async function up(knex) {
  await knex.schema
    .createTableIfNotExists('license', (table) => {
      table.increments('id').primary()
      table.string('fingerprint').unique()
      table.string('dev_password_hash') // Hashed, not plain text
      table.timestamp('created_at').defaultTo(knex.fn.now())
    })
    .createTableIfNotExists('profiles', (table) => {
      table.increments('id').primary()
      table.string('full_name')
      table.string('phone_number')
      table.string('national_id')
      table.string('passport_number')
      table.string('status').defaultTo('pending')
      table.string('room')
      table.string('table_name')
      table.string('box_number')
      table.integer('broker_id').nullable()
      table.string('notes')
      table.string('photo_path')
      table.timestamp('editing_started_at')
      table.timestamps(true, true)
    })
    .createTableIfNotExists('brokers', (table) => {
      table.increments('id').primary()
      table.string('name')
      table.string('logo')
      table.string('address')
      table.string('contact1')
      table.string('contact2')
      table.string('notes')
      table.timestamps(true, true)
    })
    .createTableIfNotExists('profile_fields', (table) => {
      table.increments('id').primary()
      table.integer('profile_id')
      table.integer('field_template_id')
      table.string('name')
      table.string('data_type')
      table.boolean('is_permanent').defaultTo(false)
      table.text('value_text')
      table.timestamps(true, true)
    })
    .createTableIfNotExists('files', (table) => {
      table.increments('id').primary()
      table.integer('profile_field_id')
      table.string('original_name')
      table.string('path')
      table.string('mimetype')
      table.integer('size')
      table.timestamps(true, true)
    })
}

export async function down(knex) {
  await knex.schema
    .dropTableIfExists('files')
    .dropTableIfExists('profile_fields')
    .dropTableIfExists('brokers')
    .dropTableIfExists('profiles')
    .dropTableIfExists('license')
}