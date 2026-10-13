export async function up(knex) {
  const exists = await knex.schema.hasTable('profiles');
  if (!exists) {
    await knex.schema.createTable('profiles', (table) => {
      table.increments('id').primary();
      table.string('full_name');
      table.string('passport_number').unique().nullable();
      table.string('national_id').unique().nullable();
      table.string('phone_number').nullable();
      table.date('date_of_birth').nullable();
      table.string('nationality').defaultTo('Ethiopian');
      table.integer('assigned_to').nullable();
      table.string('created_by').defaultTo('System');
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
    console.log('✅ Created profiles table');
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('profiles');
}
