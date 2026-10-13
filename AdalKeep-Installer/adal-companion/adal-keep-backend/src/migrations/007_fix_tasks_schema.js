export async function up(knex) {
  // Helper to check if column exists
  const hasCol = async (col) => {
    const res = await knex.raw(`PRAGMA table_info(tasks)`);
    return res.some(c => c.name === col);
  };

  if (!(await hasCol('payload'))) await knex.schema.alterTable('tasks', t => t.text('payload'));
  if (!(await hasCol('description'))) await knex.schema.alterTable('tasks', t => t.text('description'));
  if (!(await hasCol('priority'))) await knex.schema.alterTable('tasks', t => t.string('priority').defaultTo('medium'));
  if (!(await hasCol('due_date'))) await knex.schema.alterTable('tasks', t => t.date('due_date'));
  if (!(await hasCol('assigned_to'))) await knex.schema.alterTable('tasks', t => t.integer('assigned_to'));
  if (!(await hasCol('created_by'))) await knex.schema.alterTable('tasks', t => t.string('created_by').defaultTo('System'));
  if (!(await hasCol('company_id'))) await knex.schema.alterTable('tasks', t => t.integer('company_id').defaultTo(1));
  if (!(await hasCol('profile_id'))) await knex.schema.alterTable('tasks', t => t.integer('profile_id'));
  if (!(await hasCol('updated_at'))) await knex.schema.alterTable('tasks', t => t.timestamp('updated_at').defaultTo(knex.fn.now()));
  
  console.log('✅ All missing columns added to tasks table!');
}

export async function down(knex) {
  // We won't drop them to avoid breaking things, just leave them.
}
