export async function up(knex) {
  const cols = (await knex.raw('PRAGMA table_info(profiles)')).map(c => c.name)
  const add = async (n, fn) => { if (!cols.includes(n)) await knex.schema.alterTable('profiles', fn) }

  await add('religion',             t => t.string('religion'))
  await add('marital_status',       t => t.string('marital_status'))
  await add('children_count',       t => t.integer('children_count'))
  await add('weight',               t => t.string('weight'))
  await add('height',               t => t.string('height'))
  await add('complexion',           t => t.string('complexion'))
  await add('living_town',          t => t.string('living_town'))
  await add('mother_name',          t => t.string('mother_name'))
  await add('father_name',          t => t.string('father_name'))
  await add('spouse_name',          t => t.string('spouse_name'))
  await add('education_level',      t => t.string('education_level'))
  await add('speaks_english',       t => t.boolean('speaks_english').defaultTo(false))
  await add('speaks_arabic',        t => t.boolean('speaks_arabic').defaultTo(false))
  await add('skills',               t => t.text('skills'))
  await add('previous_employment',  t => t.text('previous_employment'))
  await add('full_body_photo_path', t => t.string('full_body_photo_path'))

  // Extra field template for full-body photo
  await knex('field_templates')
    .insert({ name: 'Full Body Photo', data_type: 'file', is_permanent: true })
    .onConflict('name').ignore()

  await knex.schema.createTableIfNotExists('cv_templates', t => {
    t.increments('id').primary()
    t.string('name').notNullable()
    t.string('agency_name')
    t.string('agency_name_ar')
    t.string('logo_path')
    t.integer('salary')
    t.string('currency').defaultTo('SAR')
    t.string('country')
    t.integer('contract_years').defaultTo(2)
    t.text('html_content')
    t.text('css_content')
    t.text('placeholders')
    t.string('source_file')
    t.boolean('is_active').defaultTo(true)
    t.timestamps(true, true)
  })

  await knex.schema.createTableIfNotExists('generated_cvs', t => {
    t.increments('id').primary()
    t.integer('profile_id').references('profiles.id')
    t.integer('template_id').references('cv_templates.id')
    t.string('filename')
    t.text('data_snapshot')
    t.string('pdf_path')
    t.string('created_by')
    t.timestamps(true, true)
  })

  console.log('014: profiles extended, cv_templates + generated_cvs created')
}
export async function down(knex) {
  await knex.schema.dropTableIfExists('generated_cvs')
  await knex.schema.dropTableIfExists('cv_templates')
}
