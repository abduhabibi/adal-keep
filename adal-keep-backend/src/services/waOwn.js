/**
 * This PC's own WhatsApp (behind a switch, off until the owner turns it on): each
 * PC — Main and Companions — signs in to its own with a QR, and each employee's CVs
 * go from there. The sign-in stays in this PC's data/whatsapp-own: never copied,
 * synced or backed up.
 *
 * No browser: a separate small program (wa-helper, Baileys; ~110 MB against ~700 MB
 * for a hidden browser) run only while this PC is signed in or signing in. Its file
 * is not in a release: data/wa-helper/wa-helper.mjs, and only the one whose SHA-256
 * is written here is run.
 *
 * Only to the agency's agents, only what a person sent, with a pace limit here on
 * the sending PC (whoever asked). On: settings "own_whatsapp" = 1. Never: ADAL_OWN_WHATSAPP=0.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { spawn } from 'child_process'
import { instanceId } from './mainPC.js'
import { whatsappAllowed, officeMatches } from './whatsapp.js'
import { acked, change } from './waRecords.js'

export const HELPER_SHA = 'f004a0c4ce728c579b12fe36e6654777f84b3819b4f9db18c004e357d4121c08'
const DATA = path.join(import.meta.dirname, '..', '..', 'data')
const DIR = path.join(DATA, 'whatsapp-own')
const HELPER = () => process.env.ADAL_WA_HELPER || path.join(DATA, 'wa-helper', 'wa-helper.mjs')
export const SETTING = 'own_whatsapp'
export const LIMITS = { gapMs: 5000, hour: 40, day: 150 }

export const neverHere = () => process.env.ADAL_OWN_WHATSAPP === '0' || !whatsappAllowed()
export async function ownOn(db) {
  if (neverHere()) return false
  return (await db('settings').where('key', SETTING).first('value').catch(() => null))?.value === '1'
}
export async function setOwn(db, on) {
  const at = new Date().toISOString(), row = { value: on ? '1' : '0', updated_at: at }
  if (!(await db('settings').where('key', SETTING).update(row))) await db('settings').insert({ key: SETTING, ...row, created_at: at })
  if (!on) await stop(); else ensure(db).catch(() => {})
  return on
}

/** The program's file is there and is exactly the one this version knows. */
let checked = null
export function helperReady(file = HELPER(), sha = HELPER_SHA) {
  try {
    const st = fs.statSync(file), k = `${file}:${st.size}:${st.mtimeMs}`
    if (checked?.k !== k) checked = { k, sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
    return checked.sha === sha
  } catch { return false }
}

export const ownKey = () => `pc:${instanceId()}`
let states = 0
let dbRef = null, child = null, nextId = 1, restarts = 0, watching = false
const waiting = new Map()
let st = { status: 'off', qr: null, me: null, error: null, at: null }
const set = (x) => { st = { ...st, ...x, at: new Date().toISOString() } }
const signedIn = () => fs.existsSync(path.join(DIR, 'creds.json'))
export const ownState = () => ({ ...st, own: true, pc: os.hostname(), key: ownKey(), installed: helperReady() })

function ask(cmd, args = {}, ms = 30_000) {
  return new Promise((ok, no) => {
    if (!child) return no(new Error('WhatsApp on this computer is not signed in'))
    const id = nextId++
    const t = setTimeout(() => { waiting.delete(id); no(new Error('WhatsApp did not answer')) }, ms)
    waiting.set(id, { ok, no, t })
    child.stdin.write(JSON.stringify({ ...args, id, cmd }) + '\n')
  })
}

/** How far a message went; its record may still be on its way here (written on the main PC): looked for again twice. */
async function heard(id, n, again = [20_000, 180_000]) {
  if (await acked(dbRef, id, n) || !again.length) return
  setTimeout(() => heard(id, n, again.slice(1)).catch(() => {}), again[0]).unref?.()
}
async function onLine(line) {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id) {
    const w = waiting.get(m.id)
    if (!w) return
    waiting.delete(m.id); clearTimeout(w.t)
    return m.ok ? w.ok(m.result) : w.no(new Error(m.error))
  }
  if (m.event === 'ack') return heard(m.message_id, Number(m.ack))
  if (m.event !== 'state') return
  const turn = ++states
  let qr = null
  if (m.status === 'qr' && m.qr) { try { qr = await (await import('qrcode')).default.toDataURL(m.qr, { margin: 1, width: 300, errorCorrectionLevel: 'L' }) } catch {} }
  if (turn !== states) return   // (a newer state came while the QR was drawn)
  set({ status: m.status, qr, me: m.status === 'ready' ? m.me || null : st.me && m.status === 'connecting' ? st.me : null, error: m.error || null })
  if (m.status === 'ready') { restarts = 0; setTimeout(() => closeChosen().catch(() => {}), 15_000).unref?.() }
  // Signed out, or nobody scanned: nothing left to run.
  if (['off', 'failed'].includes(m.status) && child) { const c = child; setTimeout(() => { if (child === c && ['off', 'failed'].includes(st.status)) c.kill() }, 1500).unref?.() }
}

