/**
 * profileShare.js — a profile sent to another agency, with every document
 * (asked on 2026-11-14: "the girl should have any document when changing
 * agency", "send profiles to make the other agency see the profile").
 *
 *   send     her details and every document, packed in one file locked with
 *            a new key, go to the other agency in the private chat between
 *            the two agencies; the key is only in that private message, so
 *            nobody else can open the file.
 *   two ways "transfer": when the other agency adds her, she leaves this
 *            agency (to the Trash, restorable); "show": she stays here, the
 *            other agency sees her and may add her too.
 *   receive  the other agency opens the card in its chat (View) and adds her
 *            to its Adal Keep (Add): a new profile with every document — or,
 *            when it already has her passport number, her documents and
 *            missing details are added to that profile.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { cloudCall, cloudAgencyId, openDirect, agencies as listAgencies, me as chatMe } from './chatCloud.js'

const BUCKET = 'chat'
const MAX_BYTES = 45 * 1024 * 1024
const MARK = /\[adal-profile v1 k=([A-Za-z0-9_-]{43}) m=(transfer|show) s=([a-f0-9]{16})\]/
const OK_MARK = (s) => `[adal-profile-ok s=${s}]`
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const SENDS_FILE = path.join(DATA_DIR, 'profile-sends.json')
const ADDED_FILE = path.join(DATA_DIR, 'profile-received.json')

// What stays with this agency: its own numbering, people and places on its PC.
const LOCAL_COLUMNS = new Set(['id', 'broker_id', 'assigned_to', 'company_id', 'branch_id', 'room', 'table_name', 'box_number',
  'photo_path', 'full_body_photo_path', 'passport_file', 'editing_started_at', 'last_opened_at', 'created_at', 'updated_at',
  'created_by', 'notes', 'medical_alerts_sent', 'appointment_alerts_sent'])

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return [] } }
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {} }

// ------------------------------------------------------------- the file --
function lock(buf, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body])
}
function unlock(buf, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()])
}
export function pack(manifest, blobs) {
  let offset = 0
  manifest.files = manifest.files.map((f, i) => { const o = { ...f, offset, length: blobs[i].length }; offset += blobs[i].length; return o })
  const head = Buffer.from(JSON.stringify(manifest))
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length)
  return Buffer.concat([len, head, ...blobs])
}
export function unpack(buf) {
  const n = buf.readUInt32BE(0)
  const manifest = JSON.parse(buf.subarray(4, 4 + n).toString())
  const start = 4 + n
  return { manifest, blob: (f) => buf.subarray(start + f.offset, start + f.offset + f.length) }
}
export const _test = { lock, unlock, MARK, collect, ADDED_FILE }

// ------------------------------------------------------------------ send --
async function storedPathOf(p) {
  const { resolveStoredPath } = await import('./cvRender.js')
  return resolveStoredPath(p)
}

/** Her details and every document, as they are on this PC. */
async function collect(db, profileId) {
  const profile = await db('profiles').where('id', profileId).first()
  if (!profile) throw Object.assign(new Error('That profile is not on this PC.'), { status: 404 })
  const details = {}
  for (const [k, v] of Object.entries(profile)) if (!LOCAL_COLUMNS.has(k) && v !== null && v !== '') details[k] = v
  const fields = await db('profile_fields').where('profile_id', profileId).select('id', 'name')
  const byField = new Map(fields.map(f => [f.id, f.name]))
  const rows = fields.length ? await db('files').whereIn('profile_field_id', fields.map(f => f.id)).orderBy('id') : []
  const files = [], blobs = []
  let total = 0
  for (const r of rows) {
    const abs = await storedPathOf(r.path)
    if (!abs || !fs.existsSync(abs)) continue
    const buf = fs.readFileSync(abs)
    total += buf.length
    if (total > MAX_BYTES) throw Object.assign(new Error(`Her documents are too big to send at once (over ${Math.round(MAX_BYTES / 1048576)} MB).`), { status: 413 })
    files.push({ field: byField.get(r.profile_field_id) || 'Other', name: r.original_name || path.basename(abs), mimetype: r.mimetype || 'application/octet-stream', created_at: r.created_at })
    blobs.push(buf)
  }
  return { profile, details, files, blobs }
}

/**
 * Send a profile to another agency: mode "transfer" (she moves to them when
 * they add her) or "show" (she stays here; they see her).
 */
