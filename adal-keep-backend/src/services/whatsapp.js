import { execFileSync } from 'child_process'
/**
 * WhatsApp for every person of the agency (Settings → WhatsApp): each employee
 * links their own WhatsApp — a QR code, or a code for "Link with phone number"
 * when they are on the phone. It IS web.whatsapp.com:
 *  - the first account lives in Adal Keep's own Brave (a tab like any other,
 *    so whoever is signed in there already is connected at once);
 *  - every other account in its own hidden Brave (data/whatsapp/session-…),
 *    because one browser holds only one WhatsApp.
 *
 * A person chooses who gets a CV (profile → CV on WhatsApp, or CVs → WhatsApp);
 * each of their agents (a chat in Saudi Arabia) gets her CV made with the
 * agent's own template(s). When Musaned says an employer chose her, the agent
 * who chose her keeps it and the CV is deleted for everyone at the others (or,
 * when too old to delete, answered "Selected — no longer available").
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getBrowser, findBrowserExecutable } from './browser.js'

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIR = path.join(BACKEND, 'data', 'whatsapp')
// Which accounts were connected (to connect again after a restart) and which one lives in Adal Keep's Brave.
const NOTE = path.join(DIR, 'accounts.json')

let dbRef = null
const sessions = new Map() // key → { client, state, own }

/** Who is asking: the employee chosen on that PC or phone (?u=…), else the agency's owner. */
export const keyOf = (u) => {
  const k = String(u ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
  return k && k !== 'undefined' && k !== 'null' ? `u${k}` : 'owner'
}

const readNote = () => { try { return JSON.parse(fs.readFileSync(NOTE, 'utf8')) } catch { return { brave: null, on: [] } } }
const writeNote = (n) => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(NOTE, JSON.stringify(n)) } catch {} }
const noteOn = (key, on) => {
  const n = readNote()
  n.on = [...new Set([...(n.on || []).filter(k => k !== key), ...(on ? [key] : [])])]
  writeNote(n)
}

const blank = () => ({ status: 'off', qr: null, code: null, me: null, error: null, since: null, where: null })
const session = (key) => {
  if (!sessions.has(key)) sessions.set(key, { client: null, state: blank(), own: false })
  return sessions.get(key)
}
export const stateOf = (key) => {
  const s = session(key)
  // Its WhatsApp tab is gone (Brave closed or restarted): that QR is dead — say so.
  if (['qr', 'starting', 'code'].includes(s.state.status) && s.client && (!s.client.pupPage || s.client.pupPage.isClosed?.())) {
    if (s.client.pupPage) { s.client = null; setState(key, { status: 'off', qr: null, code: null, error: 'The WhatsApp tab was closed — press Connect again' }) }
  }
  return s.state
}

/**
 * The browser WhatsApp is told it is: the real one (a current Brave/Chrome).
 * whatsapp-web.js says "Chrome 101" by default, which WhatsApp now refuses to
 * link (the QR shows, the phone says it could not link).
 */
