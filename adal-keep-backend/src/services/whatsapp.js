/**
 * The agency's WhatsApp (Settings → WhatsApp): signed in once by scanning a QR
 * code — it IS web.whatsapp.com, a tab in Adal Keep's own Brave, so a person
 * already signed in there is connected at once.
 *
 * A person chooses who gets a CV (profile → "Send CV to agents"); each agent
 * (a WhatsApp chat in Saudi Arabia) gets her CV made with the agent's own
 * template(s). When Musaned says an employer chose her, the agent who chose
 * her keeps it and the CV is deleted for everyone at the others (or, when it
 * is too old to delete, answered with "Selected — no longer available").
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getBrowser } from './browser.js'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// "WhatsApp was connected" — connect again by itself after a restart.
const ON_FLAG = path.join(BACKEND, 'data', 'whatsapp-on')
// WhatsApp lets a sender delete a message for everyone for about 2 days.
const DELETE_WINDOW_MS = 46 * 3600 * 1000

let client = null
let dbRef = null
export const state = { status: 'off', qr: null, me: null, error: null, since: null }
const set = (s) => Object.assign(state, s, { since: new Date().toISOString() })

/**
 * Let go of WhatsApp's tab only. The library's own destroy()/logout() close
 * the whole browser — here that is Adal Keep's Brave with the robots' tabs.
 */
async function release(c) {
  if (!c) return
  try { await c.pupPage?.close() } catch {}
  try { c.pupBrowser?.disconnect() } catch {}
}

/**
 * Starts WhatsApp in Adal Keep's own Brave (web.whatsapp.com, a tab like any
 * other): signed in there already → ready at once; otherwise a QR code.
 * Safe to call again.
 */
export async function connect(db, tries = 2) {
  if (db) dbRef = db
  if (client && state.status !== 'off' && state.status !== 'failed') return state
  set({ status: 'starting', qr: null, error: null })
  let browser
  try { browser = await getBrowser() } catch (e) { set({ status: 'failed', error: e.message }); return state }
  // One WhatsApp tab only: a second one makes WhatsApp ask "Use here?".
  for (const pg of await browser.pages().catch(() => [])) {
    if (/^https:\/\/web\.whatsapp\.com/.test(pg.url())) await pg.close().catch(() => {})
  }
  await new Promise(r => setTimeout(r, 1500))
  const { default: wweb } = await import('whatsapp-web.js')
  const c = client = new wweb.Client({ puppeteer: { browserWSEndpoint: browser.wsEndpoint(), defaultViewport: null } })
  // Its start-up runs inside the page, where a failure is silent: say it.
  // WhatsApp opens and closes a hidden PDF-viewer frame while it starts; a
  // set-up call that touches every frame then fails although WhatsApp's own
  // tab is fine — repeat it (each step is safe to repeat).
  const attach = c.attachEventListeners.bind(c)
  c.attachEventListeners = async (...a) => {
    for (let i = 1; ; i++) {
      try { return await attach(...a) } catch (e) {
        if (i < 5 && c.pupPage && !c.pupPage.isClosed() && /Target closed|Session closed|detached/i.test(String(e?.message || e))) {
          await new Promise(r => setTimeout(r, 700)); continue
        }
        await startFailed(e); throw e
      }
    }
  }
  c.on('qr', async (qr) => {
    try { const QR = (await import('qrcode')).default; set({ status: 'qr', qr: await QR.toDataURL(qr, { margin: 1, width: 280 }) }) }
    catch (e) { set({ status: 'qr', qr: null, error: e.message }) }
  })
  c.on('authenticated', () => { if (state.status !== 'ready') set({ status: 'signing-in', qr: null }) })
  c.on('ready', () => {
    set({ status: 'ready', qr: null, error: null, me: { name: c.info?.pushname || '', number: c.info?.wid?.user || '' } })
    try { fs.writeFileSync(ON_FLAG, new Date().toISOString()) } catch {}
    setTimeout(() => closeChosenSends().catch(() => {}), 10_000)
  })
  c.on('auth_failure', (m) => set({ status: 'failed', error: `Sign-in failed: ${m}` }))
  c.on('disconnected', (why) => {
    if (client === c) client = null
    set({ status: 'off', me: null, error: why === 'LOGOUT' ? 'Signed out from the phone' : `Disconnected (${why})` })
    release(c)
  })
  let failed = false
  async function startFailed(e) {
    if (failed) return
    failed = true
    if (client === c) client = null
    await release(c)
    const why = String(e?.message || e)
    // Its tab went away while starting (an old WhatsApp tab was closing): once more.
    if (tries > 1 && /Target closed|detached|Session closed/i.test(why)) {
      console.warn('[whatsapp] tab closed while starting — trying again')
      set({ status: 'off' }); return connect(db, tries - 1)
    }
    console.warn('[whatsapp] start-up failed:', why)
    set({ status: 'failed', error: `WhatsApp did not finish starting: ${why}` })
  }
  c.initialize().catch(startFailed)
  return state
}

