import knex from 'knex'

const db = knex({
  client: 'sqlite3',
  connection: {
    filename: './data.sqlite'
  },
  useNullAsDefault: true
})

const PERMANENT_FIELDS = [
  'Government ID', 'Passport', 'CV', 'Contract', 'Medical Report',
  'Insurance', 'COC', 'Visa', 'Saudi-letter', 'Musaned',
  'Broker ID', 'Ticket-ongoing', 'Ticket-deported', 'Police Clearance',
  'Labour ID', 'Slip', 'Experience Form', 'Employee ID', 'Client ID'
]

async function addFields() {
  try {
    // Get all profiles
    const profiles = await db('profiles').select('id')
    console.log(`Found ${profiles.length} profiles`)

    for (const profile of profiles) {
      // Check if fields already exist for this profile
      const existing = await db('profile_fields')
        .where('profile_id', profile.id)
        .count('id as count')
        .first()
      
      if (existing.count > 0) {
        console.log(`Profile ${profile.id} already has fields, skipping...`)
        continue
      }

      // Add permanent fields for this profile
      for (const fieldName of PERMANENT_FIELDS) {
        await db('profile_fields').insert({
          profile_id: profile.id,
          name: fieldName,
          data_type: fieldName.includes('ID') ? 'text' : 'file',
          is_permanent: true,
          value_text: fieldName.includes('ID') ? Math.floor(1000 + Math.random() * 9000).toString() : null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      }
      console.log(`Added fields for profile ${profile.id}`)
    }
    
    console.log('✅ All fields added successfully!')
  } catch (error) {
    console.error('Error adding fields:', error)
  } finally {
    await db.destroy()
  }
}

addFields()