let chromeMajor = null
function realUserAgent(exe, fromBrowser = '') {
  let ua = String(fromBrowser || '').replace('HeadlessChrome', 'Chrome')
  if (/Chrome\/(\d+)/.test(ua) && Number(ua.match(/Chrome\/(\d+)/)[1]) >= 120) return ua
  if (chromeMajor === null) {
    chromeMajor = 142
    try { const v = execFileSync(exe, ['--version'], { timeout: 5000 }).toString().match(/(\d{3})\.\d+/); if (v) chromeMajor = Number(v[1]) } catch {}
  }
  const osPart = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${osPart}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`
}
const setState = (key, s) => Object.assign(session(key).state, s, { since: new Date().toISOString() })

/** Adal Keep's Brave holds this account (the first one connected). */
function inBrave(key) {
  const n = readNote()
  if (n.brave && n.brave !== key) return false
  if (!n.brave) writeNote({ ...n, brave: key })
  return true
}

/**
 * Let go of WhatsApp. The library's own destroy()/logout() close the whole
 * browser — for the Brave account that is Adal Keep's Brave with the robots'
 * tabs, so there only WhatsApp's tab is closed.
 */
async function release(c, own) {
  if (!c) return
  if (own) { try { await c.pupBrowser?.close() } catch {} return }
  try { await c.pupPage?.close() } catch {}
  try { c.pupBrowser?.disconnect() } catch {}
}

/**
 * Starts this person's WhatsApp: signed in already → ready at once; otherwise
 * a QR code, or (with `phone`) a code to type in WhatsApp → Linked devices →
 * Link with phone number instead. Safe to call again.
 */
export async function connect(db, key = 'owner', { phone = '' } = {}, tries = 2, { quiet = false } = {}) {
  if (db) dbRef = db
  const s = session(key)
  if (s.client && !['off', 'failed'].includes(s.state.status) && !phone) return s.state
  // One start-up at a time: a second one would close the first one's WhatsApp tab.
  if (s.startingAt && Date.now() - s.startingAt < 45000 && !phone) return s.state
  s.startingAt = Date.now()
  if (s.client) { const old = s.client; s.client = null; await release(old, s.own) }
  setState(key, { status: 'starting', qr: null, code: null, error: null })
  const { default: wweb } = await import('whatsapp-web.js')
  const opts = {}
  const brave = inBrave(key)
  if (brave) {
    let browser
    // Reconnecting by itself never starts Brave: it waits until Brave is open.
    if (quiet) {
      const { openBrowserIfAny } = await import('./browser.js')
      browser = await openBrowserIfAny()
      if (!browser) { setState(key, { status: 'off', error: 'Waiting for Brave to be open' }); return s.state }
    } else {
      try { browser = await getBrowser() } catch (e) { setState(key, { status: 'failed', error: e.message }); return s.state }
    }
    // One WhatsApp tab only: a second one makes WhatsApp ask "Use here?".
    for (const pg of await browser.pages().catch(() => [])) {
      if (/^https:\/\/web\.whatsapp\.com/.test(pg.url())) await pg.close().catch(() => {})
    }
    await new Promise(r => setTimeout(r, 1500))
    opts.puppeteer = { browserWSEndpoint: browser.wsEndpoint(), defaultViewport: null }
    opts.userAgent = realUserAgent(findBrowserExecutable(), await browser.userAgent().catch(() => ''))
  } else {
    const exe = findBrowserExecutable()
    if (!exe) { setState(key, { status: 'failed', error: 'Brave (or Chrome) is not installed on this PC' }); return s.state }
    opts.authStrategy = new wweb.LocalAuth({ clientId: key, dataPath: DIR })
    opts.userAgent = realUserAgent(exe)
    opts.puppeteer = { executablePath: exe, headless: true, args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio', '--disable-extensions'] }
  }
  // Always today's WhatsApp Web (a saved old copy of its page cannot link new devices).
  opts.webVersionCache = { type: 'none' }
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits) opts.pairWithPhoneNumber = { phoneNumber: digits, showNotification: true }
  const c = s.client = new wweb.Client(opts)
  s.own = !brave
  setState(key, { where: brave ? 'Adal Keep\'s Brave' : 'its own hidden window' })

  let failed = false
  async function startFailed(e) {
    if (failed) return
    failed = true
    if (s.client === c) s.client = null
    await release(c, !brave)
    const why = String(e?.message || e)
    if (tries > 1 && /Target closed|detached|Session closed/i.test(why)) {
      console.warn(`[whatsapp ${key}] tab closed while starting — trying again`)
      setState(key, { status: 'off' }); s.startingAt = 0; return connect(db, key, { phone }, tries - 1)
    }
    s.startingAt = 0
    console.warn(`[whatsapp ${key}] start-up failed:`, why)
    setState(key, { status: 'failed', error: `WhatsApp did not finish starting: ${why}` })
  }
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
    if (digits) return
    // WhatsApp's own QR now holds a link: https://wa.me/settings/linked_devices#<code>
    // (a phone no longer takes the bare code) — show exactly what its page shows.
    let text = qr
    try {
      const ref = await c.pupPage?.evaluate(() => document.querySelector('[data-ref]')?.getAttribute('data-ref'))
      if (ref && ref.includes(qr.split(',')[0])) text = ref
    } catch {}
    if (!/^https?:/.test(text)) text = `https://wa.me/settings/linked_devices#${qr}`
    try { const QR = (await import('qrcode')).default; setState(key, { status: 'qr', qr: await QR.toDataURL(text, { margin: 1, width: 300, errorCorrectionLevel: 'L' }) }) }
    catch (e) { setState(key, { status: 'qr', qr: null, error: e.message }) }
  })
  c.on('code', (code) => setState(key, { status: 'code', code: String(code).replace(/^(.{4})(.{4})$/, '$1-$2') }))
  c.on('authenticated', () => { if (s.state.status !== 'ready') setState(key, { status: 'signing-in', qr: null, code: null }) })
  c.on('ready', async () => {
    s.startingAt = 0
    await shim(c)
    setState(key, { status: 'ready', qr: null, code: null, error: null, me: { name: c.info?.pushname || '', number: c.info?.wid?.user || '' } })
    noteOn(key, true)
    setTimeout(() => closeChosenSends().catch(() => {}), 10_000)
  })
  c.on('auth_failure', (m) => { s.startingAt = 0; setState(key, { status: 'failed', error: `Sign-in failed: ${m}` }) })
  c.on('disconnected', (why) => {
    s.startingAt = 0
    if (s.client === c) s.client = null
    setState(key, { status: 'off', me: null, error: why === 'LOGOUT' ? 'Signed out from the phone' : `Disconnected (${why})` })
    if (why === 'LOGOUT') noteOn(key, false)
    release(c, !brave)
  })
  c.initialize().catch(startFailed)
  return s.state
}