/** Signs Adal Keep out of WhatsApp (the phone's "Linked devices" loses it). */
export async function logout() {
  const c = client; client = null
  try { if (c && state.status === 'ready') await c.pupPage.evaluate(() => window.require('WAWebSocketModel').Socket.logout()) } catch {}
  await release(c)
  fs.rmSync(ON_FLAG, { force: true })
  set({ status: 'off', qr: null, me: null, error: null })
}

/** At start: connected before → connect again quietly (no QR needed). */
export function startWhatsApp(db) {
  dbRef = db
  if (fs.existsSync(ON_FLAG)) setTimeout(() => connect(db).catch(e => console.warn('[whatsapp]', e.message)), 45_000)
  setInterval(() => closeChosenSends().catch(() => {}), 30 * 60_000).unref?.()
}

const ready = () => { if (!client || state.status !== 'ready') throw new Error('WhatsApp is not connected — Settings → WhatsApp'); return client }

/** Chats to pick an agent from (newest first) — names only, read straight from WhatsApp's list. */
export async function listChats() {
  const rows = await ready().pupPage.evaluate(() => window.require('WAWebCollections').Chat.getModelsArray().map(c => ({
    id: c.id?._serialized, server: c.id?.server,
    name: c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || c.id?.user || '',
    at: Number(c.t) || 0,
  })))
  return rows.filter(c => c.id && c.server !== 'newsletter' && c.server !== 'broadcast')
    .sort((a, b) => b.at - a.at).slice(0, 400)
    .map(c => ({ id: c.id, name: c.name, group: c.server === 'g.us', at: c.at }))
}

/** One number → its chat id (when the agent is not in the chat list yet). */
export async function chatForNumber(number) {
  const digits = String(number || '').replace(/\D/g, '')
  if (digits.length < 8) throw new Error('Type the full number with the country code (966…)')
  const id = await ready().getNumberId(digits)
  if (!id) throw new Error('That number is not on WhatsApp')
  return id._serialized
}

const parseIds = (v) => { try { return (JSON.parse(v || '[]') || []).map(Number).filter(Boolean) } catch { return [] } }
export const agentRow = (a) => a && ({ ...a, template_ids: parseIds(a.template_ids), active: !!a.active })

/**
 * Sends her CV to the chosen agents (each with its own template(s)).
 * Returns one line per agent and template.
 */
export async function sendCV(db, profileId, agentIds, by = '') {
  const c = ready()
  const { default: wweb } = await import('whatsapp-web.js')
  const { generateCvFile } = await import('../routes/cv.js')
  const p = await db('profiles').where('id', profileId).first()
  if (!p) throw new Error('Profile not found')
  if (p.chosen_at) throw new Error(`${p.full_name} is already chosen on Musaned`)
  let q = db('whatsapp_agents').where('active', 1)
  if (agentIds?.length) q = q.whereIn('id', agentIds)
  const agents = (await q).map(agentRow)
  if (!agents.length) throw new Error('No WhatsApp agents yet — add them in Settings → WhatsApp')
  const made = new Map() // one PDF per template, shared by the agents that use it
  const out = []
  for (const a of agents) {
    const tids = a.template_ids.length ? a.template_ids : [(await db('cv_templates').where('is_active', 1).orderBy('id').first('id'))?.id].filter(Boolean)
    if (!tids.length) { out.push({ agent: a.name, ok: false, error: 'No CV template' }); continue }
    for (const tid of tids) {
      const already = await db('whatsapp_sends').where({ profile_id: p.id, agent_id: a.id, template_id: tid, status: 'sent' }).first()
      if (already) { out.push({ agent: a.name, template_id: tid, ok: true, already: true }); continue }
      try {
        if (!made.has(tid)) {
          const t = await db('cv_templates').where('id', tid).first()
          if (!t) throw new Error(`Template ${tid} was deleted`)
          made.set(tid, await generateCvFile(db, p, t, {}, 'whatsapp'))
        }
        const f = made.get(tid)
        const media = wweb.MessageMedia.fromFilePath(f.path)
        media.filename = f.original_name
        const msg = await c.sendMessage(a.chat_id, media, { sendMediaAsDocument: true, caption: `${p.full_name}${p.passport_number ? ' · ' + p.passport_number : ''}` })
        await db('whatsapp_sends').insert({ profile_id: p.id, agent_id: a.id, template_id: tid, chat_id: a.chat_id, message_id: msg.id._serialized, status: 'sent', sent_at: new Date().toISOString() })
        out.push({ agent: a.name, template_id: tid, ok: true })
      } catch (e) {
        await db('whatsapp_sends').insert({ profile_id: p.id, agent_id: a.id, template_id: tid, chat_id: a.chat_id, status: 'failed', error: e.message.slice(0, 300), sent_at: new Date().toISOString() })
        out.push({ agent: a.name, template_id: tid, ok: false, error: e.message })
      }
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500)) // a person's pace
    }
  }
  if (by) console.log(`[whatsapp] ${p.full_name}: CV sent by ${by} to ${out.filter(o => o.ok && !o.already).length} chat(s)`)
  return out
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim()
/** The agent whose Musaned office name matches the office that chose her. */
export function officeMatches(agentOffice, musanedPro) {
  const a = norm(agentOffice), b = norm(musanedPro)
  if (!a || !b) return false
  return a === b || b.includes(a) || a.includes(b)
}

