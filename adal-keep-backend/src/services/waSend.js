/**
 * "Send on WhatsApp" from the CV preview, and Retry on the WhatsApp page: one CV to
 * the agents a person picked — never by itself, never to a number that is not one of
 * the agency's agents, one after the other at a person's pace. A girl already sent to
 * an agent is refused (saying when) unless the person said "again".
 *
 * The WhatsApp it goes through is handed in (a "transport"): the agency's one
 * (services/whatsapp.js) or this PC's own (services/waOwn.js).
 *   { key, label, send(chatId, { path, name, mime, caption, asFile }) → message id }
 */
import fs from 'fs'
import path from 'path'
import { agentsOf, agentRow, waitingOnly, selfVideo, cvFor } from './whatsapp.js'
import { record, change, lastSent } from './waRecords.js'
import { isChosen } from './chosen.js'

export const MOST = 15          // agents in one go: not a bulk tool
const SAFE = path.join(import.meta.dirname, '..', '..', 'data', 'SafeStorage')
const now = () => new Date().toISOString()
const pause = (ms) => new Promise(r => setTimeout(r, ms))
export const jobs = new Map()   // id → { running, total, done, sent, failed, results, agent }
let nextJob = 1, going = Promise.resolve()

/** Why her CV may not go to agents now, or ''. (The same rule as the profile page's: only while she waits on Musaned.) */
export async function mayNot(db, p) {
  if (!p) return 'Profile not found'
  if (p.chosen_at || isChosen(p)) return `${p.full_name} is already chosen on Musaned`
  if (!(await waitingOnly(db, [p.id])).has(p.id)) return `${p.full_name} is not in Waiting (added to Musaned, not chosen yet): only those CVs go to agents on WhatsApp`
  return ''
}

/** The PDF of a CV made before, if it is on this PC. */
async function madeCv(db, id) {
  const cv = id ? await db('generated_cvs').where('id', Number(id)).first('id', 'profile_id', 'template_id', 'pdf_path', 'filename') : null
  if (!cv) return null
  const full = path.join(SAFE, path.basename(cv.pdf_path || ''))
  return fs.existsSync(full) ? { ...cv, path: full } : null
}
const fileName = (p, t) => `${String(p.full_name || 'CV').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}${t?.name ? `_${String(t.name).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30)}` : ''}.pdf`

/** Everything checked before the first message. Throws what to tell the person. */
export async function prepareSend(db, { profileId, cvId = null, templateId = null, agentIds = [], again = [] }) {
  const p = await db('profiles').where('id', Number(profileId)).first()
  const no = await mayNot(db, p)
  if (no) throw new Error(no)
  const ids = [...new Set((agentIds || []).map(Number).filter(Boolean))]
  if (!ids.length) throw new Error('Pick the agents')
  if (ids.length > MOST) throw new Error(`At most ${MOST} agents at once`)
  const agents = (await agentsOf(db).whereIn('id', ids).andWhere('active', 1)).map(agentRow)
  if (!agents.length) throw new Error('Those agents are not the agency\'s any more')
  const had = await lastSent(db, p.id), yes = new Set((again || []).map(Number))
  const before = agents.filter(a => had[a.id] && !yes.has(a.id)).map(a => ({ agent_id: a.id, agent: a.name, ...had[a.id] }))
  if (before.length) throw Object.assign(new Error(`Already sent to ${before.map(b => b.agent).join(', ')}`), { before })
  const video = await selfVideo(db, p.id)
  if (!video && /^\s*have/i.test(p.work_experience || '')) throw new Error(`${p.full_name} has experience: upload her self video first (Self Video on her profile) — it is sent with her CV`)
  let file = await madeCv(db, cvId)
  if (file && Number(file.profile_id) !== p.id) throw new Error('That CV is not hers')
  let tid = file?.template_id || Number(templateId) || null
  if (!file) {
    if (!tid) throw new Error('Make the CV first')
    const made = await cvFor(db, p, tid)
    file = { id: made.generated_cv_id || null, path: made.path, template_id: tid }
  }
  const t = tid ? await db('cv_templates').where('id', tid).first('name') : null
  return { p, agents, video, file: { ...file, name: fileName(p, t) }, templateId: tid }
}

