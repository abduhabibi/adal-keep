/**
 * profileShare.js — profiles sent to another agency, with every document
 * (asked on 2026-11-14: "the girl should have any document when changing
 * agency"; "the profile should be deleted when I send any profile"; "in
 * bulk … creating profile, then copy the text stuff first and the documents").
 *
 * Sending (one girl or many, in the background):
 *   1. every girl's details (text) go at once: one file, locked with a new
 *      key, in a message in the private chat between the two agencies — the
 *      key is only in that private message, so nobody else can open it;
 *   2. then each girl's documents, one locked file per girl;
 *   3. a girl whose documents are up leaves this agency (to the Trash,
 *      restorable from the main PC). A girl whose documents could not go
 *      stays here and is said so.
 * Receiving ("Add all to my Adal Keep", in the background):
 *   1. every profile is made with her details first (or, when this PC has her
 *      passport number already, her missing details are added to that one);
 *   2. then her documents, field by field (a document already in that field
 *      is not added twice). Documents still on their way are waited for.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { cloudCall, cloudAgencyId, openDirect, agencies as listAgencies, me as chatMe } from './chatCloud.js'

const BUCKET = 'chat'
const MAX_GIRL_BYTES = 45 * 1024 * 1024
export const MARK = /\[adal-profile v2 k=([A-Za-z0-9_-]{43}) s=([a-f0-9]{16})\]/
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const SENDS_FILE = path.join(DATA_DIR, 'profile-sends.json')
const ADDED_FILE = path.join(DATA_DIR, 'profile-received.json')
const ACCEPTED_FILE = path.join(DATA_DIR, 'profile-accepted.json')   // sends whose girls and documents are all in
const ADDING_FILE = path.join(DATA_DIR, 'profile-adding.json')       // message ids being accepted right now (go on after a restart)
const noteAdding = (m, on) => { const l = readJson(ADDING_FILE).filter(x => x !== Number(m)); if (on) l.push(Number(m)); writeJson(ADDING_FILE, l) }

// What stays with this agency: its own numbering, people and places on its PC.
const LOCAL_COLUMNS = new Set(['id', 'broker_id', 'assigned_to', 'company_id', 'branch_id', 'room', 'table_name', 'box_number',
  'photo_path', 'full_body_photo_path', 'passport_file', 'editing_started_at', 'last_opened_at', 'created_at', 'updated_at',
  'created_by', 'notes', 'medical_alerts_sent', 'appointment_alerts_sent'])

const readJson = (f, d = []) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) } catch {} }
const err = (message, status) => Object.assign(new Error(message), { status })

// ------------------------------------------------------------- locking --
export function lock(buf, key) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(buf), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), body])
}
export function unlock(buf, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  return Buffer.concat([d.update(buf.subarray(28)), d.final()])
}
/** Documents in one buffer: [4 bytes: list length][list JSON][the files one after another]. */
export function pack(list, blobs) {
  let offset = 0
  const files = list.map((f, i) => { const o = { ...f, offset, length: blobs[i].length }; offset += blobs[i].length; return o })
  const head = Buffer.from(JSON.stringify(files))
  const len = Buffer.alloc(4); len.writeUInt32BE(head.length)
  return Buffer.concat([len, head, ...blobs])
}
export function unpack(buf) {
  const n = buf.readUInt32BE(0)
  const files = JSON.parse(buf.subarray(4, 4 + n).toString())
  const start = 4 + n
  return { files, blob: (f) => buf.subarray(start + f.offset, start + f.offset + f.length) }
}

async function upload(db, object, buf) {
  for (let i = 1; ; i++) {
    try { return await cloudCall(db, 'POST', `/storage/v1/object/${BUCKET}/${object}`, buf, { headers: { 'Content-Type': 'application/octet-stream' } }) }
    catch (e) {
      if (/already exists|duplicate|409/i.test(String(e.message))) return { already: true }   // it went up before a restart
      if (i >= 3) throw e; await new Promise(r => setTimeout(r, 3000 * i))
    }
  }
}
async function download(db, object) {
  const res = await cloudCall(db, 'GET', `/storage/v1/object/authenticated/${BUCKET}/${object}`, undefined, { raw: true })
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}

