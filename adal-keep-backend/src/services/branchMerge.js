/**
 * branchMerge.js — bring another branch's Adal Keep into this main PC.
 *
 * When two branches each had their own Adal Keep, the main PC pulls the
 * other PC's data straight over the private link (Tailscale) or the office
 * network — nothing to carry on a USB stick:
 *
 *   branch PC   GET /api/branch/export          everything as one list
 *               GET /api/branch/export/file/:id each document's bytes
 *   main PC     preview → merge, in the background, with progress
 *
 * Nothing on the main PC is overwritten:
 *   - brokers match by name; a missing one is added;
 *   - profiles match by passport number (else name + phone); a matched
 *     profile only gets the details that are still EMPTY on the main PC;
 *   - documents are compared by their bytes, so the same scan is never
 *     copied twice; new ones are added to the matching field;
 *   - a profile the main PC does not have is added whole.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { storedPath } from './trash.js'
import { instanceId } from './mainPC.js'

const SAFE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'SafeStorage')
const PHOTO_COLS = ['photo_path', 'full_body_photo_path', 'passport_file']
const SKIP_COLS = new Set(['id', 'broker_id', 'created_at', 'updated_at', 'editing_started_at', 'assigned_to', 'created_by', 'company_id', 'branch_id', ...PHOTO_COLS])

// ── Branch side: what this PC has ────────────────────────────────────────────

export async function exportAll(db) {
  const brokers = await db('brokers').select('id', 'name', 'address', 'contact1', 'contact2', 'notes')
  const profiles = await db('profiles').select('*')
  const fields = await db('profile_fields').select('*')
  const files = await db('files').select('id', 'profile_field_id', 'original_name', 'mimetype', 'size', 'path')
  const filesBy = new Map()
  for (const f of files) {
    if (!storedPath(f.path)) continue // the file is missing on disk: nothing to send
    const list = filesBy.get(f.profile_field_id) || []
    list.push({ id: f.id, original_name: f.original_name, mimetype: f.mimetype, size: f.size })
    filesBy.set(f.profile_field_id, list)
  }
  const fieldsBy = new Map()
  for (const fl of fields) {
    const list = fieldsBy.get(fl.profile_id) || []
    list.push({ name: fl.name, data_type: fl.data_type, is_permanent: fl.is_permanent, value_text: fl.value_text, files: filesBy.get(fl.id) || [] })
    fieldsBy.set(fl.profile_id, list)
  }
  return {
    adal_branch_export: 1,
    instance: instanceId(),
    exported_at: new Date().toISOString(),
    brokers,
    profiles: profiles.map(p => ({
      ...p,
      photos: Object.fromEntries(PHOTO_COLS.filter(c => p[c] && storedPath(p[c])).map(c => [c, true])),
      fields: fieldsBy.get(p.id) || [],
    })),
  }
}

/** The stored path of an exported file or profile photo (null if unknown). */
export async function exportFilePath(db, id) {
  const f = await db('files').where('id', Number(id)).first()
  return f ? storedPath(f.path) : null
}
export async function exportPhotoPath(db, profileId, col) {
  if (!PHOTO_COLS.includes(col)) return null
  const p = await db('profiles').where('id', Number(profileId)).first()
  return p?.[col] ? storedPath(p[col]) : null
}

// ── Main side: pull and merge ────────────────────────────────────────────────

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
const passportKey = (p) => String(p.passport_number || '').trim().toUpperCase().replace(/\s+/g, '')
const namePhoneKey = (p) => (norm(p.full_name) && String(p.phone_number || '').trim()) ? `${norm(p.full_name)}|${String(p.phone_number).replace(/\D/g, '')}` : ''
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!r.ok) throw new Error(`${url} answered ${r.status}`)
  return r.json()
}
async function getBytes(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) })
  if (!r.ok) throw new Error(`${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

export async function fetchExport(source) {
  let data
  try { data = await getJSON(`${source}/api/branch/export`) } catch (e) {
    throw new Error(`Could not read the branch PC at ${source}: ${e.message}. Is it on, with Adal Keep open and Tailscale connected?`)
  }
  if (!data?.adal_branch_export) throw new Error(`${source} is not an Adal Keep that can share its data (update it first).`)
  if (data.instance === instanceId()) throw new Error('That address is this PC itself.')
  return data
}

/** Index what this PC already has, for matching. */
async function indexHere(db) {
  const profiles = await db('profiles').select('id', 'full_name', 'phone_number', 'passport_number')
  const byPassport = new Map(), byNamePhone = new Map()
  for (const p of profiles) {
    if (passportKey(p)) byPassport.set(passportKey(p), p.id)
    if (namePhoneKey(p)) byNamePhone.set(namePhoneKey(p), p.id)
  }
  const brokers = new Map((await db('brokers').select('id', 'name')).map(b => [norm(b.name), b.id]))
  return { byPassport, byNamePhone, brokers }
}
const matchOf = (idx, p) => (passportKey(p) && idx.byPassport.get(passportKey(p))) || (namePhoneKey(p) && idx.byNamePhone.get(namePhoneKey(p))) || null

/** What a merge would do, without changing anything. */
export async function preview(db, source) {
  const data = await fetchExport(source)
  const idx = await indexHere(db)
  let matched = 0, added = 0, docs = 0
  for (const p of data.profiles) {
    if (matchOf(idx, p)) matched++; else added++
    for (const f of p.fields) docs += f.files.length
  }
  const newBrokers = data.brokers.filter(b => norm(b.name) && !idx.brokers.has(norm(b.name))).length
  return { source, profiles: data.profiles.length, matched, added, brokers: data.brokers.length, new_brokers: newBrokers, documents: docs }
}

/** Progress of the merge running now (one at a time). */
export const job = { running: false }

export function startMerge(db, source) {
  if (job.running) throw new Error('A merge is already running.')
  Object.assign(job, { running: true, source, started_at: new Date().toISOString(), done: 0, total: 0, added: 0, filled: 0, docs_added: 0, docs_same: 0, brokers_added: 0, errors: [], finished_at: null, error: null })
  merge(db, source).catch(e => { job.error = e.message }).finally(() => { job.running = false; job.finished_at = new Date().toISOString() })
  return job
}

async function saveBytes(buf, name) {
  fs.mkdirSync(SAFE, { recursive: true })
  const safe = String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80)
  const file = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${safe}`
  fs.writeFileSync(path.join(SAFE, file), buf)
  return file
}

