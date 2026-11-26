/**
 * siteMap/engine.js — locate, then go (docs/robot-architecture.md).
 *
 * A map: { site, look(page) → facts, screens: [{ name, is(facts) → bool, gate? }], actions: [{ name, from: [screen…] | '*',
 * to: [screen…], cost, ms, safe, once, do(page, ctx) }] }. Screens are tried in order; the first sure one is the screen.
 * Off: ADAL_SITE_MAP=0 (callers take their old path). Errors are caught: a failed goTo says why, the caller goes on
 * its old way.
 */
import fs from 'fs'
import path from 'path'

export const siteMapOn = (env = process.env) => env.ADAL_SITE_MAP !== '0'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const within = (p, ms, v = null) => { let t; return Promise.race([Promise.resolve(p).catch(() => v), new Promise(r => { t = setTimeout(() => r(v), ms) })]).finally(() => clearTimeout(t)) }

/** The screen these facts show, or '' (not sure). */
export function recognise(map, facts) {
  if (!facts) return ''
  for (const s of map.screens) { try { if (s.is(facts)) return s.name } catch {} }
  return ''
}

const starts = (a, screen) => a.from === '*' ? !!screen && !(a.notFrom || []).includes(screen) : a.from.includes(screen)

/** The cheapest actions from `from` to `goal` (Dijkstra on costs), [] when there already, null when no way. */
export function plan(map, from, goal, { done = new Set(), skip = new Set() } = {}) {
  if (from === goal) return []
  const best = new Map([[from, { cost: 0, path: [] }]])
  const open = [from]
  while (open.length) {
    open.sort((a, b) => best.get(a).cost - best.get(b).cost)
    const at = open.shift(), here = best.get(at)
    if (at === goal) return here.path
    for (const a of map.actions) {
      if (!starts(a, at) || (a.once && done.has(a.name)) || skip.has(a.name) || a.unknownOnly) continue
      const to = a.to[0], cost = here.cost + (a.cost ?? 1)
      if (!best.has(to) || best.get(to).cost > cost) { best.set(to, { cost, path: [...here.path, a] }); if (!open.includes(to)) open.push(to) }
    }
  }
  return null
}

/** Reads the screen (a few tries over `ms` while the page is drawing). */
export async function screenNow(page, map, ms = 0, every = 200) {
  const t0 = Date.now()
  for (;;) {
    const facts = await within(map.look(page), 2500)
    const name = recognise(map, facts)
    if (name || Date.now() - t0 >= ms) return { name, facts }
    await sleep(every)
  }
}

/** Waits for one of `want` (the old sleep `ms` at most). */
async function waitFor(page, map, want, ms) {
  const t0 = Date.now()
  for (;;) {
    const s = await screenNow(page, map)
    if (want.includes(s.name)) return s
    if (Date.now() - t0 >= ms) return s
    await sleep(150)
  }
}

// Saved for later (a known screen next time): the page's HTML, every run of 4+ digits masked, and its picture.
async function keepUnknown(page, map, dir) {
  try {
    if (!dir) return ''
    const d = path.join(dir, map.site); fs.mkdirSync(d, { recursive: true })
    const at = new Date().toISOString().replace(/[:.]/g, '-')
    const html = await within(page.content(), 4000, '')
    fs.writeFileSync(path.join(d, `${at}.html`), String(html).replace(/\d{4,}/g, (m) => '0'.repeat(m.length)))
    const png = await within(page.screenshot({ type: 'png' }), 6000, null)
    if (png) fs.writeFileSync(path.join(d, `${at}.png`), png)
    return path.join(d, at)
  } catch { return '' }
}