// ------------------------------------------------------------------ send --
async function storedPathOf(p) {
  const { resolveStoredPath } = await import('./cvRender.js')
  return resolveStoredPath(p)
}

/** Her details and the list of her documents (their contents are read when they go). */
export async function collect(db, profileId) {
  const profile = await db('profiles').where('id', profileId).first()
  if (!profile) return null
  const details = {}
  for (const [k, v] of Object.entries(profile)) if (!LOCAL_COLUMNS.has(k) && v !== null && v !== '') details[k] = v
  const fields = await db('profile_fields').where('profile_id', profileId).select('id', 'name')
  const byField = new Map(fields.map(f => [f.id, f.name]))
  const rows = fields.length ? await db('files').whereIn('profile_field_id', fields.map(f => f.id)).orderBy('id') : []
  const docs = []
  for (const r of rows) {
    const abs = await storedPathOf(r.path)
    if (!abs || !fs.existsSync(abs)) continue
    docs.push({ field: byField.get(r.profile_field_id) || 'Other', name: r.original_name || path.basename(abs), mimetype: r.mimetype || 'application/octet-stream', created_at: r.created_at, abs, size: fs.statSync(abs).size })
  }
  return { profile, details, docs }
}

export const sendJobs = new Map()   // send id → progress

/**
 * Send profiles to another agency. Answers at once; the documents go in the
 * background (sendJobs / sentList show how far it is).
 */
export async function sendProfiles(db, { profileIds, toAgency, who = null }) {
  const meRow = await chatMe(db)
  const to = ((await listAgencies(db)) || []).find(a => a.id === toAgency && !a.is_admin)
  if (!to) throw err('That agency is not in Adal Keep.', 404)
  if (to.id === meRow?.id) throw err('That is this agency.', 400)
  const me = await cloudAgencyId(db)
  const sendId = crypto.randomBytes(8).toString('hex')
  const key = crypto.randomBytes(32)
  const girls = []
  for (const id of profileIds) {
    const c = await collect(db, Number(id))
    if (!c) continue
    const total = c.docs.reduce((s, d) => s + d.size, 0)
    girls.push({ id: Number(id), name: c.profile.full_name || 'a profile', c, tooBig: total > MAX_GIRL_BYTES, object: `${me}/${sendId}-${girls.length}.adaldocs` })
  }
  if (!girls.length) throw err('Those profiles are not on this PC.', 404)
  // 1. Every girl's details at once.
  const details = {
    v: 2, send_id: sendId, from: meRow?.name || 'an agency', sent_by: who, sent_at: new Date().toISOString(),
    girls: girls.map((g, i) => ({ i, profile: g.c.details, documents: g.tooBig ? 0 : g.c.docs.length, docs: g.tooBig ? [] : g.c.docs.map(({ abs, ...d }) => d), object: g.tooBig ? null : g.object })),
  }
  const detailsObject = `${me}/${sendId}.adalprofile`
  const locked = lock(Buffer.from(JSON.stringify(details)), key)
  await upload(db, detailsObject, locked)
  const conv = await openDirect(db, to.id)
  const names = girls.map(g => g.name)
  const title = girls.length === 1 ? names[0] : `${girls.length} profiles`
  const body = `📋 ${girls.length === 1 ? `Profile: ${names[0]}` : `${girls.length} profiles: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` and ${names.length - 6} more` : ''}`}` +
    ` — transferred to you with ${girls.reduce((s, g) => s + (g.tooBig ? 0 : g.c.docs.length), 0)} documents.\n[adal-profile v2 k=${key.toString('base64url')} s=${sendId}]`
  const [msg] = await cloudCall(db, 'POST', '/rest/v1/messages', {
    conversation_id: conv, body: body.slice(0, 3900), kind: 'file', file_path: detailsObject, file_name: `${title}.adalprofile`.slice(0, 200),
    file_mime: 'application/x-adal-profile', file_size: locked.length,
  }, { headers: { Prefer: 'return=representation' } })
  // Kept in data/profile-sends.json (this PC only), with the key and each girl's
  // file name: a send cut off by a restart goes on from the girl it was at.
  const job = { send_id: sendId, to: to.id, to_name: to.name, conversation: conv, message: msg?.id || null, at: details.sent_at,
    total: girls.length, sent: 0, failed: [], running: true, key: key.toString('base64'),
    girls: girls.map(g => ({ id: g.id, name: g.name, state: 'waiting', object: g.object, too_big: g.tooBig })) }
  sendJobs.set(sendId, job)
  saveSendJob(job)
  sendDocs(db, job).catch(e => { job.running = false; job.error = e.message; saveSendJob(job) })
  return { ok: true, send_id: sendId, total: girls.length, to: to.name, conversation: conv, too_big: girls.filter(g => g.tooBig).map(g => g.name) }
}

