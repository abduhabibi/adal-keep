// adal-wa-helper: see README.md. JSON lines in on stdin, out on stdout. Its sign-in stays in the folder given (argv[2]).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, Browsers } from '@whiskeysockets/baileys'

const DIR = path.resolve(process.argv[2] || '.')
const say = (o) => { try { process.stdout.write(JSON.stringify(o) + '\n') } catch {} }
const log = (m) => { try { process.stderr.write(`${m}\n`) } catch {} }
const quiet = { level: 'silent', child() { return this }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }

let sock = null, stopped = true, tries = 0, timer = null, ready = false
const sent = new Map()   // id → the message (a phone asking for it again gets it)
const keep = (m) => { if (!m?.key?.id) return; sent.set(m.key.id, m.message); if (sent.size > 200) sent.delete(sent.keys().next().value) }
const state = (status, more = {}) => say({ event: 'state', status, ...more })

async function start() {
  clearTimeout(timer)
  stopped = false
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const { state: auth, saveCreds } = await useMultiFileAuthState(DIR)
  const signed = !!auth.creds.registered || !!auth.creds.me
  state(signed ? 'connecting' : 'starting')
  const s = sock = makeWASocket({
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, quiet) },
    logger: quiet, browser: Browsers.windows('Chrome'),
    markOnlineOnConnect: false,          // the person's phone still rings for its messages
    syncFullHistory: false, generateHighQualityLinkPreview: false, emitOwnEvents: false,
    shouldIgnoreJid: (j) => /@(newsletter|broadcast)$/.test(j || ''),
    getMessage: async (k) => sent.get(k.id),
  })
  s.ev.on('creds.update', saveCreds)
  s.ev.on('connection.update', (u) => {
    if (s !== sock) return
    if (u.qr) state('qr', { qr: u.qr })
    if (u.connection === 'open') { tries = 0; ready = true; state('ready', { me: { id: s.user?.id || '', name: s.user?.name || '', number: String(s.user?.id || '').split(/[:@]/)[0] } }) }
    if (u.connection !== 'close') return
    ready = false
    const code = u.lastDisconnect?.error?.output?.statusCode
    const why = String(u.lastDisconnect?.error?.message || '')
    if (stopped) return state('off')
    if (code === DisconnectReason.loggedOut) { wipe(); stopped = true; return state('off', { signed_out: true, error: 'Signed out from the phone' }) }
    const now = !!s.authState?.creds?.me
    // Nobody scanned the QR: not asked again by itself (a person presses Sign in).
    if (!now && code === DisconnectReason.timedOut && /QR/i.test(why)) { stopped = true; return state('off', { error: 'Nobody scanned the QR' }) }
    if ([DisconnectReason.badSession, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch].includes(code)) { stopped = true; return state('failed', { error: code === DisconnectReason.forbidden ? 'WhatsApp refused this number (blocked or restricted)' : why }) }
    if (code === DisconnectReason.connectionReplaced) { stopped = true; return state('failed', { error: 'This WhatsApp sign-in is open in another program' }) }
    const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 2000 * 2 ** Math.min(tries++, 5)) * (0.8 + Math.random() * 0.4)
    state(now ? 'connecting' : 'starting', wait > 4000 ? { error: 'No connection to WhatsApp: trying again' } : {})
    timer = setTimeout(() => start().catch(e => state('failed', { error: e.message })), wait)
  })
  s.ev.on('messages.update', (list) => { for (const { key, update } of list) if (key?.fromMe && update?.status) ack(key, Number(update.status) - 1) })
  s.ev.on('message-receipt.update', (list) => { for (const { key, receipt } of list) if (key?.fromMe) ack(key, receipt?.readTimestamp ? 3 : receipt?.receiptTimestamp ? 2 : 0) })
}
function ack(key, n) { if (n >= 1) say({ event: 'ack', message_id: idOf(key), ack: Math.min(3, n) }) }
function wipe() { try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {} }

const jid = (chat) => /@c\.us$/.test(chat) ? chat.replace(/@c\.us$/, '@s.whatsapp.net') : chat
const idOf = (k) => `own_${k.id}`
const need = () => { if (!sock || !ready) throw new Error('WhatsApp on this computer is not signed in'); return sock }

const CMDS = {
  async start() { if (!sock || stopped) await start(); return true },
  async stop() { stopped = true; clearTimeout(timer); ready = false; try { sock?.end(undefined) } catch {} sock = null; state('off'); return true },
  async logout() { stopped = true; clearTimeout(timer); const s = sock; try { if (ready) await s.logout() } catch {} try { s?.end(undefined) } catch {} sock = null; ready = false; wipe(); state('off'); return true },
  async send({ chat, path: file, name, mime, caption, asFile }) {
    const s = need(), data = fs.readFileSync(file)
    const m = await s.sendMessage(jid(chat), !asFile && /^video\//.test(mime || '') ? { video: data, mimetype: mime, caption } : { document: data, mimetype: mime || 'application/octet-stream', fileName: name, caption })
    keep(m)
    return idOf(m.key)
  },
  async text({ chat, text, quoted }) { const s = need(); const m = await s.sendMessage(jid(chat), { text: String(text).slice(0, 2000) }, quoted && sent.has(quoted.replace(/^own_/, '')) ? { quoted: { key: { remoteJid: jid(chat), fromMe: true, id: quoted.replace(/^own_/, '') }, message: sent.get(quoted.replace(/^own_/, '')) } } : {}); keep(m); return idOf(m.key) },
  async revoke({ chat, message_id }) { await need().sendMessage(jid(chat), { delete: { remoteJid: jid(chat), fromMe: true, id: String(message_id).replace(/^own_/, '') } }); return true },
  async check({ number }) { const [r] = await need().onWhatsApp(String(number).replace(/\D/g, '')) || []; return r?.exists ? r.jid : null },
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let q
  try { q = JSON.parse(line) } catch { return }
  try { if (!CMDS[q.cmd]) throw new Error('unknown'); say({ id: q.id, ok: true, result: await CMDS[q.cmd](q) }) }
  catch (e) { say({ id: q.id, ok: false, error: String(e?.message || e) }) }
}).on('close', () => process.exit(0))   // Adal Keep closed: this ends too
process.on('uncaughtException', (e) => log(`helper: ${e?.message || e}`))
process.on('unhandledRejection', (e) => log(`helper: ${e?.message || e}`))
say({ event: 'hello', version: 1 })
