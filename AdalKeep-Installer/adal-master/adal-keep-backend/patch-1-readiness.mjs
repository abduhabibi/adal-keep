import fs from 'fs'
const p = 'src/routes/cv.js'
let s = fs.readFileSync(p, 'utf8')

if (s.includes('can_generate')) { console.log('already patched'); process.exit(0) }

const startMarker = "router.get('/profile-readiness/:profileId'"
const startIdx = s.indexOf(startMarker)
if (startIdx === -1) { console.error('route not found'); process.exit(1) }

// Find the matching closing brace of this handler by brace counting
let i = s.indexOf('{', startIdx)
let depth = 1
let j = i + 1
while (j < s.length && depth > 0) {
  if (s[j] === '{') depth++
  else if (s[j] === '}') depth--
  j++
}
if (depth !== 0) { console.error('unbalanced braces'); process.exit(1) }

const newHandler = `router.get('/profile-readiness/:profileId', async (req, res) => {
  try {
    const db = req.app.locals.db
    const profileId = Number(req.params.profileId)
    const profile = await db('profiles').where('id', profileId).first()
    if (!profile) return res.status(404).json({ error: 'Profile not found' })

    const required = ['full_name','first_name','last_name','passport_number','date_of_birth','place_of_birth','nationality','gender','religion','marital_status','children_count','weight','height','living_town','phone_number']
    const missing = required.filter(k => {
      const v = profile[k]
      return v === null || v === undefined || v === ''
    })

    const counts = await db('profile_fields')
      .leftJoin('files', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', profileId)
      .groupBy('profile_fields.name')
      .select('profile_fields.name')
      .count('files.id as file_count')

    const fileMap = {}
    for (const row of counts) fileMap[row.name] = Number(row.file_count || 0)

    const has_photo = (fileMap['Photo'] || 0) > 0 || !!profile.photo_path
    const has_full_body_photo = (fileMap['Full Body Photo'] || 0) > 0

    let skillsObj = {}
    try { skillsObj = typeof profile.skills === 'string' ? JSON.parse(profile.skills) : (profile.skills || {}) } catch {}
    const has_any_skill = Object.values(skillsObj).some(Boolean)

    const cv_blockers = []
    if (!profile.broker_id) cv_blockers.push('Broker not assigned')
    if (!has_photo) cv_blockers.push('Photo missing')
    if (!has_full_body_photo) cv_blockers.push('Full body photo missing')
    if (!profile.labor_id || !String(profile.labor_id).trim()) cv_blockers.push('Labor ID missing')
    if (!has_any_skill) cv_blockers.push('No skills selected')
    if (!profile.religion) cv_blockers.push('Religion missing')
    if (!profile.marital_status) cv_blockers.push('Marital status missing')

    const can_generate = cv_blockers.length === 0

    console.log('[CV readiness] profile', profileId, 'can:', can_generate)

    res.json({
      profile, missing, has_photo, has_full_body_photo,
      field_file_counts: fileMap,
      missing_photos: [
        !has_photo ? 'Photo' : null,
        !has_full_body_photo ? 'Full Body Photo' : null,
      ].filter(Boolean),
      cv_blockers, can_generate,
    })
  } catch (e) {
    console.error('[CV] readiness error:', e.message)
    res.status(500).json({ error: e.message })
  }
})`

s = s.slice(0, startIdx) + newHandler + s.slice(j)
fs.writeFileSync(p, s)
console.log('✓ readiness endpoint enhanced with can_generate')