function saveSendJob(job) { const all = readJson(SENDS_FILE).filter(s => s.send_id !== job.send_id); all.push(job); writeJson(SENDS_FILE, all.slice(-300)) }

/** 2–3. Each girl's documents (from the one it was at), then she leaves this agency. */
async function sendDocs(db, job) {
  const { moveToTrash } = await import('./trash.js')
  const key = Buffer.from(job.key, 'base64')
  const fakeReq = { get: () => encodeURIComponent(`Sent to ${job.to_name}`.slice(0, 80)), headers: {} }
  for (const s of job.girls) {
    if (s.state === 'sent' || s.state === 'failed') continue
    try {
      if (s.too_big) throw new Error(`her documents are over ${Math.round(MAX_GIRL_BYTES / 1048576)} MB`)
      s.state = 'sending'; saveSendJob(job)
      const c = await collect(db, s.id)
      if (!c) throw new Error('she is no longer on this PC')
      const blobs = c.docs.map(d => fs.readFileSync(d.abs))
      await upload(db, s.object, lock(pack(c.docs.map(({ abs, size, ...d }) => d), blobs), key))
      await moveToTrash(db, 'profile', s.id, fakeReq)
      s.state = 'sent'; job.sent++
    } catch (e) {
      s.state = 'failed'; s.error = String(e.message || e).slice(0, 200); job.failed.push(s.name)
      console.warn(`[profile-share] ${s.name}: not sent (${s.error}) — she stays here`)
    }
    saveSendJob(job)
  }
  job.running = false; job.done_at = new Date().toISOString(); saveSendJob(job)
  console.log(`[profile-share] sent ${job.sent} of ${job.total} profile(s) to ${job.to_name}`)
}

/** What this PC has sent (newest first), with how far each send is (never the key). */
export const sentList = () => readJson(SENDS_FILE).map(s => sendJobs.get(s.send_id) || s).map(({ key, ...s }) => s).reverse()

/**
 * At start-up: sends and "Accept"s cut off by a restart go on — a send from
 * the girl it was at, an Accept from the girl whose documents were next.
 */
export async function resumeProfileShares(db) {
  for (const job of readJson(SENDS_FILE)) {
    if (!job.running || !job.key || sendJobs.get(job.send_id)?.running) continue
    console.log(`[profile-share] going on with the send to ${job.to_name} (${job.sent} of ${job.total} sent)`)
    sendJobs.set(job.send_id, job)
    sendDocs(db, job).catch(e => { job.running = false; job.error = e.message; saveSendJob(job) })
  }
  for (const m of readJson(ADDING_FILE)) {
    console.log(`[profile-share] going on with accepting message #${m}`)
    await addSent(db, m).catch(e => console.warn('[profile-share] accept could not go on:', e.message))
  }
}