/**
 * Sign in on WhatsApp's own page: a normal web.whatsapp.com tab opens in Adal
 * Keep's Brave, in front; the person scans its QR there (WhatsApp's own QR,
 * always fresh). When the tab shows the chats, Adal Keep closes it and
 * connects — already signed in, no QR of its own. Brave account only (the
 * other accounts run in a hidden window of their own).
 */
const webWatch = new Map()
export async function openWeb(db, key = 'owner') {
  if (db) dbRef = db
  const s = session(key)
  if (s.client) { const old = s.client; s.client = null; await release(old, s.own) }
  const brave = inBrave(key)
  let page, own = null
  if (brave) {
    const browser = await getBrowser()
    for (const pg of await browser.pages().catch(() => [])) {
      if (/^https:\/\/web\.whatsapp\.com/.test(pg.url())) await pg.close().catch(() => {})
    }
    page = await browser.newPage()
    await page.setUserAgent(realUserAgent(findBrowserExecutable(), await browser.userAgent().catch(() => ''))).catch(() => {})
  } else {
    // This person's own WhatsApp profile (the hidden window's), shown in a
    // window of its own for the sign-in; hidden again afterwards.
    const exe = findBrowserExecutable()
    if (!exe) throw new Error('Brave (or Chrome) is not installed on this PC')
    const { default: puppeteer } = await import('puppeteer-core').catch(() => import('puppeteer'))
    own = await puppeteer.launch({ executablePath: exe, headless: false, defaultViewport: null,
      userDataDir: path.join(DIR, `session-${key}`), args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,800'] })
    page = (await own.pages())[0] || await own.newPage()
    await page.setUserAgent(realUserAgent(exe)).catch(() => {})
  }
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await page.bringToFront().catch(() => {})
  setState(key, { status: 'web', qr: null, code: null, error: null, where: brave ? 'a web.whatsapp.com tab in Adal Keep\'s Brave' : 'a WhatsApp window on this PC' })
  clearInterval(webWatch.get(key))
  const started = Date.now()
  const closeIt = async () => { if (own) await own.close().catch(() => {}); else await page.close().catch(() => {}) }
  const t = setInterval(async () => {
    try {
      if (page.isClosed() || Date.now() - started > 10 * 60 * 1000) {
        clearInterval(t); webWatch.delete(key); await closeIt()
        if (session(key).state.status === 'web') setState(key, { status: 'off', error: page.isClosed() ? 'The WhatsApp window was closed before signing in' : 'Not signed in within 10 minutes' })
        return
      }
      // Signed in: the chat list shows.
      const on = await page.evaluate(() => !!document.querySelector('#pane-side, [data-testid="chat-list"], [aria-label="Chat list"]')).catch(() => false)
      if (!on) return
      clearInterval(t); webWatch.delete(key)
      await new Promise(r => setTimeout(r, 5000)) // let WhatsApp save its keys
      await closeIt()
      setState(key, { status: 'off' })
      await connect(dbRef, key)
    } catch {}
  }, 3000)
  webWatch.set(key, t)
  return s.state
}

/** Signs this person's WhatsApp out (their phone's "Linked devices" loses it). */
export async function logout(key = 'owner') {
  const s = session(key)
  const c = s.client; s.client = null
  try { if (c && s.state.status === 'ready') await c.pupPage.evaluate(() => window.require('WAWebSocketModel').Socket.logout()) } catch {}
  await release(c, s.own)
  if (s.own) fs.rmSync(path.join(DIR, `session-${key}`), { recursive: true, force: true })
  noteOn(key, false)
  const n = readNote()
  if (n.brave === key) writeNote({ ...n, brave: null }) // the Brave is free for the next one
  setState(key, blank())
}

/** At start: the accounts connected before connect again quietly (no QR needed). */
export function startWhatsApp(db) {
  dbRef = db
  const n = readNote()
  // Before accounts.json: the one account in Adal Keep's Brave.
  if (!n.on?.length && fs.existsSync(path.join(BACKEND, 'data', 'whatsapp-on'))) { n.brave ||= 'owner'; n.on = ['owner']; writeNote(n) }
  // Again every 2 minutes while not connected (quietly: never opens Brave itself).
  const again = () => (readNote().on || []).forEach((key, i) => setTimeout(() => {
    const st = stateOf(key).status
    if (st === 'off' || st === 'failed') connect(db, key, {}, 2, { quiet: true }).catch(e => console.warn('[whatsapp]', e.message))
  }, i * 20_000))
  setTimeout(again, 45_000)
  setInterval(again, 2 * 60_000).unref?.()
  setInterval(() => closeChosenSends().catch(() => {}), 30 * 60_000).unref?.()
}

/** Everyone's connection, for Settings (who is connected on this agency). */
export const allStates = () => [...sessions.entries()].map(([key, s]) => ({ key, ...s.state, qr: undefined, code: undefined }))

/**
 * Two fixes for WhatsApp's newer pages (harmless once the library catches up):
 *  - message ids dropped the `_serialized` text the library reads everywhere
 *    (send, find, delete); their toString() is the same text — put it back;
 *  - a prepared file is a WhatsApp model whose inner links (parent,
 *    collection …) the library copies into the new message, and WhatsApp then
 *    cannot tell who sends it ("Data passed to getter must include an id") —
 *    hand over the file's plain data instead.
 */
async function shim(c) {
  await c.pupPage?.evaluate(() => {
    const K = window.require('WAWebMsgKey')
    if (K?.prototype && !('_serialized' in K.prototype)) {
      Object.defineProperty(K.prototype, '_serialized', { configurable: true, get() { return this.toString() } })
    }
    const W = window.WWebJS
    if (W?.processMediaData && !W.__plainMedia) {
      const orig = W.processMediaData
      W.processMediaData = async (...a) => {
        const r = await orig(...a)
        if (!r || typeof r.toJSON !== 'function') return r
        const plain = { ...r.toJSON() }
        for (const k of ['caption', 'clientUrl', 'deprecatedMms3Url', 'uploadhash', 'streamingSidecar', 'mediaHandle']) if (r[k] !== undefined) plain[k] = r[k]
        return plain
      }
      W.__plainMedia = true
    }
  }).catch(() => {})
}

/** A sent message's id as text ("true_<chat>_<id>_out") — WhatsApp's newer ids reach Node without it. */
export function msgIdOf(msg) {
  const id = msg?.id
  if (!id) return null
  if (typeof id === 'string') return id
  if (id._serialized) return id._serialized
  const remote = typeof id.remote === 'string' ? id.remote : id.remote?._serialized
  if (!remote || !id.id) return null
  return `${!!id.fromMe}_${remote}_${id.id}${id.self ? `_${id.self}` : ''}`
}

const ready = (key) => {
  const s = session(key)
  if (!s.client || s.state.status !== 'ready') throw new Error('Your WhatsApp is not connected — Settings → Integrations → WhatsApp')
  return s.client
}

/** Chats to pick an agent from (newest first) — names only, read straight from WhatsApp's list. */
export async function listChats(key) {
  const rows = await ready(key).pupPage.evaluate(() => window.require('WAWebCollections').Chat.getModelsArray().map(c => ({
    id: c.id?._serialized, server: c.id?.server,
    name: c.formattedTitle || c.name || c.contact?.name || c.contact?.pushname || c.id?.user || '',
    at: Number(c.t) || 0,
  })))
  return rows.filter(c => c.id && c.server !== 'newsletter' && c.server !== 'broadcast')
    .sort((a, b) => b.at - a.at).slice(0, 400)
    .map(c => ({ id: c.id, name: c.name, group: c.server === 'g.us', at: c.at }))
}

/** One number → its chat id (when the agent is not in the chat list yet). */
export async function chatForNumber(key, number) {
  const digits = String(number || '').replace(/\D/g, '')
  if (digits.length < 8) throw new Error('Type the full number with the country code (966…)')
  const id = await ready(key).getNumberId(digits)
  if (!id) throw new Error('That number is not on WhatsApp')
  return id._serialized
}

const parseIds = (v) => { try { return (JSON.parse(v || '[]') || []).map(Number).filter(Boolean) } catch { return [] } }
export const agentRow = (a) => a && ({ ...a, template_ids: parseIds(a.template_ids), active: !!a.active })
/** This person's agents (agents from before accounts belong to the first account). */
export function agentsOf(db, key) {
  const brave = readNote().brave
  return db('whatsapp_agents').where(q => { q.where('user_key', key); if (key === brave || !brave) q.orWhereNull('user_key') })
}

/** Her CV with this template: the newest one already made (file still there, made after her last change), else a new one. */
/** Her newest self video on file (field "Self Video"), or null. */
async function selfVideo(db, profileId) {
  const f = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profileId).where('profile_fields.name', 'like', 'Self Video%')
    .where('files.mimetype', 'like', 'video/%').orderBy('files.id', 'desc').first('files.path', 'files.original_name', 'files.size').catch(() => null)
  if (!f) return null
  const { resolveStoredPath } = await import('./cvRender.js')
  const abs = resolveStoredPath(f.path)
  if (!abs || !fs.existsSync(abs)) return null
  return { path: abs, name: f.original_name || path.basename(abs), size: fs.statSync(abs).size }
}

async function cvFor(db, p, tid) {
  const old = await db('generated_cvs').where({ profile_id: p.id, template_id: tid }).orderBy('id', 'desc').first().catch(() => null)
  if (old?.pdf_path && new Date(old.created_at) >= new Date(p.updated_at || 0)) {
    const full = path.join(BACKEND, 'data', 'SafeStorage', path.basename(old.pdf_path))
    if (fs.existsSync(full)) {
      const slug = (s, n) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, n)
      const t = await db('cv_templates').where('id', tid).first('name')
      return { path: full, original_name: `${slug(p.full_name || 'profile', 40)}_${slug(t?.name || 'CV', 30)}.pdf` }
    }
  }
  const t = await db('cv_templates').where('id', tid).first()
  if (!t) throw new Error(`Template ${tid} was deleted`)
  const { generateCvFile } = await import('../routes/cv.js')
  return generateCvFile(db, p, t, {}, 'whatsapp')
}