function launch() {
  if (child) return
  if (!helperReady()) throw new Error('The WhatsApp program is not on this computer yet (data/wa-helper)')
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const c = child = spawn(process.execPath, ['--max-old-space-size=160', HELPER(), DIR], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE } })
  readline.createInterface({ input: c.stdout }).on('line', (l) => { onLine(l).catch(() => {}) })
  readline.createInterface({ input: c.stderr }).on('line', (l) => console.warn('[own-whatsapp]', l.slice(0, 200)))
  c.stdin.on('error', () => {})
  c.on('error', (e) => { if (child === c) { child = null; set({ status: 'failed', qr: null, error: e.message }) } })
  c.on('exit', () => {
    if (child !== c) return
    child = null
    for (const w of waiting.values()) { clearTimeout(w.t); w.no(new Error('WhatsApp on this computer stopped')) }
    waiting.clear()
    if (['off', 'failed'].includes(st.status)) return
    set({ status: 'off', qr: null, error: 'It stopped' })
    // Ended by itself while signed in: started again, later each time, five times.
    if (signedIn() && restarts++ < 5) setTimeout(() => ensure(dbRef).catch(() => {}), 10_000 * restarts).unref?.()
  })
}

/** Sign in (a person pressed it): a QR comes, or it is back at once when it was signed in before. */
export async function connect(db) {
  dbRef = db
  if (!(await ownOn(db))) throw new Error('Own WhatsApp is off')
  if (st.status === 'ready' && child) return ownState()
  set({ status: 'starting', qr: null, error: null })
  try { launch(); await ask('start') } catch (e) { set({ status: 'failed', error: e.message }); throw e }
  return ownState()
}
async function stop() { const c = child; if (c) { set({ status: 'off', qr: null, me: null, error: null }); try { await ask('stop', {}, 3000) } catch {} child = null; try { c.kill() } catch {} } }
export async function logout() {
  if (child) { try { await ask('logout', {}, 15_000) } catch {} }
  await stop()
  fs.rmSync(DIR, { recursive: true, force: true })
  set({ status: 'off', qr: null, me: null, error: null })
  return ownState()
}
/** Signed in before and switched on: connected again (no QR). Nothing runs otherwise. */
export async function ensure(db) {
  dbRef = db
  if (child || !(await ownOn(db)) || !signedIn() || !helperReady()) return
  await connect(db)
}

// ── Sending, from this PC only ──────────────────────────────────────────────

