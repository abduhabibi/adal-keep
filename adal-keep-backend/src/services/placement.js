/**
 * placement.js — a picture put into the wrong box goes to the right one
 * (asked on 2026-11-17: a photo picked on the phone landed in Passport).
 *
 * After a picture is put into Passport, Photo or Full Body Photo (by hand, on
 * the PC or the phone), JEV says what it shows. Nothing is at a fixed place:
 *   - a passport, a head photo or a standing photo in another box → moved to its box;
 *   - several things side by side → the photo and the standing photo are cut
 *     out into their boxes (the picture stays where it was put).
 * Only a clear answer moves anything; otherwise the file stays as it was.
 */
import { resolveStoredPath } from './cvRender.js'

export const BOXES = { passport: 'Passport', photo: 'Photo', fullbody: 'Full Body Photo' }
const KIND_OF = { Passport: 'passport', Photo: 'photo', 'Full Body Photo': 'fullbody' }
export const watched = (fieldName) => !!KIND_OF[fieldName]

const QUESTION = ['What does this picture show?', {
  passport: 'A passport: its open data page (a small printed photo, name, dates, the machine-readable lines), alone',
  photo: 'One person\'s head and shoulders: a portrait photo, alone (not inside a passport)',
  fullbody: 'One person standing, the whole body from head to feet, alone',
  several: 'Several of these side by side in one picture (a passport and separate photos of the person)',
  other: 'Something else (a form, a certificate, a CV, a slip…)',
}]

/** What to do with a picture put into `fieldName`, from JEV's answer. */
export function decide(fieldName, answer, { min = 0.7 } = {}) {
  const kind = answer?.choice, sure = (answer?.confidence ?? 0) >= min
  if (!kind || !sure || kind === 'other') return { act: 'stay' }
  if (kind === 'several') return { act: 'split' }
  if (KIND_OF[fieldName] === kind) return { act: 'stay' }
  return { act: 'move', to: BOXES[kind] }
}

async function fieldOf(db, profileId, name) {
  let f = await db('profile_fields').where({ profile_id: profileId, name }).first()
  if (f) return f
  const tpl = await db('field_templates').where('name', name).first()
  const now = new Date().toISOString()
  const [id] = await db('profile_fields').insert({ profile_id: profileId, field_template_id: tpl ? tpl.id : null, name, data_type: 'file', is_permanent: 1, created_at: now, updated_at: now })
  return { id, name }
}

/**
 * Checks one uploaded picture (a files row) in the background. Returns what
 * was done: { act: 'stay' | 'move' | 'split', to?, parts? }.
 */
export async function checkPlacement(db, profileId, fieldName, file, { choose = null, split = null, log = console.log } = {}) {
  if (!watched(fieldName) || !/^image\//.test(file?.mimetype || '')) return { act: 'stay' }
  const abs = resolveStoredPath(file.path)
  if (!abs) return { act: 'stay' }
  const sharp = (await import('sharp')).default
  const png = await sharp(abs).rotate().png().toBuffer()
  const ask = choose || (await import('./jevClassifier.js')).chooseOnPage
  const answer = (await ask(png, { what: QUESTION }))?.what
  const d = decide(fieldName, answer)
  if (d.act === 'move') {
    const to = await fieldOf(db, profileId, d.to)
    await db('files').where('id', file.id).update({ profile_field_id: to.id, updated_at: new Date().toISOString() })
    log(`[placement] profile #${profileId}: a ${answer.choice} put into ${fieldName} — moved to ${d.to}`)
    return { ...d, from: fieldName }
  }
  if (d.act === 'split') {
    const cut = split || (await import('./composite.js')).splitComposite
    const parts = await cut(abs, { anyShape: true })
    if (!parts) return { act: 'stay' }
    const done = []
    try {
      const fs = (await import('fs')).default, path = (await import('path')).default, crypto = (await import('crypto')).default
      const { SAFE_STORAGE_DIR } = await import('./docPipeline.js')
      for (const k of ['photo', 'fullbody']) {
        if (!parts[k] || BOXES[k] === fieldName) continue
        const to = await fieldOf(db, profileId, BOXES[k])
        const hash = crypto.createHash('sha256').update(fs.readFileSync(parts[k])).digest('hex')
        if (await db('files').where({ profile_field_id: to.id, content_hash: hash }).first()) continue
        const name = `${Date.now()}_${k}-${String(file.original_name || 'picture').replace(/\.[^.]+$/, '')}.jpg`
        fs.copyFileSync(parts[k], path.join(SAFE_STORAGE_DIR, name))
        const now = new Date().toISOString()
        await db('files').insert({ profile_field_id: to.id, original_name: name.replace(/^\d+_/, ''), path: name, mimetype: 'image/jpeg', size: fs.statSync(parts[k]).size, content_hash: hash, created_at: now, updated_at: now })
        done.push(BOXES[k])
      }
    } finally { (await import('fs')).default.rmSync(parts.dir, { recursive: true, force: true }) }
    if (done.length) log(`[placement] profile #${profileId}: one picture with several things — ${done.join(' and ')} cut out of it`)
    return { act: 'split', parts: done }
  }
  return d
}

/**
 * Once after each start: the pictures put into these boxes in the last 7 days
 * that were never looked at (each looked at once; data/placement-checked.json).
 */
export async function sweepRecent(db, { days = 7, limit = 60, log = console.log } = {}) {
  const fs = (await import('fs')).default, path = (await import('path')).default
  const { fileURLToPath } = await import('url')
  const seenFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'placement-checked.json')
  let seen = new Set()
  try { seen = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8'))) } catch {}
  const since = new Date(Date.now() - days * 864e5).toISOString()
  const rows = await db('files as f').join('profile_fields as pf', 'pf.id', 'f.profile_field_id')
    .whereIn('pf.name', Object.values(BOXES)).where('f.mimetype', 'like', 'image/%').where('f.created_at', '>', since)
    .orderBy('f.id', 'desc').limit(limit).select('f.*', 'pf.name as field_name', 'pf.profile_id')
  let moved = 0
  for (const r of rows) {
    if (seen.has(r.id)) continue
    try { const d = await checkPlacement(db, r.profile_id, r.field_name, r, { log }); if (d.act !== 'stay') moved++ } catch (e) { log('[placement]', e.message); break }
    seen.add(r.id)
    try { fs.writeFileSync(seenFile, JSON.stringify([...seen].slice(-5000))) } catch {}
  }
  if (moved) log(`[placement] ${moved} picture(s) put in the wrong box were set right`)
}