/**
 * Sends her CV to this person's chosen agents (none chosen → all of them),
 * each with its own template(s). Returns one line per agent and template.
 */
export async function sendCV(db, key, profileId, agentIds, by = '') {
  const c = ready(key)
  await shim(c) // also after WhatsApp reloaded its page
  const { default: wweb } = await import('whatsapp-web.js')
  const p = await db('profiles').where('id', profileId).first()
  if (!p) throw new Error('Profile not found')
  if (p.chosen_at) throw new Error(`${p.full_name} is already chosen on Musaned`)
  let q = agentsOf(db, key).andWhere('active', 1)
  if (agentIds?.length) q = q.whereIn('id', agentIds)
  const agents = (await q).map(agentRow)
  if (!agents.length) throw new Error('You have no WhatsApp agents yet — add them in Settings → Integrations → WhatsApp')
  const made = new Map() // one PDF per template, shared by the agents that use it
  const video = await selfVideo(db, p.id)
  const out = []
  for (const a of agents) {
    const tids = a.template_ids.length ? a.template_ids : [(await db('cv_templates').where('is_active', 1).orderBy('id').first('id'))?.id].filter(Boolean)
    if (!tids.length) { out.push({ agent: a.name, ok: false, error: 'No CV template' }); continue }
    for (const tid of tids) {
      const already = await db('whatsapp_sends').where({ profile_id: p.id, agent_id: a.id, template_id: tid, status: 'sent' }).first()
      if (already) { out.push({ agent: a.name, template_id: tid, ok: true, already: true }); continue }
      const row = { profile_id: p.id, agent_id: a.id, template_id: tid, chat_id: a.chat_id, user_key: key, sent_at: new Date().toISOString() }
      try {
        if (!made.has(tid)) made.set(tid, await cvFor(db, p, tid))
        const f = made.get(tid)
        const media = wweb.MessageMedia.fromFilePath(f.path)
        media.filename = f.original_name
        const msg = await c.sendMessage(a.chat_id, media, { sendMediaAsDocument: true, caption: `${p.full_name}${p.passport_number ? ' · ' + p.passport_number : ''}` })
        await db('whatsapp_sends').insert({ ...row, message_id: msgIdOf(msg), status: 'sent' })
        out.push({ agent: a.name, template_id: tid, ok: true })
      } catch (e) {
        await db('whatsapp_sends').insert({ ...row, status: 'failed', error: String(e?.message || e).slice(0, 300) })
        out.push({ agent: a.name, template_id: tid, ok: false, error: String(e?.message || e) })
      }
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500)) // a person's pace
    }
    // Her self video goes with her CV, once per agent (taken back with it when she is chosen).
    if (video && out.some(o => o.agent === a.name && o.ok && !o.already)) {
      const vrow = { profile_id: p.id, agent_id: a.id, template_id: null, chat_id: a.chat_id, user_key: key, sent_at: new Date().toISOString() }
      try {
        const media = wweb.MessageMedia.fromFilePath(video.path)
        media.filename = video.name
        // WhatsApp plays a video up to ~16 MB; a bigger one goes as a file.
        const msg = await c.sendMessage(a.chat_id, media, { sendMediaAsDocument: video.size > 16 * 1024 * 1024, caption: `🎥 ${p.full_name}` })
        await db('whatsapp_sends').insert({ ...vrow, message_id: msgIdOf(msg), status: 'sent' })
        out.push({ agent: a.name, video: true, ok: true })
      } catch (e) {
        out.push({ agent: a.name, video: true, ok: false, error: `video: ${String(e?.message || e)}` })
      }
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500))
    }
  }
  if (by) console.log(`[whatsapp ${key}] ${p.full_name}: CV sent by ${by} to ${out.filter(o => o.ok && !o.already).length} chat(s)`)
  return out
}

