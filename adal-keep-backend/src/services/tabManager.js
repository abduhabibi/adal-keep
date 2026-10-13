/**
 * tabManager.js — "peer" tab detection, reuse, and busy-locking for the
 * lane-based automation browser.
 *
 * PROBLEM it solves
 * -----------------
 * Every workflow used to blindly `page.goto(<its portal>)` on whatever tab
 * the lane happened to hold. When that tab was sitting on the OTHER portal
 * (e.g. a Musaned job grabbing a lane tab that was showing lmis.gov.et), the
 * job navigated it away and — worse — the next run had to log in again.
 *
 * WHAT THIS DOES
 * --------------
 * Before a workflow touches the tab it asks: "is this tab already on MY
 * peer host?"
 *
 *   - Musaned's peers  = tawtheeq.musaned.com.sa, accounts.wahid.sa
 *   - LMIS's peer      = lmis.gov.et
 *
 *   ensurePeerTab():
 *     1. current tab already on my peer host        → REUSE it, change nothing
 *        (session stays alive ⇒ no re-login)
 *     2. some other open tab is on my peer host and
 *        is NOT currently worked on by another lane  → ADOPT it
 *     3. otherwise                                    → CREATE a fresh tab
 *
 * A tab that is on the *other* system is never navigated ("won't change the
 * link") — we simply get our own tab instead.
 *
 * BUSY LOCK
 * ---------
 * While a lane works a tab it is marked "busy". If a second job (e.g. two
 * police clearances at once) needs the same peer host and the only peer tab
 * is busy, it correctly spawns its own tab.
 *
 * All tabs live in the browser's shared default context, so cookies /
 * localStorage sessions are shared anyway — reusing the tab is really about
 * not navigating away and not re-submitting the login form.
 *
 * Cross-platform: pure Puppeteer/CDP — Windows / macOS / Linux identical.
 */

import { randomUUID } from 'crypto'

export const PEERS = {
  musaned: { hosts: ['tawtheeq.musaned.com.sa', 'accounts.wahid.sa'], label: 'Musaned' },
  lmis:    { hosts: ['lmis.gov.et'],                                  label: 'LMIS' },
}

/** Which peer a workflow id belongs to. musaned* → musaned, everything else → lmis. */
export function peerForWorkflow(workflowId = '') {
  return String(workflowId).startsWith('musaned') ? 'musaned' : 'lmis'
}

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return '' }
}

export function isPeerUrl(url, peer) {
  const p = PEERS[peer]
  if (!p) return false
  const h = hostOf(url)
  if (!h) return false
  return p.hosts.some(x => h === x || h.endsWith('.' + x))
}

function urlOf(page) {
  try { return (page && page.url && page.url()) || '' } catch { return '' }
}

function isClosed(page) {
  try { return !page || (typeof page.isClosed === 'function' && page.isClosed()) } catch { return true }
}

// --------------------------------------------------------------------------
// Busy registry
// --------------------------------------------------------------------------
// pageKey -> laneId that is actively working the tab. A tab is "busy" only
// while a job runs on it; idle tabs are fair game for reuse.
const _busy = new Map()

function pageKey(page) {
  if (!page) return null
  if (!page.__adalKey) page.__adalKey = 'tab_' + randomUUID()
  return page.__adalKey
}

export function markBusy(page, laneId) {
  const k = pageKey(page)
  if (k) _busy.set(k, laneId)
}

export function releaseBusy(page) {
  const k = pageKey(page)
  if (k) _busy.delete(k)
}

export function isBusyByOther(page, laneId) {
  const k = pageKey(page)
  if (!k) return false
  const owner = _busy.get(k)
  return owner !== undefined && owner !== laneId
}

// --------------------------------------------------------------------------
// Tab setup (mute + focus emulation + dynamic image interception)
// --------------------------------------------------------------------------
/**
 * Bring a tab up to the standard automation hygiene: muted, focus-emulated
 * (so Chrome never throttles its timers/network when the user switches away),
 * and request-intercepted with the dynamic `page.__adalAllowImages` policy.
 * Idempotent — safe to call on tabs the lane already owns.
 */
