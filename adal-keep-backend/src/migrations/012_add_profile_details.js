export async function up(knex) {
  const hasCol = async (col) => (await knex.raw(`PRAGMA table_info(profiles)`)).some(c => c.name === col);
  
  if (!(await hasCol('gender'))) await knex.schema.alterTable('profiles', t => t.string('gender').nullable());
  if (!(await hasCol('passport_issue_date'))) await knex.schema.alterTable('profiles', t => t.string('passport_issue_date').nullable());
  if (!(await hasCol('passport_expiry_date'))) await knex.schema.alterTable('profiles', t => t.string('passport_expiry_date').nullable());
  if (!(await hasCol('passport_file'))) await knex.schema.alterTable('profiles', t => t.string('passport_file').nullable());
  
  console.log('✅ Added detail columns (gender, dates, passport_file) to profiles');
}
export async function down(knex) {}