/** Many profiles at once (CVs → WhatsApp), in the background; `bulk[key]` tells how far. */
export const bulk = {}
export function sendMany(db, key, profileIds, agentIds, by = '') {
  if (bulk[key]?.running) throw new Error('Still sending the last ones — wait until it finishes')
  ready(key)
  const b = bulk[key] = { running: true, total: profileIds.length, done: 0, sent: 0, failed: 0, current: '', errors: [] }
  ;(async () => {
    for (const id of profileIds) {
      let name = ''
      try {
        name = (await db('profiles').where('id', id).first('full_name'))?.full_name || ''
        b.current = name
        const r = await sendCV(db, key, id, agentIds, by)
        b.sent += r.filter(x => x.ok && !x.already && !x.video).length
        for (const x of r.filter(x => !x.ok)) { b.failed++; b.errors.push(`${name}: ${x.agent} — ${x.error}`) }
      } catch (e) { b.failed++; b.errors.push(`${name}: ${e.message}`) }
      b.done++
    }
    b.running = false; b.current = ''; b.finished_at = new Date().toISOString()
  })()
  return b
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
 * "Selected" when too old to delete — each from the WhatsApp that sent it.
 * Works later too (that WhatsApp off now → done when it is back).
 */
export async function onChosen(db, profileId) {
  db ||= dbRef
  if (!db) return
  const p = await db('profiles').where('id', profileId).first('id', 'full_name', 'musaned_pro', 'chosen_at')
  if (!p?.chosen_at) return
  const open = await db('whatsapp_sends').where({ profile_id: p.id, status: 'sent' })
  if (!open.length) return
  const agents = new Map((await db('whatsapp_agents')).map(a => [a.id, a]))
  const brave = readNote().brave || 'owner'
  const now = new Date().toISOString()
  for (const s of open) {
    const a = agents.get(s.agent_id)
    if (a && officeMatches(a.musaned_office, p.musaned_pro)) {
      await db('whatsapp_sends').where('id', s.id).update({ status: 'chosen_here', closed_at: now })
      continue
    }
    const ses = sessions.get(s.user_key || brave)
    if (!ses?.client || ses.state.status !== 'ready') continue // later, when that WhatsApp is back
    const client = ses.client
    await shim(client)
    try {
      const r = await takeBack(client, s.message_id)
      if (r === 'deleted') {
        await db('whatsapp_sends').where('id', s.id).update({ status: 'withdrawn', closed_at: now, error: null })
      } else {
        // Too old to delete (or a chat that does not allow it): say so under her CV.
        const text = '🔴 SELECTED — no longer available / تم اختيارها'
        if (r === 'kept') await client.sendMessage(s.chat_id, text, { quotedMessageId: s.message_id })
        else await client.sendMessage(s.chat_id, `🔴 SELECTED — ${p.full_name} is no longer available / تم اختيارها`)
        await db('whatsapp_sends').where('id', s.id).update({ status: 'marked', closed_at: now, error: null })
      }
    } catch (e) {
      await db('whatsapp_sends').where('id', s.id).update({ error: String(e?.message || e).slice(0, 300) })
    }
  }
}

/**
 * Deletes a sent CV for everyone when WhatsApp still allows it (it knows its
 * own time limit). 'deleted' · 'kept' (still there, too old) · 'missing'.
 */
async function takeBack(client, messageId) {
  if (!messageId) return 'missing'
  return client.pupPage.evaluate(async (id) => {
    const C = window.require('WAWebCollections')
    const msg = C.Msg.get(id) || (await C.Msg.getMessagesById([id]))?.messages?.[0]
    if (!msg || msg.type === 'revoked') return msg ? 'deleted' : 'missing'
    const chat = C.Chat.get(msg.id.remote) || (await C.Chat.find(msg.id.remote))
    if (!chat || !window.require('WAWebMsgActionCapability').canSenderRevokeMsg(msg)) return 'kept'
    await window.require('WAWebCmd').Cmd.sendRevokeMsgs(chat, { list: [msg], type: 'message' }, { clearMedia: true })
    return 'deleted'
  }, messageId)
}

/** Chosen girls whose CVs are still out at other agents (a WhatsApp was off). */
export async function closeChosenSends(db) {
  db ||= dbRef
  if (!db || ![...sessions.values()].some(s => s.state.status === 'ready')) return
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

/**
 * CVs → WhatsApp: everyone not chosen yet who has a CV, with where her CV is
 * out now. A chosen one leaves the list.
 */
export async function available(db, key) {
  const hasDeleted = await db.schema.hasColumn('profiles', 'deleted_at')
  let q = db('profiles').whereNull('chosen_at')
  if (hasDeleted) q = q.whereNull('deleted_at')
  const rows = await q.whereExists(function () {
    this.select(db.raw(1)).from('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
      .whereRaw('profile_fields.profile_id = profiles.id').andWhere('profile_fields.name', 'CV')
  }).select('id', 'full_name', 'passport_number', 'updated_at').orderBy('id', 'desc')
  const sends = await db('whatsapp_sends').leftJoin('whatsapp_agents', 'whatsapp_agents.id', 'whatsapp_sends.agent_id')
    .whereIn('whatsapp_sends.profile_id', rows.map(r => r.id)).whereIn('whatsapp_sends.status', ['sent', 'failed'])
    .select('whatsapp_sends.profile_id', 'whatsapp_sends.status', 'whatsapp_sends.sent_at', 'whatsapp_sends.user_key', 'whatsapp_agents.name as agent_name')
  const by = new Map()
  for (const s of sends) { if (!by.has(s.profile_id)) by.set(s.profile_id, []); by.get(s.profile_id).push(s) }
  const brave = readNote().brave || 'owner'
  return rows.map(r => {
    const mine = by.get(r.id) || []
    const out = mine.filter(s => s.status === 'sent')
    return {
      ...r,
      sent_to: [...new Set(out.map(s => s.agent_name).filter(Boolean))],
      sent_by_me: out.some(s => (s.user_key || brave) === key),
      failed: !out.length && mine.some(s => s.status === 'failed'),
      last_sent: out.map(s => s.sent_at).sort().pop() || null,
    }
  })
}
