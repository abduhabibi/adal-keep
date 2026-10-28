/**
 * liveChannel.js — the instant link between this PC and the agency's phones,
 * through Supabase Realtime (a websocket; no polling, no shared Wi-Fi).
 *
 * Channel "keep-<live>" (keep_secrets.live: random, readable only by the
 * agency's PC and phones). Every message a phone sends carries its own
 * sign-in (jwt): this PC checks it is one of the agency's phones, not
 * removed, before doing anything.
 *
 *   PC → all     { t: 'pc' }                                  "I am on" (every 10 s)
 *   phone → PC   { t: 'call', id, method, path, body }       an API call
 *   PC → phone   { t: 'answer', id, code, type, head, data | bin | row }
 *   phone → PC   { t: 'watch', run }                         stream that run's tab (10 s, renewed)
 *   PC → phones  { t: 'frame', run, img, w, h, url, title }  the tab, when it changed
 *   phone → PC   { t: 'watch', run, view: 'mirror' }          …or as a light page (pageMirror.js)
 *   PC → phones  { t: 'mirror', run, gz }                    that page, gzipped JSON, when it changed
 *   phone → PC   { t: 'input', run, kind, … }                tap / type / key / scroll / nav / back …
 *                                                            and on the light page: tap / tapAt / set / pick / reveal (id)
 * Big answers (over ~180 KB) go in a keep_calls row instead; the message names it.
 */
import crypto from 'crypto'
import zlib from 'zlib'
import { cloudCall, cloudAgencyId, cloudConfig } from './chatCloud.js'
import { cloudOn, agencySecrets, runCall, relayStatus } from './cloudSync.js'

export const liveStatus = { connected: false, channel: null, calls: 0, frames: 0, error: null }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// Node 22+ has WebSocket built in; older Node uses the ws package (puppeteer's).
const WS = globalThis.WebSocket || (await import('ws')).default
const MAX_MSG = 180 * 1024

// ------------------------------------------------------------ the socket
class Channel {
  constructor({ url, anon, topic, onMessage }) {
    Object.assign(this, { url, anon, topic: `realtime:${topic}`, onMessage, ref: 0, ws: null, joined: false, closed: false })
  }
  open() {
    const ws = new WS(`${this.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${this.anon}&vsn=1.0.0`)
    this.ws = ws
    ws.onopen = () => {
      this.push(this.topic, 'phx_join', { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false }, access_token: this.anon })
      this.beat = setInterval(() => this.push('phoenix', 'heartbeat', {}), 25000)
    }
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data) } catch { return }
      if (m.event === 'phx_reply' && m.topic === this.topic && m.payload?.status === 'ok') { this.joined = true; liveStatus.connected = true; liveStatus.error = null }
      else if (m.event === 'phx_reply' && m.payload?.status === 'error') liveStatus.error = JSON.stringify(m.payload.response || {}).slice(0, 200)
      else if (m.event === 'broadcast' && m.payload?.event === 'm') this.onMessage(m.payload.payload || {})
    }
    ws.onclose = () => {
      clearInterval(this.beat)
      this.joined = false; liveStatus.connected = false
      if (!this.closed) setTimeout(() => this.open(), 3000)
    }
    ws.onerror = () => {}
  }
  push(topic, event, payload) {
    if (this.ws?.readyState !== 1) return false
    this.ws.send(JSON.stringify({ topic, event, payload, ref: String(++this.ref), join_ref: topic === this.topic ? '1' : undefined }))
    return true
  }
  send(msg) { return this.joined && this.push(this.topic, 'broadcast', { type: 'broadcast', event: 'm', payload: msg }) }
  close() { this.closed = true; try { this.ws?.close() } catch {} }
}

