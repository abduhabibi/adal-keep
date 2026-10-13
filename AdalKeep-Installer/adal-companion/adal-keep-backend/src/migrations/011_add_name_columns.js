export async function up(knex) {
  const hasFirstName = await knex.schema.hasColumn('profiles', 'first_name');
  const hasLastName = await knex.schema.hasColumn('profiles', 'last_name');

  if (!hasFirstName || !hasLastName) {
    await knex.schema.alterTable('profiles', (table) => {
      if (!hasFirstName) table.string('first_name').nullable();
      if (!hasLastName) table.string('last_name').nullable();
    });
    console.log('✅ Added first_name and last_name columns to profiles table!');
  }
}

export async function down(knex) {
  // Safe to leave them
}
