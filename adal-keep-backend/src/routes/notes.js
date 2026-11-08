/**
 * Notes page: the notes written there (alone or about one person), and — to
 * see everything in one place — what is written in the checklists' own text
 * columns and in each profile's notes. One read for the whole page.
 */
import express from 'express'
import { moveToTrash, restore, whoFrom } from '../services/trash.js'

const router = express.Router()
const now = () => new Date().toISOString()

router.get('/notes', async (req, res) => {
  try {
    const db = req.app.locals.db
    const notes = await db('notes').leftJoin('profiles', 'notes.profile_id', 'profiles.id')
      .select('notes.*', 'profiles.full_name', 'profiles.passport_number')
      .orderBy([{ column: 'notes.done', order: 'asc' }, { column: 'notes.id', order: 'desc' }]).limit(2000)
    // The checklists' text columns that have something written.
    const lists = await db('checklists').select('id', 'name', 'columns')
    const textCols = new Map()
    for (const c of lists) {
      let cols = []
      try { cols = c.columns ? JSON.parse(c.columns) : [] } catch {}
      textCols.set(c.id, { name: c.name, cols: new Set(cols.filter(x => x.kind === 'own' && x.type === 'text').map(x => x.key)) })
    }
    const cells = (await db('checklist_cells').join('profiles', 'checklist_cells.profile_id', 'profiles.id')
      .whereNot('checklist_cells.value', '').whereNotNull('checklist_cells.value')
      .select('checklist_cells.checklist_id', 'checklist_cells.profile_id', 'checklist_cells.column', 'checklist_cells.value', 'profiles.full_name')
      .limit(5000))
      .filter(c => textCols.get(c.checklist_id)?.cols.has(c.column))
      .map(c => ({ ...c, checklist_name: textCols.get(c.checklist_id).name }))
    const onProfiles = await db('profiles').whereNotNull('notes').whereNot('notes', '')
      .select('id as profile_id', 'full_name', 'notes').limit(2000)
    res.json({ notes, checklists: cells, profiles: onProfiles })
  } catch (e) {
    console.error('[notes]', e)
    res.status(500).json({ error: 'Could not load the notes' })
  }
})

router.post('/notes', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 4000)
    if (!text) return res.status(400).json({ error: 'Write the note first' })
    const profile_id = Number(req.body?.profile_id) || null
    const row = { text, profile_id, done: 0, created_by: whoFrom(req).deleted_by || null, created_at: now(), updated_at: now() }
    const [id] = await req.app.locals.db('notes').insert(row)
    res.status(201).json({ id, ...row })
  } catch (e) {
    res.status(500).json({ error: 'Could not save the note' })
  }
})

router.put('/notes/:id', async (req, res) => {
  try {
    const patch = { updated_at: now() }
    if (req.body?.text != null) patch.text = String(req.body.text).trim().slice(0, 4000)
    if (req.body?.done != null) patch.done = req.body.done ? 1 : 0
    if ('profile_id' in (req.body || {})) patch.profile_id = Number(req.body.profile_id) || null
    if (patch.text === '') return res.status(400).json({ error: 'A note cannot be empty' })
    await req.app.locals.db('notes').where('id', req.params.id).update(patch)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Could not save the note' })
  }
})

// To the Trash (Undo on the page brings it back from there).
router.delete('/notes/:id', async (req, res) => {
  try {
    const t = await moveToTrash(req.app.locals.db, 'note', req.params.id, req)
    res.json({ success: true, trash_id: t?.id ?? t ?? null })
  } catch (e) {
    res.status(500).json({ error: 'Could not delete the note' })
  }
})

// Undo of a delete, from anywhere (phones too): only a note comes back this way.
router.post('/notes/undo/:trashId', async (req, res) => {
  try {
    const db = req.app.locals.db
    const t = await db('trash').where('id', Number(req.params.trashId)).first()
    if (t?.kind !== 'note') return res.status(404).json({ error: 'Not a deleted note' })
    await restore(db, t.id)
    res.json({ success: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// A profile's own notes field, written from the Notes page.
router.put('/notes/profile/:id', async (req, res) => {
  try {
    await req.app.locals.db('profiles').where('id', req.params.id).update({ notes: String(req.body?.notes ?? '').slice(0, 4000), updated_at: now() })
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: 'Could not save' })
  }
})

export default router