// ------------------------------------------------------------ who is asking
const seen = new Map()   // jwt → { device, until }
async function phoneOf(db, agency, jwt) {
  if (!jwt) return null
  const hit = seen.get(jwt)
  if (hit && hit.until > Date.now()) return hit.device
  const { url, anon } = cloudConfig()
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${jwt}` } }).catch(() => null)
  const user = r?.ok ? await r.json() : null
  let device = null
  if (user?.id) {
    const [d] = await cloudCall(db, 'GET', `/rest/v1/keep_devices?agency_id=eq.${agency}&user_id=eq.${user.id}&revoked=eq.false&select=user_id,name`).catch(() => [])
    device = d || null
  }
  seen.set(jwt, { device, until: Date.now() + 5 * 60000 })
  if (seen.size > 500) seen.clear()
  return device
}

// ------------------------------------------------------------ live tabs
const watching = new Map()   // run → { until, last, busy }
async function frameOf(db, run) {
  const { runTab } = await import('../routes/automations.js')
  const page = await runTab(db, run)
  if (!page) return { gone: true }
  const cdp = page.__adalCdp ||= await page.target().createCDPSession()
  const m = await cdp.send('Page.getLayoutMetrics')
  const vw = m.cssLayoutViewport?.clientWidth || m.layoutViewport.clientWidth
  const vh = m.cssLayoutViewport?.clientHeight || m.layoutViewport.clientHeight
  const sx = m.cssVisualViewport?.pageX ?? m.visualViewport?.pageX ?? 0
  const sy = m.cssVisualViewport?.pageY ?? m.visualViewport?.pageY ?? 0
  const scale = Math.min(1, 1000 / vw)
  const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55, clip: { x: sx, y: sy, width: vw, height: vh, scale }, captureBeyondViewport: false })
  return { img: shot.data, w: vw, h: vh, url: page.url(), title: await page.title().catch(() => '') }
}

// The tab as a light page (services/pageMirror.js), sent when it changed.
async function mirrorStep(db, ch, run, w) {
  const { runTab } = await import('../routes/automations.js')
  const page = await runTab(db, run)
  if (!page) { ch.send({ t: 'mirror', run, gone: true }); return 2000 }
  const { mirrorOf } = await import('./pageMirror.js')
  const m = await mirrorOf(page, w.shots ||= new Map(), w.force)
  const json = JSON.stringify(m)
  const hash = crypto.createHash('sha1').update(json).digest('hex')
  if (hash !== w.lastMirror || w.force || Date.now() - (w.mirrorAt || 0) > 5000) {
    w.lastMirror = hash; w.mirrorAt = Date.now()
    const gz = zlib.gzipSync(json, { level: 6 }).toString('base64')
    if (gz.length < MAX_MSG) { ch.send({ t: 'mirror', run, gz }); liveStatus.frames++ }
  }
  w.force = false
  return 350
}

function startStream(db, ch, run, view) {
  const w = watching.get(run) || {}
  w.until = Date.now() + 12000
  if (view) w.view = view
  watching.set(run, w)
  if (w.loop) return
  w.loop = (async () => {
    let lastSent = 0
    while (Date.now() < w.until) {
      if (w.view === 'mirror') {
        let wait = 1000
        try { wait = await mirrorStep(db, ch, run, w) } catch {}
        for (let i = 0; i < wait / 50 && !w.force; i++) await sleep(50)
        continue
      }
      try {
        const f = await frameOf(db, run)
        if (f.gone) { ch.send({ t: 'frame', run, gone: true }); await sleep(2000); continue }
        const hash = crypto.createHash('sha1').update(f.img).digest('hex')
        if (hash !== w.last || Date.now() - lastSent > 4000 || w.force) {
          w.last = hash; w.force = false; lastSent = Date.now()
          if (f.img.length < MAX_MSG) { ch.send({ t: 'frame', run, ...f }); liveStatus.frames++ }
        }
      } catch {}
      await sleep(w.force ? 50 : 200)
    }
    watching.delete(run)
  })()
}

// ------------------------------------------------------------ messages
async function onMessage(db, agency, ch, m) {
  if (m.t === 'pc' || m.t === 'answer' || m.t === 'frame' || m.t === 'mirror' || m.t === 'inputError') return
  const phone = await phoneOf(db, agency, m.jwt)
  if (!phone) return
  relayStatus.lastCall = Date.now()   // a phone is busy: its uploads are filed at once
  if (m.t === 'call') {
    liveStatus.calls++
    const c = { id: m.id, device_id: phone.user_id, method: m.method, path: m.path, body: m.body ?? null }
    const a = await runCall(db, agency, c)
    const msg = { t: 'answer', id: m.id, to: phone.user_id, code: a.answer_code, type: a.answer_type, head: a.answer_head, data: a.answer ?? null, bin: a.answer_bin ?? null }
    if (JSON.stringify(msg).length < MAX_MSG) return ch.send(msg)
    // Big JSON (the profile list …) usually fits gzipped: ~10× smaller.
    if (a.answer != null && a.answer_bin == null) {
      const gz = zlib.gzipSync(JSON.stringify(a.answer), { level: 6 }).toString('base64')
      if (gz.length < MAX_MSG) return ch.send({ ...msg, data: null, gz })
    }
    // Too big for one message: the answer waits in a keep_calls row.
    const [row] = await cloudCall(db, 'POST', '/rest/v1/keep_calls?select=id', {
      agency_id: agency, device_id: phone.user_id, method: String(m.method || 'GET').toUpperCase(), path: String(m.path || ''), status: 'done',
      answer: a.answer ?? null, answer_bin: a.answer_bin ?? null, answer_type: a.answer_type, answer_head: a.answer_head, answer_code: a.answer_code, answered_at: new Date().toISOString(),
    }, { headers: { Prefer: 'return=representation' } })
    ch.send({ t: 'answer', id: m.id, to: phone.user_id, row: row.id })
  } else if (m.t === 'watch') {
    startStream(db, ch, Number(m.run), m.view === 'mirror' ? 'mirror' : 'picture')
  } else if (m.t === 'input') {
    const { runTab, liveInput } = await import('../routes/automations.js')
    const page = await runTab(db, Number(m.run))
    let error = null
    if (page) await liveInput(page, m).catch((e) => { error = e.message })
    if (error && m.ack) ch.send({ t: 'inputError', run: Number(m.run), to: phone.user_id, error })
    const w = watching.get(Number(m.run)); if (w) w.force = true
    startStream(db, ch, Number(m.run))
  }
}

// ------------------------------------------------------------ start
let ch = null
export function startLiveChannel(db) {
  const tick = async () => {
    try {
      if (!(await cloudOn(db))) { ch?.close(); ch = null; return }
      const agency = await cloudAgencyId(db)
      const s = await agencySecrets(db, agency)
      const topic = `keep-${s.live}`
      if (ch?.topicName !== topic) {
        ch?.close()
        const { url, anon } = cloudConfig()
        ch = new Channel({ url, anon, topic, onMessage: (m) => onMessage(db, agency, ch, m).catch(e => console.warn('[live]', e.message)) })
        ch.topicName = topic
        liveStatus.channel = topic.slice(0, 12) + '…'
        ch.open()
      }
      ch.send({ t: 'pc', at: Date.now() })
    } catch (e) { liveStatus.error = e.message }
  }
  setTimeout(tick, 20000)
  setInterval(tick, 10000)
}
