export async function up(knex) {
  const tableInfo = await knex.raw("PRAGMA table_info(profiles)");
  const columns = tableInfo.map(row => row.name);
  
  // Add missing columns one by one
  if (!columns.includes('assigned_to')) {
    await knex.schema.alterTable('profiles', t => t.integer('assigned_to').nullable());
    console.log('✅ Added assigned_to to profiles');
  }
  
  if (!columns.includes('created_by')) {
    await knex.schema.alterTable('profiles', t => t.string('created_by').defaultTo('System'));
    console.log('✅ Added created_by to profiles');
  }
  
  if (!columns.includes('date_of_birth')) {
    await knex.schema.alterTable('profiles', t => t.date('date_of_birth').nullable());
    console.log('✅ Added date_of_birth to profiles');
  }
  
  if (!columns.includes('nationality')) {
    await knex.schema.alterTable('profiles', t => t.string('nationality').defaultTo('Ethiopian'));
    console.log('✅ Added nationality to profiles');
  }
  
  if (!columns.includes('updated_at')) {
    await knex.schema.alterTable('profiles', t => t.timestamp('updated_at').defaultTo(knex.fn.now()));
    console.log('✅ Added updated_at to profiles');
  }
}

export async function down(knex) {
  // Safe to leave columns, don't drop them
}