// --------------------------------------------------------------- receive --
const opened = new Map()   // message id → { details, key, sender, mine, conv, sendId }
async function openSent(db, messageId) {
  const id = Number(messageId)
  if (opened.has(id)) return opened.get(id)
  const [m] = await cloudCall(db, 'GET', `/rest/v1/messages?id=eq.${id}&select=id,conversation_id,sender_id,body,file_path,deleted_at`) || []
  const mark = m && !m.deleted_at && String(m.body || '').match(MARK)
  if (!mark || !m.file_path) throw err('That profile is not there any more.', 404)
  const raw = await download(db, m.file_path)
  if (!raw) throw err('Its file could not be downloaded.', 404)
  const key = Buffer.from(mark[1], 'base64url')
  const details = JSON.parse(unlock(raw, key).toString())
  const me = await cloudAgencyId(db)
  const out = { details, key, sender: m.sender_id, mine: m.sender_id === me, conv: m.conversation_id, sendId: mark[2] }
  opened.set(id, out)
  if (opened.size > 8) opened.delete(opened.keys().next().value)
  return out
}
const docsCache = new Map()   // object → { files, blob }
async function girlDocs(db, o, girl) {
  if (!girl.object) return null
  if (docsCache.has(girl.object)) return docsCache.get(girl.object)
  const raw = await download(db, girl.object)
  if (!raw) return null   // not up yet
  const d = unpack(unlock(raw, o.key))
  docsCache.set(girl.object, d)
  if (docsCache.size > 6) docsCache.delete(docsCache.keys().next().value)
  return d
}
async function readyObjects(db, o) {
  try {
    const list = await cloudCall(db, 'POST', `/storage/v1/object/list/${BUCKET}`, { prefix: `${o.sender}/`, search: o.sendId, limit: 1000 })
    return new Set((list || []).map(x => `${o.sender}/${x.name}`))
  } catch { return null }
}

export const addJobs = new Map()   // send id → progress of "Add all"
// Girls accepted whose documents have not come yet: "Prioritize" on her card
// (the same button as for a move) brings hers next.
const shareWaiting = new Map()   // profile id → send id
const sharePlease = []           // profile ids pressed
export const shareFilesWaiting = () => [...shareWaiting.keys()]
export function sharePrioritize(profileId) {
  const pid = Number(profileId)
  if (!shareWaiting.has(pid)) return false
  if (!sharePlease.includes(pid)) sharePlease.unshift(pid)
  return true
}
const addedOf = (sendId) => readJson(ADDED_FILE).filter(a => a.send_id === sendId)

/** The card's View: every girl's details, her documents, what was added. */
export async function viewSent(db, messageId) {
  const o = await openSent(db, messageId)
  const ready = await readyObjects(db, o)
  const added = addedOf(o.sendId)
  const girls = []
  for (const g of o.details.girls) {
    const p = g.profile || {}
    const a = added.find(x => x.i === g.i)
    const here = !a && p.passport_number ? await db('profiles').where('passport_number', p.passport_number).first('id', 'full_name') : null
    girls.push({
      i: g.i, profile: p, documents: (g.docs || []).map((f, n) => ({ n, field: f.field, name: f.name, mimetype: f.mimetype })),
      documents_ready: !g.object ? false : ready ? ready.has(g.object) : null,
      added: a ? { profile_id: a.profile_id, documents: a.documents, done: !!a.docs_done } : null,
      already_here: here ? { profile_id: here.id, full_name: here.full_name } : null,
    })
  }
  return { from: o.details.from, sent_at: o.details.sent_at, mine: o.mine, girls, job: addJobs.get(o.sendId) || null }
}

/** One document of a sent girl (to look at it before adding her). */
export async function sentFile(db, messageId, i, n) {
  const o = await openSent(db, messageId)
  const g = o.details.girls[Number(i)]
  const d = g && await girlDocs(db, o, g)
  const f = d?.files[Number(n)]
  if (!f) throw err(d ? 'No such document.' : 'Her documents are still on their way.', 404)
  return { type: f.mimetype, name: f.name, body: d.blob(f) }
}