export async function sendProfile(db, { profileId, toAgency, mode = 'show', who = null }) {
  mode = mode === 'transfer' ? 'transfer' : 'show'
  const meRow = await chatMe(db)
  const list = await listAgencies(db) || []
  const to = list.find(a => a.id === toAgency && !a.is_admin)
  if (!to) throw Object.assign(new Error('That agency is not in Adal Keep (or it is this agency).'), { status: 404 })
  if (to.id === meRow?.id) throw Object.assign(new Error('That is this agency.'), { status: 400 })
  const { profile, details, files, blobs } = await collect(db, Number(profileId))
  const key = crypto.randomBytes(32)
  const sendId = crypto.randomBytes(8).toString('hex')
  const manifest = { v: 1, mode, send_id: sendId, from: meRow?.name || 'an agency', sent_by: who || null, sent_at: new Date().toISOString(), profile: details, files }
  const locked = lock(pack(manifest, blobs), key)
  const me = await cloudAgencyId(db)
  const object = `${me}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.adalprofile`
  await cloudCall(db, 'POST', `/storage/v1/object/${BUCKET}/${object}`, locked, { headers: { 'Content-Type': 'application/octet-stream' } })
  const conv = await openDirect(db, to.id)
  const name = profile.full_name || 'a profile'
  const body = `📋 Profile: ${name} — ${files.length} document${files.length === 1 ? '' : 's'}` +
    (mode === 'transfer' ? ' · transferred to you (she moves to your agency when you add her)' : ' · sent for you to see') +
    `\n[adal-profile v1 k=${key.toString('base64url')} m=${mode} s=${sendId}]`
  const [msg] = await cloudCall(db, 'POST', '/rest/v1/messages', {
    conversation_id: conv, body, kind: 'file', file_path: object, file_name: `${name}.adalprofile`.slice(0, 200),
    file_mime: 'application/x-adal-profile', file_size: locked.length,
  }, { headers: { Prefer: 'return=representation' } })
  const sends = readJson(SENDS_FILE)
  sends.push({ send_id: sendId, profile_id: Number(profileId), name, to: to.id, to_name: to.name, conversation: conv, message: msg?.id || null, mode, at: manifest.sent_at, state: 'sent' })
  writeJson(SENDS_FILE, sends.slice(-500))
  return { ok: true, send_id: sendId, conversation: conv, message: msg?.id || null, documents: files.length, to: to.name, mode }
}

/** What this PC has sent (newest first). */
export const sentList = () => readJson(SENDS_FILE).slice().reverse()

