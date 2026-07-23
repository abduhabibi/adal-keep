import db from '../config/database.js'
import { logActivity } from '../services/activityLog.js'
import { saveFile } from '../services/storage.js'

function sessionUserId(req) {
  return req.session.userId || null
}

export async function addField(req, res) {
  const { profile_id } = req.params
  const { name, data_type, is_permanent, value_text, value_number } = req.body

  try {
    let template_id = null
    if (is_permanent) {
      const existing = await db('field_templates')
        .where({ name, data_type })
        .first()
      if (existing) {
        template_id = existing.id
      } else {
        const [newTemplate] = await db('field_templates')
          .insert({ name, data_type, created_by: sessionUserId(req) })
          .returning('*')
        template_id = newTemplate.id
      }
    }

    const [newField] = await db('profile_fields')
      .insert({
        profile_id,
        field_template_id: template_id,
        name,
        data_type,
        is_permanent: is_permanent || false,
        value_text: value_text || null,
        value_number: value_number || null,
        created_by: sessionUserId(req),
      })
      .returning('*')

    await logActivity(sessionUserId(req), 'create', 'field', newField.id, {
      profile_id,
      name,
    })

    res.status(201).json(newField)
  } catch (err) {
    res.status(500).json({ error: 'Failed to add field' })
  }
}

export async function updateField(req, res) {
  const { profile_id, fieldId } = req.params
  const { value_text, value_number, is_permanent } = req.body

  try {
    const field = await db('profile_fields').where({ id: fieldId, profile_id }).first()
    if (!field) return res.status(404).json({ error: 'Field not found' })

    const oldTemplateId = field.field_template_id
    const updateData = {
      value_text: value_text !== undefined ? value_text : field.value_text,
      value_number: value_number !== undefined ? value_number : field.value_number,
      updated_at: db.fn.now(),
    }

    if (typeof is_permanent === 'boolean' && is_permanent !== field.is_permanent) {
      updateData.is_permanent = is_permanent
      if (is_permanent) {
        let template = await db('field_templates')
          .where({ name: field.name, data_type: field.data_type })
          .first()
        if (!template) {
          const inserted = await db('field_templates')
            .insert({ name: field.name, data_type: field.data_type, created_by: sessionUserId(req) })
          updateData.field_template_id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]
        } else {
          updateData.field_template_id = template.id
        }
      } else {
        updateData.field_template_id = null
      }
    }

    await db('profile_fields').where({ id: fieldId, profile_id }).update(updateData)
    await logActivity(sessionUserId(req), 'update', 'field', fieldId, { profile_id })

    if (oldTemplateId && updateData.field_template_id === null) {
      const remainingLinks = await db('profile_fields')
        .where({ field_template_id: oldTemplateId })
        .count('id as count')
        .first()

      if (parseInt(remainingLinks.count || 0, 10) === 0) {
        try {
          await db('field_templates').where({ id: oldTemplateId }).del()
        } catch (dbErr) {
          console.warn('Template deletion deferred:', dbErr.message)
        }
      }
    }

    const updated = await db('profile_fields').where({ id: fieldId }).first()
    return res.json(updated)

  } catch (err) {
    console.error('Database Operation Failure:', err)
    return res.status(500).json({ error: 'Failed to update field' })
  }
}

export async function deleteField(req, res) {
  const { profile_id, fieldId } = req.params
  try {
    const field = await db('profile_fields').where({ id: fieldId, profile_id }).first()
    if (!field) return res.status(404).json({ error: 'Field not found' })

    const templateId = field.field_template_id

    await db('profile_fields').where({ id: fieldId, profile_id }).del()
    await logActivity(sessionUserId(req), 'delete', 'field', fieldId, { profile_id })

    if (templateId) {
      const remainingLinks = await db('profile_fields')
        .where({ field_template_id: templateId })
        .count('id as count')
        .first()

      if (parseInt(remainingLinks.count, 10) === 0) {
        try {
          await db('field_templates').where({ id: templateId }).del()
        } catch (dbErr) {
          console.warn('Template deletion skipped on field removal', dbErr)
        }
      }
    }

    res.json({ message: 'Field deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete field' })
  }
}

export async function listFieldTemplates(req, res) {
  try {
    const templates = await db('field_templates')
      .select('id', 'name', 'data_type')
      .orderBy('name', 'asc')
    res.json(templates)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load templates' })
  }
}

export async function uploadFile(req, res) {
  const { profile_id, fieldId } = req.params
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

  try {
    const fileRecord = await saveFile(
      fieldId,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      sessionUserId(req)
    )
    await logActivity(sessionUserId(req), 'upload', 'file', fileRecord.id, {
      fieldId,
      profile_id,
    })
    res.status(201).json(fileRecord)
  } catch (err) {
    res.status(500).json({ error: 'Upload failed' })
  }
}