/** Makes (or completes) her profile from her details. Returns { profileId, created }. */
async function profileFromDetails(db, p, from, sentAt, who) {
  const cols = new Set(Object.keys(await db('profiles').columnInfo()))
  const now = new Date().toISOString()
  const existing = p.passport_number ? await db('profiles').where('passport_number', p.passport_number).first() : null
  if (existing) {
    const upd = {}
    for (const [k, v] of Object.entries(p)) if (cols.has(k) && !LOCAL_COLUMNS.has(k) && (existing[k] === null || existing[k] === '')) upd[k] = v
    if (Object.keys(upd).length) await db('profiles').where('id', existing.id).update({ ...upd, updated_at: now })
    return { profileId: existing.id, created: false }
  }
  const row = {}
  for (const [k, v] of Object.entries(p)) if (cols.has(k) && !LOCAL_COLUMNS.has(k)) row[k] = v
  row.notes = `From ${from} (transferred ${String(sentAt).slice(0, 10)})`
  row.created_by = (who || `From ${from}`).slice(0, 120)
  row.created_at = now; row.updated_at = now
  const [id] = await db('profiles').insert(row)
  return { profileId: id, created: true }
}

/** Her documents into her profile, field by field. Returns how many were new. */
export async function addDocs(db, profileId, d) {
  const { SAFE_STORAGE_DIR } = await import('./docPipeline.js')
  const now = new Date().toISOString()
  let added = 0
  for (const f of d.files) {
    const buf = d.blob(f)
    const hash = crypto.createHash('sha256').update(buf).digest('hex')
    let field = await db('profile_fields').where({ profile_id: profileId, name: f.field }).first()
    if (!field) {
      const tpl = await db('field_templates').where('name', f.field).first()
      const [fid] = await db('profile_fields').insert({ profile_id: profileId, field_template_id: tpl ? tpl.id : null, name: f.field, data_type: 'file', is_permanent: 1, created_at: now, updated_at: now })
      field = { id: fid }
    } else if (await db('files').where({ profile_field_id: field.id, content_hash: hash }).first('id')) continue
    const safe = path.basename(String(f.name || 'document')).replace(/[^\w.\- ]+/g, '_').slice(-120)
    const stored = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}_${safe}`
    fs.writeFileSync(path.join(SAFE_STORAGE_DIR, stored), buf)
    await db('files').insert({ profile_field_id: field.id, original_name: f.name, path: stored, mimetype: f.mimetype, size: buf.length, content_hash: hash, created_at: f.created_at || now, updated_at: now })
    added++
  }
  return added
}

/**
 * "Add all to my Adal Keep": every profile with her details first, then her
 * documents. Answers at once; addJobs shows how far it is.
 */
export async function addSent(db, messageId, { who = null } = {}) {
  const o = await openSent(db, messageId)
  if (o.mine) throw err('This agency sent them.', 400)
  if (addJobs.get(o.sendId)?.running) return addJobs.get(o.sendId)
  const job = { running: true, total: o.details.girls.length, made: 0, documents: 0, girls_done: 0, waiting: 0, error: null }
  addJobs.set(o.sendId, job)
  noteAdding(messageId, true)
  run(db, o, job, who).then(() => { if (!job.waiting) noteAdding(messageId, false) })
    .catch(e => { job.error = e.message }).finally(() => { job.running = false })
  return job
}

export async function run(db, o, job, who, { tell = true, waitMs = 30 * 60000 } = {}) {
  const list = readJson(ADDED_FILE)
  const rec = (g) => list.find(a => a.send_id === o.sendId && a.i === g.i)
  // 1. Every profile with her details.
  for (const g of o.details.girls) {
    let r = rec(g)
    if (r && await db('profiles').where('id', r.profile_id).first('id')) { job.made++; continue }
    const { profileId, created } = await profileFromDetails(db, g.profile || {}, o.details.from, o.details.sent_at, who)
    if (r) Object.assign(r, { profile_id: profileId, docs_done: false })
    else list.push(r = { send_id: o.sendId, i: g.i, profile_id: profileId, created, documents: 0, docs_done: false, from: o.details.from, at: new Date().toISOString() })
    job.made++
  }
  writeJson(ADDED_FILE, list.slice(-5000))
  // 2. Her documents (waiting for the ones still on their way).
  const until = Date.now() + waitMs
  let left = o.details.girls.filter(g => g.object && !rec(g).docs_done)
  for (const g of o.details.girls) if (!g.object) rec(g).docs_done = true   // sent without documents (too big)
  job.girls_done = o.details.girls.filter(g => rec(g).docs_done).length
  for (const g of left) shareWaiting.set(rec(g).profile_id, o.sendId)
  while (left.length) {
    const next = []
    const queue = [...left]
    while (queue.length) {
      // A girl someone pressed Prioritize on goes first.
      const ui = queue.findIndex(g => sharePlease.includes(rec(g).profile_id))
      const g = ui >= 0 ? queue.splice(ui, 1)[0] : queue.shift()
      if (ui >= 0) sharePlease.splice(sharePlease.indexOf(rec(g).profile_id), 1)
      const d = await girlDocs(db, o, g).catch(() => null)
      if (!d) { next.push(g); continue }
      const r = rec(g)
      const n = await addDocs(db, r.profile_id, d)
      r.documents += n; r.docs_done = true; job.documents += n; job.girls_done++
      shareWaiting.delete(r.profile_id)
      writeJson(ADDED_FILE, list.slice(-5000))
    }
    job.waiting = next.length
    left = next
    if (!left.length || Date.now() > until) break
    await new Promise(r => setTimeout(r, 15000))
  }
  writeJson(ADDED_FILE, list.slice(-5000))
  if (!left.length) { const done = readJson(ACCEPTED_FILE); if (!done.includes(o.sendId)) { done.push(o.sendId); writeJson(ACCEPTED_FILE, done.slice(-5000)) } }
  if (tell) {
    try {
      const meRow = await chatMe(db)
      await cloudCall(db, 'POST', '/rest/v1/messages', {
        conversation_id: o.conv, kind: 'text',
        body: `✅ ${meRow?.name || 'We'} added ${job.made} profile${job.made === 1 ? '' : 's'} with ${job.documents} document${job.documents === 1 ? '' : 's'} to its Adal Keep.` + (left.length ? ` ${left.length} girl's documents had not come yet.` : ''),
      }, { headers: { Prefer: 'return=minimal' } })
    } catch (e) { console.warn('[profile-share] could not tell the sender:', e.message) }
  }
  return job
}

