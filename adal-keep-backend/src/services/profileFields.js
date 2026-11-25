/**
 * profileFields.js — a profile's document fields with their files (her page,
 * GET /api/profiles/:id/fields). A permanent field she has no row for is made.
 */

// The document fields not used for now: kept (with any file in them), not offered.
// Medical Report and Labour ID too (asked on 2026-11-19): Wafid's result and the Labor ID live on the profile itself.
export const HIDDEN_FIELDS = new Set(['COC', 'Saudi-letter', 'Musaned', 'Broker ID', 'Ticket-ongoing', 'Ticket-deported', 'Experience Form', 'Employee ID', 'Client ID', 'Medical Report', 'Labour ID'])

export async function profileFields(database, id) {
  const templates = await database('field_templates').where('is_permanent', true).orderBy('id')

  const forcedFields = ['Photo', 'Self Video']
  for (const f of forcedFields) {
    const exists = templates.some(t => t.name === f)
    if (!exists) {
      const [newTpl] = await database('field_templates').insert({
        name: f,
        data_type: 'file',
        is_permanent: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).returning('*')
      templates.push(newTpl)
    }
  }

  // Her fields and their files in two reads (one each per template was 60 reads for every click on her).
  // A profile can hold the same field twice: its files count whichever copy they are in.
  const rows = await database('profile_fields').where('profile_id', id).orderBy('id')
  const copiesOf = new Map()
  for (const r of rows) { if (copiesOf.has(r.name)) copiesOf.get(r.name).push(r); else copiesOf.set(r.name, [r]) }
  const filesOf = new Map()
  for (const f of rows.length ? await database('files').whereIn('profile_field_id', rows.map(r => r.id)).orderBy('id')
    .select('id', 'original_name', 'path', 'mimetype', 'size', 'profile_field_id') : []) {
    const { profile_field_id, ...file } = f
    if (filesOf.has(profile_field_id)) filesOf.get(profile_field_id).push(file); else filesOf.set(profile_field_id, [file])
  }

  const result = []
  for (const template of templates) {
    // Not used now (asked on 2026-11-09): shown only when she already has a file in it.
    const hidden = HIDDEN_FIELDS.has(template.name)
    const copies = copiesOf.get(template.name) || []
    let field = copies[0]

    if (!field && hidden) continue
    if (!field) {
      const [newFieldId] = await database('profile_fields').insert({
        profile_id: id,
        field_template_id: template.id,
        name: template.name,
        data_type: template.data_type,
        is_permanent: true,
      })
      field = { id: newFieldId, name: template.name, data_type: template.data_type, is_permanent: true }
    }

    const files = (copies.length ? copies : [field]).flatMap(c => filesOf.get(c.id) || []).sort((a, b) => a.id - b.id)

    if (hidden && !files.length) continue
    result.push({ ...field, files })
  }
  return result
}
