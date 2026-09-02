export async function up(knex) {
  const permanentFields = [
    'Government ID',
    'Passport',
    'CV',
    'Contract',
    'Medical Report',
    'Insurance',
    'COC',
    'Visa',
    'Saudi-letter',
    'Musaned',
    'Broker ID',
    'Ticket-ongoing',
    'Ticket-deported',
    'Police Clearance',
    'Labour ID',
    'Slip',
    'Experience Form',
    'Employee ID',
    'Client ID',
    'Self Video',
    'Photo',
  ]

  // Create field_templates table if not exists
  await knex.schema.createTableIfNotExists('field_templates', (table) => {
    table.increments('id').primary()
    table.string('name').unique()
    table.string('data_type').defaultTo('file') // 'text' or 'file'
    table.boolean('is_permanent').defaultTo(true)
    table.timestamps(true, true)
  })

  // Insert the 19 permanent field templates
  for (const fieldName of permanentFields) {
    await knex('field_templates')
      .insert({
        name: fieldName,
        data_type: 'file',
        is_permanent: true,
      })
      .onConflict('name')
      .ignore()
  }

  // Auto-create these fields for existing profiles
  const existingProfiles = await knex('profiles').select('id')
  
  for (const profile of existingProfiles) {
    for (const fieldName of permanentFields) {
      const template = await knex('field_templates').where('name', fieldName).first()
      
      const exists = await knex('profile_fields')
        .where('profile_id', profile.id)
        .andWhere('name', fieldName)
        .first()

      if (!exists && template) {
        await knex('profile_fields').insert({
          profile_id: profile.id,
          field_template_id: template.id,
          name: fieldName,
          data_type: 'file',
          is_permanent: true,
        })
      }
    }
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('field_templates')
}