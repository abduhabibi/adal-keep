export async function up(knex) {
  // Check and add each column individually
  const tableInfo = await knex.schema.raw("PRAGMA table_info(tasks)");
  const columns = tableInfo.map(row => row.name);
  
  if (!columns.includes('is_ai_created')) {
    await knex.schema.alterTable('tasks', (table) => {
      table.boolean('is_ai_created').defaultTo(false);
    });
    console.log('✅ Added is_ai_created column');
  }
  
  if (!columns.includes('document_type')) {
    await knex.schema.alterTable('tasks', (table) => {
      table.string('document_type');
    });
    console.log('✅ Added document_type column');
  }
  
  if (!columns.includes('source_file')) {
    await knex.schema.alterTable('tasks', (table) => {
      table.string('source_file');
    });
    console.log('✅ Added source_file column');
  }
}

export async function down(knex) {
  await knex.schema.alterTable('tasks', (table) => {
    table.dropColumn('is_ai_created');
    table.dropColumn('document_type');
    table.dropColumn('source_file');
  });
}