// --------------------------------------------------------------- receive --
const opened = new Map()   // message id → { manifest, blob, sender, mine, conv }
async function openSent(db, messageId) {
  const id = Number(messageId)
  if (opened.has(id)) return opened.get(id)
  const [m] = await cloudCall(db, 'GET', `/rest/v1/messages?id=eq.${id}&select=id,conversation_id,sender_id,body,file_path,deleted_at`) || []
  const mark = m && !m.deleted_at && String(m.body || '').match(MARK)
  if (!mark || !m.file_path) throw Object.assign(new Error('That profile is not there any more.'), { status: 404 })
  const res = await cloudCall(db, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${m.file_path}`, undefined, { raw: true })
  if (!res.ok) throw Object.assign(new Error('Its file could not be downloaded.'), { status: 404 })
  const { manifest, blob } = unpack(unlock(Buffer.from(await res.arrayBuffer()), Buffer.from(mark[1], 'base64url')))
  const me = await cloudAgencyId(db)
  const out = { manifest, blob, sender: m.sender_id, mine: m.sender_id === me, conv: m.conversation_id, sendId: mark[3] }
  opened.set(id, out)
  if (opened.size > 4) opened.delete(opened.keys().next().value)
  return out
}

/** The card's View: her details and her documents (no file contents). */
export async function viewSent(db, messageId) {
  const o = await openSent(db, messageId)
  const added = readJson(ADDED_FILE).find(a => a.send_id === o.sendId) || null
  const p = o.manifest.profile
  const existing = p.passport_number ? await db('profiles').where('passport_number', p.passport_number).first('id', 'full_name') : null
  return {
    mode: o.manifest.mode, from: o.manifest.from, sent_at: o.manifest.sent_at, mine: o.mine,
    profile: p,
    documents: o.manifest.files.map((f, n) => ({ n, field: f.field, name: f.name, mimetype: f.mimetype, size: f.length })),
    added: added ? { profile_id: added.profile_id, at: added.at } : null,
    already_here: existing ? { profile_id: existing.id, full_name: existing.full_name } : null,
  }
}

/** One document of a sent profile (to look at it before adding her). */
export async function sentFile(db, messageId, n) {
  const o = await openSent(db, messageId)
  const f = o.manifest.files[Number(n)]
  if (!f) throw Object.assign(new Error('No such document.'), { status: 404 })
  return { type: f.mimetype, name: f.name, body: o.blob(f) }
}

/**
 * Add her to this agency's Adal Keep with every document. When this PC has
 * her passport number already, that profile gets the documents it does not
 * have and the details it is missing. Tells the sender (a transfer then
 * leaves the sending agency).
 */
export async function addSent(db, messageId, { who = null } = {}) {
  return addOpened(db, await openSent(db, messageId), { who, messageId })
}

/** Adds an opened profile (`o`: what openSent gives) — also used by the tests. */
export async function addOpened(db, o, { who = null, messageId = null, tell = true } = {}) {
  if (o.mine) throw Object.assign(new Error('This agency sent her.'), { status: 400 })
  const done = readJson(ADDED_FILE).find(a => a.send_id === o.sendId)
  if (done && await db('profiles').where('id', done.profile_id).first('id')) return { ok: true, profile_id: done.profile_id, again: true }
  const p = o.manifest.profile
  const cols = new Set(Object.keys(await db('profiles').columnInfo()))
  const now = new Date().toISOString()
  let profileId = null, created = false
  const existing = p.passport_number ? await db('profiles').where('passport_number', p.passport_number).first() : null
  if (existing) {
    profileId = existing.id
    const upd = {}
    for (const [k, v] of Object.entries(p)) if (cols.has(k) && !LOCAL_COLUMNS.has(k) && (existing[k] === null || existing[k] === '')) upd[k] = v
    if (Object.keys(upd).length) await db('profiles').where('id', profileId).update({ ...upd, updated_at: now })
  } else {
    const row = {}
    for (const [k, v] of Object.entries(p)) if (cols.has(k) && !LOCAL_COLUMNS.has(k)) row[k] = v
    row.notes = `From ${o.manifest.from} (${o.manifest.mode === 'transfer' ? 'transferred' : 'sent'} ${String(o.manifest.sent_at).slice(0, 10)})`
    row.created_by = who || `From ${o.manifest.from}`.slice(0, 120)
    row.created_at = now; row.updated_at = now
    ;[profileId] = await db('profiles').insert(row)
    created = true
  }
  // Every document, in its own field; one already in that field (same content) is not added twice.
  const { SAFE_STORAGE_DIR } = await import('./docPipeline.js')
  let added = 0
  for (const f of o.manifest.files) {
    const buf = o.blob(f)
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
    let field = await db('profile_fields').where({ profile_id: profileId, name: f.field }).first()
    if (!field) {
      const tpl = await db('field_templates').where('name', f.field).first()
      const [fid] = await db('profile_fields').insert({ profile_id: profileId, field_template_id: tpl ? tpl.id : null, name: f.field, data_type: 'file', is_permanent: 1, created_at: now, updated_at: now })
      field = { id: fid }
    } else if (await db('files').where({ profile_field_id: field.id, content_hash: hash }).first('id')) continue
    const safe = path.basename(String(f.name || 'document')).replace(/[^\w.\- ]+/g, '_').slice(-120)
    const stored = `${Date.now()}_${added}_${safe}`
    fs.writeFileSync(path.join(SAFE_STORAGE_DIR, stored), buf)
    await db('files').insert({ profile_field_id: field.id, original_name: f.name, path: stored, mimetype: f.mimetype, size: buf.length, content_hash: hash, created_at: f.created_at || now, updated_at: now })
    added++
  }
  const list = readJson(ADDED_FILE)
  list.push({ send_id: o.sendId, message: Number(messageId), profile_id: profileId, from: o.manifest.from, at: now })
  writeJson(ADDED_FILE, list.slice(-2000))
  // Tell the sender (its PC moves a transferred girl to its Trash).
  if (tell) try {
    const meRow = await chatMe(db)
    await cloudCall(db, 'POST', '/rest/v1/messages', {
      conversation_id: o.conv, kind: 'text',
      body: `✅ ${meRow?.name || 'We'} added ${p.full_name || 'her'} to its Adal Keep (${added} document${added === 1 ? '' : 's'}).\n${OK_MARK(o.sendId)}`,
    }, { headers: { Prefer: 'return=minimal' } })
  } catch (e) { console.warn('[profile-share] could not tell the sender:', e.message) }
  return { ok: true, profile_id: profileId, created, documents: added }
}

// ----------------------------------------------- the sender hears back --
/** A transferred girl the other agency added leaves this agency (to the Trash). */
export async function checkTransfers(db) {
  const sends = readJson(SENDS_FILE)
  const open = sends.filter(s => s.state === 'sent')
  if (!open.length) return 0
  let n = 0
  for (const s of open) {
    try {
      const rows = await cloudCall(db, 'GET', `/rest/v1/messages?conversation_id=eq.${s.conversation}&id=gt.${Number(s.message) || 0}` +
        `&body=like.*${encodeURIComponent(OK_MARK(s.send_id))}*&select=id&limit=1`) || []
      if (!rows.length) continue
      s.state = 'added'
      s.added_at = new Date().toISOString()
      if (s.mode === 'transfer') {
        const { moveToTrash } = await import('./trash.js')
        const still = await db('profiles').where('id', s.profile_id).first('id')
        if (still) {
          await moveToTrash(db, 'profile', s.profile_id, { get: () => encodeURIComponent(`Transferred to ${s.to_name}`), headers: {} })
          s.state = 'transferred'
          console.log(`[profile-share] profile #${s.profile_id} transferred to ${s.to_name}: moved to the Trash`)
        }
      }
      n++
    } catch (e) { console.warn('[profile-share] check:', e.message) }
  }
  if (n) writeJson(SENDS_FILE, sends)
  return n
}

export function startTransferChecks(db) {
  setInterval(() => checkTransfers(db).catch(() => {}), 60000).unref?.()
}