// Per-step time totals across runs (data/step-times.json): which step is slow.
export function noteTimes(file, site, trace) {
  try {
    if (!file || !trace.length) return
    let all = {}
    try { all = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    for (const t of trace) {
      if (!t.action) continue
      const k = `${site}:${t.action}`, v = all[k] || { n: 0, ms: 0, failed: 0 }
      v.n++; v.ms += t.ms; if (!t.ok) v.failed++
      all[k] = v
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.new', JSON.stringify(all, null, 1)); fs.renameSync(file + '.new', file)
  } catch {}
}

/**
 * From wherever the tab is to `goal`. opts: { ctx, log, jev(png, text, goal, allowed) → action name | null,
 * maxSteps = 8, maxUnknown = 3, unknownDir, timesFile, readMs = 4000 }.
 * → { ok, screen, steps, trace, gate?, why? }
 */
export async function goTo(page, map, goal, { ctx = {}, log = () => {}, jev = null, maxSteps = 8, maxUnknown = 3, unknownDir = null, timesFile = null, readMs = 4000 } = {}) {
  const trace = [], done = new Set(ctx.mapDone || []), failed = new Set()
  let unknown = 0
  const end = (r) => { noteTimes(timesFile, map.site, trace); return { ...r, trace, steps: trace.length } }
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (ctx.isCancelled?.()) return end({ ok: false, why: 'cancelled' })
      const { name } = await screenNow(page, map, readMs)
      if (name === goal) { log(`📍 ${map.site}: at ${goal}`); return end({ ok: true, screen: name }) }
      const gate = name && map.screens.find(s => s.name === name)?.gate
      if (gate) { log(`📍 ${map.site}: ${name} — a person's step (${gate})`); return end({ ok: false, screen: name, gate }) }
      let action = null
      if (name) {
        // (An action that failed this run is not tried again while there is another way.)
        const way = plan(map, name, goal, { done, skip: failed }) || plan(map, name, goal, { done })
        if (!way) return end({ ok: false, screen: name, why: `no way from ${name} to ${goal}` })
        action = way[0]
      } else {
        // Unknown: JEV picks one of the safe actions, never more than maxUnknown times a run.
        if (++unknown > maxUnknown) return end({ ok: false, screen: '', why: 'an unknown screen, JEV asked enough' })
        const kept = await keepUnknown(page, map, unknownDir)
        const allowed = map.actions.filter(a => a.safe && (a.from === '*' || a.unknownOnly) && !(a.once && done.has(a.name)))
        let pick = null
        if (jev && allowed.length) {
          const png = await within(page.screenshot({ type: 'png' }), 6000, null)
          const text = await within(page.evaluate(() => (document.body?.innerText || '').slice(0, 2000)), 2500, '')
          pick = await within(jev(png, text, goal, allowed.map(a => ({ name: a.name, says: a.says || a.name }))), 8000, null)
        }
        action = allowed.find(a => a.name === pick) || null
        log(`📍 ${map.site}: a screen not on the map${kept ? ` (kept: ${path.basename(kept)})` : ''} — ${action ? `JEV: ${action.name}` : 'JEV gave no safe step'}`)
        if (!action) return end({ ok: false, screen: '', why: 'an unknown screen' })
      }
      const t0 = Date.now()
      let threw = ''
      try { await action.do(page, ctx) } catch (e) { threw = e.message }
      const after = await waitFor(page, map, action.to, action.ms ?? 10000)
      const ok = !threw && action.to.includes(after.name)
      trace.push({ screen: name || '?', action: action.name, to: after.name || '?', ms: Date.now() - t0, ok })
      log(`📍 ${map.site}: ${name || '?'} → ${action.name} → ${after.name || '?'} (${((Date.now() - t0) / 1000).toFixed(1)} s)${ok ? '' : threw ? ` — ${threw}` : ' — not what was expected; reading the screen again'}`)
      if (!ok) failed.add(action.name)
      if (ok && action.once) { done.add(action.name); ctx.mapDone = [...done] }
    }
    return end({ ok: false, why: `not at ${goal} after ${maxSteps} steps` })
  } catch (e) {
    return end({ ok: false, why: e.message })
  }
}

/** The real JEV's pick among the allowed actions (jevClassifier.chooseOnPage), or null. */
export async function jevPick(png, text, goal, allowed) {
  if (!png || !allowed.length) return null
  const { chooseOnPage } = await import('../jevClassifier.js')
  const a = await chooseOnPage(png, { next: [`A robot on this web page wants to reach: ${goal}. Which one of these steps brings it closer?`, Object.fromEntries(allowed.map(x => [x.name, x.says]))] })
  return a?.next && a.next.confidence >= 0.5 ? a.next.choice : null
}
