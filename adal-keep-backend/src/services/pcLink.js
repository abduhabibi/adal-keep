/**
 * A page of PC X opened on the main PC asks something of PC X's own server (its own
 * WhatsApp): the Companion keeps one line open to the main PC (it calls out, nothing
 * has to be let in) and answers on it. A page only ever reaches its own PC.
 * Open only while own WhatsApp is switched on. A file travels by a one-time address.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { mainURL, mainKey } from './mainPC.js'
import { approvedPC, ipOf } from './networkGate.js'

// ── On the main PC ──────────────────────────────────────────────────────────
const links = new Map()      // link id → { res, who, name, waiting: Map }
const files = new Map()      // token → { path, who, until }
let nextId = 1
const whoIs = (req) => { const pc = req.pcAccess || approvedPC(req); return pc ? [`pc:${pc.id}`, `ip:${ipOf(req)}`] : null }
const same = (a, b) => a.some(k => b.includes(k))
const linkOf = (req) => { const who = whoIs(req); return who ? [...links.values()].filter(l => same(l.who, who)).at(-1) || null : null }
export const linked = (req) => !!linkOf(req)

/** GET /pc-link/stream from a Companion's own server. */
export function open(req, res, onGone = () => {}) {
  const who = whoIs(req)
  if (!who) return res.status(403).end()
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const id = crypto.randomUUID()
  const l = { id, res, who, name: String(req.pcAccess?.name || '').slice(0, 80), waiting: new Map() }
  for (const [k, old] of links) if (same(old.who, who) && old.who[0] === who[0]) { links.delete(k); try { old.res.end() } catch {} }
  links.set(id, l)
  res.write(`data: ${JSON.stringify({ link: id })}\n\n`)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => { clearInterval(ping); links.delete(id); for (const w of l.waiting.values()) { clearTimeout(w.t); w.no(new Error('That computer went away')) } onGone() })
}
/** POST /pc-link/answer from it. */
export function answer(req, res) {
  const who = whoIs(req), l = links.get(String(req.body?.link || ''))
  if (!who || !l || !same(l.who, who)) return res.status(403).end()
  const w = l.waiting.get(req.body.id)
  if (w) { l.waiting.delete(req.body.id); clearTimeout(w.t); req.body.ok ? w.ok(req.body.result) : w.no(Object.assign(new Error(String(req.body.error || 'failed')), { stop: !!req.body.stop })) }
  res.json({ ok: true })
}
/** Ask the own server of the PC this page is on. */
export function askPC(req, cmd, args = {}, ms = 30_000) {
  const l = linkOf(req)
  return l ? askLink(l, cmd, args, ms) : Promise.reject(new Error('Adal Keep\'s own server on this computer is not running (its full copy)'))
}
function askLink(l, cmd, args, ms) {
  return new Promise((ok, no) => {
    const id = nextId++
    const t = setTimeout(() => { l.waiting.delete(id); no(new Error('This computer\'s Adal Keep did not answer')) }, ms)
    l.waiting.set(id, { ok, no, t })
    try { l.res.write(`data: ${JSON.stringify({ id, cmd, args })}\n\n`) } catch (e) { l.waiting.delete(id); clearTimeout(t); no(e) }
  })
}
/** A file this page's PC may take once, for two minutes. */
export function lendFile(req, file) {
  const l = linkOf(req)
  const token = crypto.randomBytes(24).toString('hex')
  files.set(token, { path: file, who: l?.who || [], until: Date.now() + 120_000 })
  for (const [k, f] of files) if (f.until < Date.now()) files.delete(k)
  return token
}
export function takeFile(req, res) {
  const who = whoIs(req), f = files.get(String(req.params.token))
  if (!f || !who || !same(f.who, who) || f.until < Date.now() || !fs.existsSync(f.path)) return res.status(404).end()
  files.delete(String(req.params.token))
  res.type('application/octet-stream')
  fs.createReadStream(f.path).on('error', () => res.end()).pipe(res)
}

// ── On the Companion ────────────────────────────────────────────────────────
let running = null
/** Keeps the line open while `wanted()` (asked every minute when closed). handle(cmd, args) → the answer. */
export function startPcLink({ wanted, handle, every = 60_000, fetchIt = fetch }) {
  if (running) return running
  let stop = false, ac = null, fails = 0
  const headers = async () => ({ 'x-adal-pc': await mainKey(), 'content-type': 'application/json' })
  const once = async () => {
    const main = mainURL()
    if (!main || !(await wanted())) return false
    ac = new AbortController()
    const r = await fetchIt(`${main}/api/pc-link/stream`, { headers: await headers(), signal: ac.signal })
    if (!r.ok || !r.body) throw new Error(`main PC answered ${r.status}`)
    fails = 0
    let link = '', rest = ''
    // Switched off meanwhile: closed at the next look. Nothing heard for 70 s: the line is dead.
    let heard = Date.now()
    const look = setInterval(async () => { if (Date.now() - heard > 70_000 || !(await wanted().catch(() => true))) ac.abort() }, 30_000)
    look.unref?.()
    try {
      for await (const chunk of Readable.fromWeb(r.body)) {
        heard = Date.now()
        rest += chunk
        let i
        while ((i = rest.indexOf('\n\n')) >= 0) {
          const line = rest.slice(0, i); rest = rest.slice(i + 2)
          const m = /^data: (.*)$/s.exec(line)
          if (!m) continue
          const q = JSON.parse(m[1])
          if (q.link) { link = q.link; continue }
          const out = { link, id: q.id }
          Promise.resolve().then(() => handle(q.cmd, q.args || {}, { take: (token, name) => take(main, token, name, headers, fetchIt) }))
            .then(result => ({ ...out, ok: true, result }), e => ({ ...out, ok: false, error: String(e?.message || e), stop: !!e?.stop }))
            .then(async (a) => fetchIt(`${main}/api/pc-link/answer`, { method: 'POST', headers: await headers(), body: JSON.stringify(a), signal: AbortSignal.timeout(15_000) })).catch(() => {})
        }
      }
    } finally { clearInterval(look) }
    return true
  }
  const loop = async () => {
    while (!stop) {
      let had = false
      try { had = await once() } catch { fails++ }
      const wait = had ? 3000 : Math.min(every, 5000 * 2 ** Math.min(fails, 4))
      await new Promise(x => { const t = setTimeout(x, fails ? wait : had ? 3000 : every); t.unref?.() })
    }
  }
  loop()
  running = { stop() { stop = true; running = null; try { ac?.abort() } catch {} } }
  return running
}
async function take(main, token, name, headers, fetchIt) {
  const r = await fetchIt(`${main}/api/pc-link/file/${encodeURIComponent(token)}`, { headers: await headers(), signal: AbortSignal.timeout(120_000) })
  if (!r.ok) throw new Error('The CV did not arrive on this computer')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-wa-'))
  const file = path.join(dir, path.basename(String(name || 'CV.pdf')).replace(/[^\w.-]+/g, '_'))
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(file))
  return { path: file, done: () => { try { fs.unlinkSync(file); fs.rmdirSync(dir) } catch {} } }
}
export function _resetLink() { links.clear(); files.clear(); running?.stop() }
