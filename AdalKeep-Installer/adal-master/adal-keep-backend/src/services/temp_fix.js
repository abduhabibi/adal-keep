    // 4. Create new profile if none exists
    const [newProfileId] = await db('profiles').insert({
      full_name: data.full_name || 'Unknown',
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      passport_number: data.passport_number || null,
      national_id: data.national_id || null,
      phone_number: data.phone_number || null,
      date_of_birth: data.date_of_birth || null,
      nationality: data.nationality || 'Ethiopian',
      passport_image: safeName, // Save the copied file path
      assigned_to: 1,
      created_by: 'AI-Auto',
      created_at: new Date().toISOString()
    })
