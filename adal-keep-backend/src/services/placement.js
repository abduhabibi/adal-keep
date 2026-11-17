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
  // Only out of Passport (a photo picked into the wrong box). A face cut from
  // the passport looks like "a passport" to JEV: a picture in Photo or Full
  // Body Photo never moves (2026-11-17: ten head photos went to Passport).
  if (fieldName !== 'Passport' || kind === 'passport') return { act: 'stay' }
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
    noteMove({ file: file.id, profile: profileId, from: fieldName, from_field: file.profile_field_id, to: d.to, at: new Date().toISOString() })
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
      // In Passport: the passport part takes the combined picture's place (it
      // reads better too); the picture itself stays on the disk.
      if (fieldName === 'Passport' && parts.passport && file.profile_field_id) {
        const name = `${Date.now()}_passport-${String(file.original_name || 'picture').replace(/\.[^.]+$/, '')}.jpg`
        fs.copyFileSync(parts.passport, path.join(SAFE_STORAGE_DIR, name))
        const now = new Date().toISOString()
        await db('files').insert({ profile_field_id: file.profile_field_id, original_name: name.replace(/^\d+_/, ''), path: name, mimetype: 'image/jpeg', size: fs.statSync(parts.passport).size, content_hash: crypto.createHash('sha256').update(fs.readFileSync(parts.passport)).digest('hex'), created_at: now, updated_at: now })
        await db('files').where('id', file.id).del()   // its row only: the picture stays on the disk (path noted below)
        noteMove({ file: file.id, profile: profileId, from: 'Passport', from_field: file.profile_field_id, to: 'replaced by its passport part', kept: file.path, original_name: file.original_name, at: now })
        done.push('Passport')
        import('./verification.js').then(v => v.runPassportVerification(Number(profileId), { handle: db })).catch(() => {})
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
  try { await undoWrongMoves(db, { log }) } catch (e) { log('[placement] undo:', e.message) }
  let seen = new Set()
  try { seen = new Set(JSON.parse(fs.readFileSync(seenFile, 'utf8'))) } catch {}
  const since = new Date(Date.now() - days * 864e5).toISOString()
  const rows = await db('files as f').join('profile_fields as pf', 'pf.id', 'f.profile_field_id')
    .where('pf.name', 'Passport').where('f.mimetype', 'like', 'image/%').where('f.created_at', '>', since)
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

// Every move is written down (data/placement-moves.json) so it can be undone.
const MOVES = () => import('path').then(p => p.default.join(p.default.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', 'data', 'placement-moves.json'))
function noteMove(m) {
  MOVES().then(async f => {
    const fs = (await import('fs')).default
    let list = []
    try { list = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
    list.push(m)
    fs.writeFileSync(f, JSON.stringify(list.slice(-2000), null, 1))
  }).catch(() => {})
}

/**
 * Once on each PC: what the first version of this (2026-11-17, morning) got
 * wrong is put back — a head photo cut from her passport ("…-Musaned-Photo",
 * "…_photo.jpg") moved into Passport goes back to Photo.
 */
export async function undoWrongMoves(db, { log = console.log } = {}) {
  const fs = (await import('fs')).default, path = (await import('path')).default
  const flag = path.join(path.dirname(await MOVES()), 'placement-undo-1.json')
  if (fs.existsSync(flag)) return 0
  const rows = await db('files as f').join('profile_fields as pf', 'pf.id', 'f.profile_field_id')
    .where('pf.name', 'Passport').where('f.mimetype', 'like', 'image/%')
    .where(q => q.where('f.original_name', 'like', '%Musaned-Photo%').orWhere('f.original_name', 'like', '%_photo.jpg').orWhere('f.original_name', 'like', '%_photo.png'))
    .whereRaw('f.created_at < f.updated_at')
    .select('f.id', 'pf.profile_id')
  let n = 0
  for (const r of rows) {
    const to = await fieldOf(db, r.profile_id, 'Photo')
    await db('files').where('id', r.id).update({ profile_field_id: to.id, updated_at: new Date().toISOString() })
    n++
  }
  fs.writeFileSync(flag, JSON.stringify({ at: new Date().toISOString(), moved_back: n }))
  if (n) log(`[placement] ${n} head photo(s) moved into Passport by mistake were put back into Photo`)
  return n
}