/** Hashes of the documents a profile already has here (read from disk once). */
async function hashesOf(db, profileId) {
  const rows = await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profileId).select('files.path')
  const set = new Set()
  for (const r of rows) {
    const abs = storedPath(r.path)
    if (abs) { try { set.add(sha(fs.readFileSync(abs))) } catch {} }
  }
  return set
}

async function merge(db, source) {
  const data = await fetchExport(source)
  const idx = await indexHere(db)
  const now = () => new Date().toISOString()
  const templates = new Map((await db('field_templates').select('id', 'name').catch(() => [])).map(t => [norm(t.name), t.id]))
  const profileCols = new Set((await db.raw('pragma table_info(profiles)')).map(c => c.name))
  job.total = data.profiles.length

  // Brokers first, so profiles keep theirs.
  const brokerMap = new Map()
  for (const b of data.brokers) {
    const key = norm(b.name)
    if (!key) continue
    let id = idx.brokers.get(key)
    if (!id) {
      ;[id] = await db('brokers').insert({ name: b.name.trim(), address: b.address, contact1: b.contact1, contact2: b.contact2, notes: b.notes, created_at: now(), updated_at: now() })
      idx.brokers.set(key, id)
      job.brokers_added++
    }
    brokerMap.set(b.id, id)
  }

  for (const p of data.profiles) {
    try {
      let hereId = matchOf(idx, p)
      const values = {}
      for (const [k, v] of Object.entries(p)) {
        if (profileCols.has(k) && !SKIP_COLS.has(k) && v !== null && v !== '') values[k] = v
      }
      const broker = p.broker_id ? brokerMap.get(p.broker_id) : null

      if (!hereId) {
        ;[hereId] = await db('profiles').insert({ ...values, broker_id: broker || null, created_at: p.created_at || now(), updated_at: now() })
        if (passportKey(p)) idx.byPassport.set(passportKey(p), hereId)
        if (namePhoneKey(p)) idx.byNamePhone.set(namePhoneKey(p), hereId)
        job.added++
      } else {
        // Only fill what is still empty here.
        const here = await db('profiles').where('id', hereId).first()
        const fill = {}
        for (const [k, v] of Object.entries(values)) if (here[k] === null || here[k] === '' || here[k] === undefined) fill[k] = v
        if (!here.broker_id && broker) fill.broker_id = broker
        if (Object.keys(fill).length) {
          await db('profiles').where('id', hereId).update({ ...fill, updated_at: now() })
          job.filled++
        }
      }

      // Profile photos (only when empty here).
      const here = await db('profiles').where('id', hereId).first()
      for (const col of Object.keys(p.photos || {})) {
        if (here[col]) continue
        try {
          const buf = await getBytes(`${source}/api/branch/export/photo/${p.id}/${col}`)
          await db('profiles').where('id', hereId).update({ [col]: await saveBytes(buf, `${col}.jpg`) })
        } catch (e) { job.errors.push(`${p.full_name}: ${col} (${e.message})`) }
      }

      // Fields and their documents.
      const known = await hashesOf(db, hereId)
      const hereFields = await db('profile_fields').where('profile_id', hereId)
      for (const f of p.fields) {
        let field = hereFields.find(h => norm(h.name) === norm(f.name))
        if (!field) {
          const [fid] = await db('profile_fields').insert({
            profile_id: hereId, field_template_id: templates.get(norm(f.name)) || null, name: f.name,
            data_type: f.data_type, is_permanent: f.is_permanent, value_text: f.value_text, created_at: now(), updated_at: now(),
          })
          field = { id: fid, value_text: f.value_text }
          hereFields.push({ ...field, name: f.name })
        } else if (!field.value_text && f.value_text) {
          await db('profile_fields').where('id', field.id).update({ value_text: f.value_text, updated_at: now() })
        }
        for (const doc of f.files) {
          try {
            const buf = await getBytes(`${source}/api/branch/export/file/${doc.id}`)
            const h = sha(buf)
            if (known.has(h)) { job.docs_same++; continue }
            const stored = await saveBytes(buf, doc.original_name)
            await db('files').insert({
              profile_field_id: field.id, original_name: doc.original_name, path: stored, mimetype: doc.mimetype,
              size: buf.length, content_hash: h, created_at: now(), updated_at: now(),
            })
            known.add(h)
            job.docs_added++
          } catch (e) { job.errors.push(`${p.full_name}: ${doc.original_name} (${e.message})`) }
        }
      }
    } catch (e) {
      job.errors.push(`${p.full_name || p.passport_number || 'profile'}: ${e.message}`)
    }
    job.done++
  }
  if (job.errors.length > 200) job.errors = [...job.errors.slice(0, 200), `…and ${job.errors.length - 200} more`]
}