/** How far "Add all" is for this message. */
export async function addStatus(db, messageId) {
  const o = await openSent(db, messageId)
  return addJobs.get(o.sendId) || null
}
/**
 * Profiles other agencies sent that are not in yet: [{ conversation, message,
 * title, send_id, running }] — for "Accept" on the chat's name and its cards.
 */
export async function pendingProfiles(db, conversation = null) {
  const me = await cloudAgencyId(db)
  const rows = await cloudCall(db, 'GET', `/rest/v1/messages?file_mime=eq.application%2Fx-adal-profile&sender_id=neq.${me}&deleted_at=is.null` +
    (conversation ? `&conversation_id=eq.${encodeURIComponent(conversation)}` : '') + '&select=id,conversation_id,body,file_name,created_at&order=id.desc&limit=200') || []
  const done = new Set(readJson(ACCEPTED_FILE))
  const out = []
  for (const m of rows) {
    const mark = String(m.body || '').match(MARK)
    if (!mark || done.has(mark[2])) continue
    const job = addJobs.get(mark[2])
    out.push({ conversation: m.conversation_id, message: m.id, send_id: mark[2], title: String(m.file_name || 'Profiles').replace(/.adalprofile$/, ''), at: m.created_at, running: !!job?.running, job: job || null })
  }
  return out
}

/** "Accept" on a chat: every profile waiting in it goes in (details first, then documents). */
export async function acceptAll(db, conversation, { who = null } = {}) {
  const list = await pendingProfiles(db, conversation)
  const started = []
  for (const p of list) {
    try { started.push({ message: p.message, title: p.title, job: await addSent(db, p.message, { who }) }) }
    catch (e) { started.push({ message: p.message, title: p.title, error: e.message }) }
  }
  return { ok: true, accepted: started.length, started }
}

export const _test = { docsCache, ADDED_FILE }