/**
 * Musaned says she was chosen (by `musanedPro`): the matching agent's sends
 * become "chosen here"; the others are deleted for everyone, or answered
 * "Selected" when too old to delete. Works later too (WhatsApp off now →
 * done when it is back, by the 3-hourly check).
 */
export async function onChosen(db, profileId) {
  db ||= dbRef
  if (!db) return
  const p = await db('profiles').where('id', profileId).first('id', 'full_name', 'musaned_pro', 'chosen_at')
  if (!p?.chosen_at) return
  const open = await db('whatsapp_sends').where({ profile_id: p.id, status: 'sent' })
  if (!open.length) return
  const agents = new Map((await db('whatsapp_agents')).map(a => [a.id, a]))
  const now = new Date().toISOString()
  for (const s of open) {
    const a = agents.get(s.agent_id)
    if (a && officeMatches(a.musaned_office, p.musaned_pro)) {
      await db('whatsapp_sends').where('id', s.id).update({ status: 'chosen_here', closed_at: now })
      continue
    }
    if (!client || state.status !== 'ready') continue // later, when WhatsApp is back
    try {
      const msg = await client.getMessageById(s.message_id)
      const young = Date.now() - new Date(s.sent_at).getTime() < DELETE_WINDOW_MS
      if (msg && young) {
        await msg.delete(true)
        await db('whatsapp_sends').where('id', s.id).update({ status: 'withdrawn', closed_at: now })
      } else {
        if (msg) await msg.reply('🔴 SELECTED — no longer available / تم اختيارها')
        else await client.sendMessage(s.chat_id, `🔴 SELECTED — ${p.full_name} is no longer available / تم اختيارها`)
        await db('whatsapp_sends').where('id', s.id).update({ status: 'marked', closed_at: now })
      }
    } catch (e) {
      await db('whatsapp_sends').where('id', s.id).update({ error: e.message.slice(0, 300) })
    }
  }
}

/** Chosen girls whose CVs are still out at other agents (WhatsApp was off). */
export async function closeChosenSends(db) {
  db ||= dbRef
  if (!db || state.status !== 'ready') return
  const rows = await db('whatsapp_sends').join('profiles', 'profiles.id', 'whatsapp_sends.profile_id')
    .where('whatsapp_sends.status', 'sent').whereNotNull('profiles.chosen_at').distinct('profiles.id as id').catch(() => [])
  for (const r of rows) await onChosen(db, r.id).catch(e => console.warn('[whatsapp]', e.message))
}

/** Her sends, for the profile page. */
export async function sendsOf(db, profileId) {
  return db('whatsapp_sends').leftJoin('whatsapp_agents', 'whatsapp_agents.id', 'whatsapp_sends.agent_id')
    .leftJoin('cv_templates', 'cv_templates.id', 'whatsapp_sends.template_id')
    .where('whatsapp_sends.profile_id', profileId).orderBy('whatsapp_sends.id', 'desc')
    .select('whatsapp_sends.*', 'whatsapp_agents.name as agent_name', 'cv_templates.name as template_name')
}
