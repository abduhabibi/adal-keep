// src/migrations/024_create_settings_table.js

export async function up(knex) {
  return knex.schema.createTable('settings', (table) => {
    table.increments('id').primary();
    table.string('key').notNullable().unique(); // e.g., 'agency_email'
    table.text('value').nullable(); // e.g., 'admin@adalkeep.com'
    table.timestamps(true, true);
  });
}

export async function down(knex) {
  return knex.schema.dropTable('settings');
}