export async function setupTab(page, { laneId, mute = true } = {}) {
  if (!page) return page
  if (page.__adalSetup) {
    if (laneId !== undefined) page.__adalLane = laneId
    return page
  }

  try {
    const cdp = await page.target().createCDPSession()
    page.__adalCdp = cdp
    try { await cdp.send('Page.setAudioMuted', { muted: mute }) } catch {}
    try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }) } catch {}
    page.__adalFocused = true
  } catch (e) {
    console.log('[tabManager] cdp setup failed:', e.message)
  }

  try {
    await page.setRequestInterception(true)
    page.on('request', req => {
      const allowImages = page.__adalAllowImages === true
      if (!allowImages && req.resourceType() === 'image') req.abort().catch(() => {})
      else req.continue().catch(() => {})
    })
  } catch (e) {
    console.log('[tabManager] request interception attach failed:', e.message)
  }

  if (laneId !== undefined) page.__adalLane = laneId
  page.__adalSetup = true
  return page
}

// --------------------------------------------------------------------------
// Peer tab selection
// --------------------------------------------------------------------------
/** Every real page target across every browser context. */
async function listPages(browser) {
  const out = []
  if (!browser) return out
  try {
    for (const target of browser.targets()) {
      if (target.type() !== 'page') continue
      try { const p = await target.page(); if (p) out.push(p) } catch {}
    }
  } catch {}
  if (!out.length) {
    try { out.push(...(await browser.pages())) } catch {}
  }
  return out
}

/**
 * Pick (or create) the tab this lane should use for `peer`.
 *
 * @returns {Promise<{peer:string, page:object, reused:'current'|'adopted'|'created'|'fallback-current'|'none'}>}
 */
export async function ensurePeerTab({ browser, page, laneId, peer, ctx } = {}) {
  // Idempotent within a single job — worker.js may have already selected.
  if (ctx && ctx.__peerTab && ctx.__peerTab.page && !isClosed(ctx.__peerTab.page)) {
    return ctx.__peerTab
  }

  const result = { peer, page, reused: 'none' }
  const finish = () => { if (ctx) ctx.__peerTab = result; return result }

  if (!PEERS[peer] || !page) { result.reused = 'fallback-current'; return finish() }

  browser = browser || (page && typeof page.browser === 'function' ? page.browser() : null)

  // 1. Current tab already on my peer host (and not being worked by someone else).
  if (isPeerUrl(urlOf(page), peer) && !isBusyByOther(page, laneId)) {
    await setupTab(page, { laneId })
    markBusy(page, laneId)
    result.reused = 'current'
    console.log(`[tabManager] lane ${laneId} peer=${peer} REUSE current tab (${hostOf(urlOf(page))})`)
    return finish()
  }

  // 2. Adopt an idle peer tab (prefer one this lane already owned).
  let best = null
  for (const p of await listPages(browser)) {
    if (p === page || isClosed(p)) continue
    if (!isPeerUrl(urlOf(p), peer)) continue
    if (isBusyByOther(p, laneId)) continue
    if (p.__adalLane === laneId) { best = p; break }
    if (!best) best = p
  }
  if (best) {
    await setupTab(best, { laneId })
    markBusy(best, laneId)
    result.page = best
    result.reused = 'adopted'
    console.log(`[tabManager] lane ${laneId} peer=${peer} ADOPT open tab (${hostOf(urlOf(best))})`)
    return finish()
  }

  // 3. Create a fresh tab.
  let np = null
  try { if (browser && typeof browser.newPage === 'function') np = await browser.newPage() } catch (e) {
    console.log(`[tabManager] lane ${laneId} could not open tab: ${e.message}`)
  }
  if (np) {
    await setupTab(np, { laneId })
    markBusy(np, laneId)
    result.page = np
    result.reused = 'created'
    console.log(`[tabManager] lane ${laneId} peer=${peer} CREATE new tab`)
  } else {
    // Could not create — fall back to using the current tab (best effort).
    markBusy(page, laneId)
    result.reused = 'fallback-current'
  }
  return finish()
}

/** Release the busy lock a job held on its tab (call in a finally block). */
export function endJobTab(page) {
  releaseBusy(page)
}

/**
 * Close a lane's previous home tab if it is now orphaned and was never used
 * for anything meaningful (about:blank). Keeps a lane from leaking a blank
 * tab every time it is re-homed to an adopted/created peer tab.
 */
export async function closeIfBlank(page) {
  if (!page || isClosed(page)) return false
  try {
    const u = urlOf(page)
    if (u === 'about:blank' || u === '') {
      await page.close()
      return true
    }
  } catch {}
  return false
}

