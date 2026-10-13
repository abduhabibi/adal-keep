export function up(knex) {
  return knex.schema.createTable('tasks', (table) => {
    table.increments('id').primary();
    table.string('type'); // 'approval', 'verification', etc.
    table.string('document_type'); // 'passport', 'cv', 'id', 'contract', 'insurance'
    table.json('profile_data'); // Extracted data from AI
    table.string('source_file'); // Filename in SafeStorage
    table.string('status'); // 'pending', 'approved', 'declined'
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.timestamp('approved_at');
    table.timestamp('declined_at');
    table.text('decline_reason');
  });
}

export function down(knex) {
  return knex.schema.dropTable('tasks');
}
