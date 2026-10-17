export async function up(knex) {
  const hasDocType = await knex.schema.hasColumn('tasks', 'document_type');
  if (!hasDocType) {
    await knex.schema.alterTable('tasks', (table) => {
      table.string('document_type');
      table.string('source_file');
    });
  }
}

export async function down(knex) {
  const hasDocType = await knex.schema.hasColumn('tasks', 'document_type');
  if (hasDocType) {
    await knex.schema.alterTable('tasks', (table) => {
      table.dropColumn('document_type');
      table.dropColumn('source_file');
    });
  }
}