/** Starts it (after prepareSend): a job the page follows. One job at a time on this PC. */
export function startSend(db, ready, transport, { by = '', from = '', gap = () => 4000 + Math.random() * 5000 } = {}) {
  const id = nextJob++
  const job = { id, running: true, total: ready.agents.length, done: 0, sent: 0, failed: 0, results: [], agent: '' }
  jobs.set(id, job)
  for (const k of jobs.keys()) if (jobs.size > 30 && !jobs.get(k).running) jobs.delete(k)
  going = going.then(() => run(db, job, ready, transport, { by, from, gap })).catch(e => { job.error = String(e?.message || e) }).finally(() => { job.running = false; job.agent = '' })
  return job
}

/** One agent: her CV (and her self video once). Returns the message id; throws when it did not go. */
async function toAgent(db, a, { p, file, video }, transport, { by, from, videoToo = true }) {
  const id = await transport.send(a.chat_id, { path: file.path, name: file.name, mime: 'application/pdf', asFile: true, caption: `${p.full_name}${p.passport_number ? ' · ' + p.passport_number : ''}` })
  return { id, after: async () => {
    if (!video || !videoToo) return
    const sent = await db('whatsapp_sends').where({ profile_id: p.id, agent_id: a.id, status: 'sent' }).whereNull('template_id').first('id').catch(() => null)
    if (sent) return
    const row = { profile_id: p.id, agent_id: a.id, template_id: null, chat_id: a.chat_id, user_key: transport.key, sent_at: now() }
    try {
      const vid = await transport.send(a.chat_id, { path: video.path, name: video.name, mime: 'video/mp4', asFile: video.size > 16 * 1024 * 1024, caption: `🎥 ${p.full_name}` })
      await record(db, { ...row, message_id: vid, status: 'sent' }, { sent_by: by, sent_from: from })
    } catch (e) { return `her video did not go: ${String(e?.message || e)}` }
  } }
}

async function run(db, job, ready, transport, { by, from, gap }) {
  let first = true
  for (const a of ready.agents) {
    job.agent = a.name
    if (!first) await pause(gap())
    first = false
    const row = { profile_id: ready.p.id, agent_id: a.id, template_id: ready.templateId, chat_id: a.chat_id, user_key: transport.key, sent_at: now() }
    const extra = { sent_by: by, sent_from: from, cv_id: ready.file.id || null }
    try {
      const { id, after } = await toAgent(db, a, ready, transport, { by, from })
      await record(db, { ...row, message_id: id, status: 'sent' }, { ...extra, ack: 1 })
      const note = await after()
      job.sent++
      job.results.push({ agent: a.name, ok: true, ...(note ? { note } : {}) })
    } catch (e) {
      const why = String(e?.message || e).slice(0, 300)
      await record(db, { ...row, status: 'failed', error: why }, extra).catch(() => {})
      job.failed++
      job.results.push({ agent: a.name, ok: false, error: why })
      // Over the pace limit or signed out: the others would fail the same way.
      if (e?.stop) { for (const b of ready.agents.slice(ready.agents.indexOf(a) + 1)) { job.failed++; job.results.push({ agent: b.name, ok: false, error: why }) } job.done = job.total; return }
    }
    job.done++
  }
}

/** Retry (a click): the same girl, agent and CV; the same line, sent again. */
export async function retrySend(db, id, transportOf, { by = '', from = '' } = {}) {
  const s = await db('whatsapp_sends').where('id', Number(id)).first()
  if (!s) throw new Error('That line is gone')
  if (s.status !== 'failed') throw new Error('It went already')
  const a = agentRow(await agentsOf(db).where({ id: s.agent_id, active: 1 }).first())
  if (!a) throw new Error('That agent is not the agency\'s any more')
  // Sent to them since (another line): asked like any second time.
  const ready = await prepareSend(db, { profileId: s.profile_id, cvId: s.cv_id, templateId: s.template_id, agentIds: [a.id] })
  const transport = await transportOf()
  try {
    const { id: mid, after } = await toAgent(db, a, ready, transport, { by, from })
    await change(db, s.id, { status: 'sent', error: null, message_id: mid, sent_at: now(), user_key: transport.key, chat_id: a.chat_id }, { sent_by: by, sent_from: from, ack: 1 })
    await after()
    return { ok: true }
  } catch (e) {
    await change(db, s.id, { error: String(e?.message || e).slice(0, 300), sent_at: now() }, { sent_by: by, sent_from: from })
    throw e
  }
}
