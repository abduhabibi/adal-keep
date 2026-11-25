/**
 * The double "C" crop on a Companion whose window shows the main PC's pages.
 *
 * The crop starts on the PC where C is pressed: the Companion's own server
 * (its full copy) runs that PC's own adal-clip already (screenClip.js). Its
 * picture went to that server only, where no page was open. Here it goes on to
 * the main PC, which gives it to the pages of that same PC and no other.
 *
 * - On the Companion: told every 45 s that its watcher runs; the crop's state
 *   and the picture as they come — the picture only while a page of this PC is open there.
 * - On the main PC: only an approved PC's; its pages hear of it on the stream
 *   they have already (/api/changes), so no line more per window.
 * Off on either PC: ADAL_CLIP_RELAY=0. Any error: the crop stays as before.
 */
import { mainURL, mainKey } from './mainPC.js'
import { approvedPC, ipOf } from './networkGate.js'
import { clipState, setClipRelay } from './screenClip.js'

export const relayOn = () => process.env.ADAL_CLIP_RELAY !== '0'
const BEAT_MS = 45_000, HOOK_MS = 100_000, KEEP_MS = 10 * 60_000, KEEP = 10

// ── On the main PC ──────────────────────────────────────────────────────────

const pages = new Set()      // { res, who }
const hooks = new Map()      // who key → timer (that PC's watcher runs)
const clips = []             // { id, at, png, who }
let nextId = 1

/** Who is asking: the PC's own entry and its address (its window and its server may hold different keys). */
const whoIs = (req) => { const pc = req.pcAccess || approvedPC(req); return pc ? [`pc:${pc.id}`, `ip:${ipOf(req)}`] : null }
const same = (a, b) => a.some(k => b.includes(k))
const say = (page, m) => { try { page.res.write(`event: clips\ndata: ${JSON.stringify(m)}\n\n`) } catch {} }
const of = (who) => [...pages].filter(p => same(p.who, who))
const hookOf = (who) => who.some(k => hooks.has(k))

/** A page of another PC listens on its /api/changes stream. Returns how to stop. */
export function listenPC(req, res) {
  const who = relayOn() ? whoIs(req) : null
  if (!who) return () => {}
  const page = { res, who }
  pages.add(page)
  if (hookOf(who)) say(page, { hook: true })
  return () => pages.delete(page)
}

function hookOn(who) {
  const was = hookOf(who)
  for (const k of who) {
    clearTimeout(hooks.get(k))
    const t = setTimeout(() => { hooks.delete(k); if (!hookOf(who)) for (const p of of(who)) say(p, { hook: false }) }, HOOK_MS)
    t.unref?.()
    hooks.set(k, t)
  }
  if (!was) for (const p of of(who)) say(p, { hook: true })
}
function hookOff(who) {
  for (const k of who) { clearTimeout(hooks.get(k)); hooks.delete(k) }
  for (const p of of(who)) say(p, { hook: false })
}

/** POST /app/clip from another PC: its watcher runs (hook / nohook), how the crop stands, or the picture. */
export function fromPC(req, res) {
  const who = relayOn() ? whoIs(req) : null
  if (!who) return res.status(403).end()
  const state = String(req.query.state || '')
  const mine = of(who)
  if (state === 'nohook') hookOff(who)
  else hookOn(who)
  if (['cropping', 'none'].includes(state)) for (const p of mine) say(p, { state })
  const png = !state && Buffer.isBuffer(req.body) && req.body.length ? req.body : null
  if (png && mine.length) {
    const now = Date.now()
    while (clips.length && (now - clips[0].at > KEEP_MS || clips.length >= KEEP)) clips.shift()
    const c = { id: `pc${nextId++}`, at: now, png, who }
    clips.push(c)
    console.log(`[clip] a cropped picture from another PC (${Math.round(png.length / 1024)} KB) → its own pages' tray`)
    for (const p of mine) say(p, { clip: c.id, at: now })
  }
  res.json({ ok: true, pages: mine.length })
}

/** Its picture, for the PC it came from only. */
export function clipFor(req, id) {
  const who = relayOn() ? whoIs(req) : null
  const c = who && clips.find(x => x.id === String(id))
  return c && same(c.who, who) && Date.now() - c.at < KEEP_MS ? c : null
}

// ── On the Companion ────────────────────────────────────────────────────────

let open = 0, timer = null, line = Promise.resolve()   // in order: "cropping" before its picture
async function tell(state, png) {
  const main = mainURL()
  if (!relayOn() || !main) return
  const r = await fetch(`${main}/api/app/clip${state ? `?state=${state}` : ''}`, {
    method: 'POST', headers: { 'x-adal-pc': await mainKey(), ...(png ? { 'content-type': 'image/png' } : {}) },
    body: png || undefined, signal: AbortSignal.timeout(png ? 20_000 : 4000),
  })
  open = r.ok ? Number((await r.json().catch(() => ({}))).pages) || 0 : 0   // (an older main PC answers 403: nothing is sent)
}
export function relayClip({ png, state }) {
  line = line.then(async () => { if (state || open > 0) await tell(state, png) }).catch(() => { open = 0 })
  return line
}

/** A PC whose window shows the main PC's pages tells it that its watcher runs. Nothing is sent by the main PC itself. */
export function startClipRelay({ every = BEAT_MS } = {}) {
  if (timer) return
  setClipRelay(relayClip)
  let told = false
  const beat = () => {
    if (clipState.running) { told = true; relayClip({ state: 'hook' }) }
    else if (told) { told = false; relayClip({ state: 'nohook' }) }
  }
  const first = setTimeout(beat, Math.min(4000, every)); first.unref?.()
  timer = setInterval(beat, every)
  timer.unref?.()
}
export function _resetRelay() {
  clearInterval(timer); timer = null; open = 0; setClipRelay(null); pages.clear(); clips.length = 0
  for (const t of hooks.values()) clearTimeout(t)
  hooks.clear()
}