/** '' or why not now: one after the other, at most so many an hour and a day (what really went, from the records). */
let lastAt = 0
let mine = []   // when this PC sent (the records of a send made on the main PC's pages come a little later)
export async function paceStop(db, now = Date.now(), key = ownKey()) {
  const since = (ms) => new Date(now - ms).toISOString()
  const n = async (ms) => Number((await db('whatsapp_sends').where('user_key', key).whereNot('status', 'failed').where('sent_at', '>', since(ms)).count({ c: '*' }).first())?.c || 0)
  mine = mine.filter(t => t > now - 86400_000)
  const most = async (ms) => Math.max(await n(ms), mine.filter(t => t > now - ms).length)
  if (await most(86400_000) >= LIMITS.day) return `${LIMITS.day} messages went from this WhatsApp in 24 hours: the rest tomorrow (so WhatsApp does not block the number)`
  if (await most(3600_000) >= LIMITS.hour) return `${LIMITS.hour} messages went from this WhatsApp in an hour: wait a little (so WhatsApp does not block the number)`
  return ''
}
let line = Promise.resolve()
/** One file to one of the agency's agents. Refuses anyone else, whoever asks. */
export function sendFile(db, chat, f) {
  const job = line.then(async () => {
    if (!(await ownOn(db))) throw Object.assign(new Error('Own WhatsApp is off'), { stop: true })
    if (!(await db('whatsapp_agents').where({ chat_id: String(chat), active: 1 }).first('id'))) throw new Error('Not one of the agency\'s agents')
    const full = await paceStop(db)
    if (full) throw Object.assign(new Error(full), { stop: true })
    if (st.status !== 'ready') throw Object.assign(new Error('WhatsApp on this computer is not signed in'), { stop: true })
    const wait = lastAt + LIMITS.gapMs + Math.random() * 3000 - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastAt = Date.now()
    const id = await ask('send', { chat: String(chat), path: f.path, name: f.name, mime: f.mime, caption: f.caption, asFile: f.asFile !== false }, 120_000)
    mine.push(Date.now())
    return id
  })
  line = job.catch(() => {})
  return job
}
export const ownTransport = (db) => ({ key: ownKey(), label: `WhatsApp on ${os.hostname()}`, send: (chat, f) => sendFile(db, chat, f) })
/** A number → its chat, through this PC's WhatsApp (adding an agent). */
export async function checkNumber(number) {
  const jid = await ask('check', { number }, 20_000)
  if (!jid) throw new Error('That number is not on WhatsApp')
  return String(jid).replace(/@s\.whatsapp\.net$/, '@c.us')
}

/** She was chosen: what THIS WhatsApp sent of her is kept at the agent who chose her, taken back (or marked) at the others. */
let closing = false
export async function closeChosen(db = dbRef, { tell = ask, key = ownKey(), ready = () => st.status === 'ready' } = {}) {
  if (!db || closing || !ready()) return 0
  closing = true
  let n = 0
  try {
    const rows = await db('whatsapp_sends as s').join('profiles as p', 'p.id', 's.profile_id').leftJoin('whatsapp_agents as a', 'a.id', 's.agent_id')
      .where('s.user_key', key).where('s.status', 'sent').whereNotNull('p.chosen_at').limit(50)
      .select('s.id', 's.chat_id', 's.message_id', 'p.full_name', 'p.musaned_pro', 'a.musaned_office')
    for (const r of rows) {
      const closed_at = new Date().toISOString()
      try {
        if (officeMatches(r.musaned_office, r.musaned_pro)) { await change(db, r.id, { status: 'chosen_here', closed_at }); n++; continue }
        try { if (!r.message_id) throw new Error('none'); await tell('revoke', { chat: r.chat_id, message_id: r.message_id }); await change(db, r.id, { status: 'withdrawn', closed_at, error: null }) }
        catch { await tell('text', { chat: r.chat_id, quoted: r.message_id || '', text: `🔴 SELECTED — ${r.full_name} is no longer available / تم اختيارها` }); await change(db, r.id, { status: 'marked', closed_at, error: null }) }
        n++
        await new Promise(x => setTimeout(x, tell === ask ? 3000 : 0))
      } catch (e) { await change(db, r.id, { error: String(e?.message || e).slice(0, 300) }) }
    }
  } finally { closing = false }
  return n
}

/** At start: nothing runs unless it is switched on and this PC was signed in. */
export function startOwnWhatsApp(db) {
  dbRef = db
  if (neverHere() || watching) return
  watching = true
  setTimeout(() => ensure(db).catch(e => console.warn('[own-whatsapp]', e.message)), 30_000).unref?.()
  import('./changes.js').then(({ onChanged }) => {
    let soon = null
    onChanged(({ tables }) => {
      if (tables.includes('settings')) ownOn(db).then(on => { if (!on) return stop(); return ensure(db) }).catch(() => {})
      if (st.status === 'ready' && tables.includes('profiles') && !soon) { soon = setTimeout(() => { soon = null; closeChosen(db).catch(() => {}) }, 60_000); soon.unref?.() }
    })
  }).catch(() => {})
  process.once('exit', () => { try { child?.kill() } catch {} })
}
