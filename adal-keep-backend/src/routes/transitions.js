/** Settings → Transitions: bring an agency's data over from the system it used before. */
import express from 'express'
import { transitionStates, startTransition, stopTransition, showTransition, checkLink, filesWaiting, prioritize } from '../services/transition.js'
import { needFeature } from '../services/plans.js'

const router = express.Router()

/** The browser and out-of-sight tab a move works in, on the best PC; shown in Browsers as "tr-<source>". */
export async function robotTabForMove(req, sourceId, link, deps = {}) {
  const { SOURCES } = await import('../services/transition.js')
  const source = SOURCES[sourceId]
  const url = link || source?.url
  if (!source || !url) return {}
  const rb = deps.rb || await import('../services/remoteBrowsers.js')
  const { ipOf } = await import('../services/networkGate.js')
  const from = req.pcAccess ? rb.deviceForRequest(req.pcAccess, ipOf(req)) : ''
  const { placeTransition } = await import('../services/sharePower.js')
  const c = await placeTransition(url, { from }).catch(() => ({ to: from }))
  const dev = c.to || ''
  const B = await import('../services/browser.js')
  const browser = dev ? await rb.browserForDevice(dev, { quiet: true }).catch(() => null) : null
  const b = browser || await B.getBrowser()
  const pcId = browser ? dev : ''
  const { isRunTab } = await import('../services/tabManager.js')
  const { registerLiveTab, updateLiveTab } = await import('../services/robotBrowsers.js')
  const key = `tr-${sourceId}`
  let host = ''
  try { host = new URL(url).hostname } catch {}
  const tab = async (reuse) => {
    let page = null
    if (reuse && host) for (const p of await b.pages().catch(() => [])) { try { if (new URL(p.url()).hostname === host && !isRunTab(p)) { page = p; break } } catch {} }
    page = page || await B.newRunTab(b, null, { quiet: true })
    registerLiveTab(key, page, { site: source.name, girl: 'Transition', pc_id: pcId, status: 'Sign in', needs_you: true, task: `Sign in to ${source.name}` })
    return page
  }
  const page = await tab(true)
  return { browser: b, personPage: page, openForPerson: () => tab(false), sendAway: async () => updateLiveTab(key, { status: 'Copying', needs_you: false, task: null }) }
}

// The Pextran address used last time, kept on this PC: the box shows it again (any device).
const LINK_KEY = 'transition_pextran_link'
router.get('/transitions', async (req, res) => {
  const st = transitionStates()
  try { const row = await req.app.locals.db('settings').where({ key: LINK_KEY }).first(); if (st.pextran && row?.value) st.pextran.link = row.value } catch {}
  res.json(st)
})

router.post('/transitions/:source/start', async (req, res) => {
  try {
    needFeature('moves')
    const link = req.params.source === 'pextran' ? checkLink(req.body?.link) : null
    if (link) {
      const db = req.app.locals.db, typed = String(req.body.link).trim()
      if (await db('settings').where({ key: LINK_KEY }).first()) await db('settings').where({ key: LINK_KEY }).update({ value: typed })
      else await db('settings').insert({ key: LINK_KEY, value: typed })
    }
    const accountId = Number(req.body?.account_id) || null
    const limit = Math.max(0, Math.min(1000, Number(req.body?.limit) || 0)) || undefined
    // The move works like the robots (2026-11-21): on the PC of the office that
    // finishes it first, in a tab out of sight there (a free tab already on the
    // site first), signed in through the live view in Browsers.
    const here = await robotTabForMove(req, req.params.source, link).catch(e => { console.warn('[transition] browser:', e.message); return {} })
    res.json(startTransition(req.app.locals.db, req.params.source, link, { ...(accountId ? { accountId } : {}), ...(limit ? { limit } : {}), ...here }))
  } catch (e) { res.status(e.status || 400).json({ error: e.message, ...(e.feature ? { feature: e.feature, plan: e.plan } : {}) }) }
})

router.post('/transitions/:source/stop', (req, res) => {
  stopTransition(req.params.source)
  res.json(transitionStates())
})

router.post('/transitions/:source/show', async (req, res) => {
  await showTransition(req.params.source).catch(() => {})
  res.json({ ok: true })
})

export default router

// Profiles a running move saved whose files have not come yet (their Prioritize button).
// Girls whose files have not come: in a running move, or accepted from another agency.
router.get('/transitions/waiting-files', async (req, res) => {
  res.json({ profileIds: [...new Set(filesWaiting())] })
})
// Her record and files next, before everyone else.
router.post('/transitions/prioritize/:profileId', async (req, res) => {
  if (!prioritize(req.params.profileId)) return res.status(404).json({ error: 'Her files are not waiting any more (they may have come already)' })
  res.json({ ok: true })
})
