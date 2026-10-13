/**
 * bandwidth.js — fair-share bandwidth governor across automation lane tabs.
 *
 * PROBLEM it solves
 * -----------------
 * When a human switches to another tab, Chrome starves the background tab's
 * network and one tab ends up consuming the whole link. This module SHARES
 * the link equally between every tab that currently has a running job, using
 * Chrome DevTools Protocol per-tab throughput caps
 * (`Network.emulateNetworkConditions`).
 *
 * HOW IT CLASSIFIES THE LINK
 * --------------------------
 *   1. explicit env:  ADAL_TOTAL_DOWNLOAD_KBPS / ADAL_TOTAL_UPLOAD_KBPS
 *   2. else `navigator.connection.downlink` (Mbps) — but ONLY trusted when it
 *      reads < 10 Mbps. Chrome caps the reported value at 10, so `>= 10`
 *      means "unknown / fast link" and we deliberately DO NOT throttle
 *      (avoids slowing a fast installation).
 *
 * SAFETY
 *   - 0 or 1 active tab  → throughput set to unlimited (-1). No behaviour
 *     change from today for the common single-job case.
 *   - ≥ 2 active tabs    → each tab gets `total / active`, with a floor so
 *     uploads/pages never crawl.
 *   - Best-effort: every CDP call is wrapped; failures never throw.
 *   - Disable entirely with ADAL_FAIR_BANDWIDTH=0.
 *
 * Cross-platform: pure CDP — Windows / macOS / Linux identical.
 */

const ENV = process.env

// Off by default: splitting the link between running agents is what starved
// each job. Set ADAL_FAIR_BANDWIDTH=1 to turn the fair-share cap back on.
const DISABLED = String(ENV.ADAL_FAIR_BANDWIDTH || '0') !== '1'

// Explicit totals (KB/s). 0 => auto-classify.
let _totalDownKbps = Number(ENV.ADAL_TOTAL_DOWNLOAD_KBPS || 0) || 0
let _totalUpKbps   = Number(ENV.ADAL_TOTAL_UPLOAD_KBPS   || 0) || 0
const FACTOR       = Number(ENV.ADAL_BW_FACTOR || 1) || 1
const MIN_DOWN_KBPS = Number(ENV.ADAL_BW_MIN_DOWN_KBPS || 3000)   // per-tab floor
const MIN_UP_KBPS   = Number(ENV.ADAL_BW_MIN_UP_KBPS   || 1000)   // per-tab floor

// laneId -> { page, cdp }
const _tabs = new Map()

// One-time link classification (shared across lanes).
let _link = null

function kbpsFromMbps(mbps) { return Math.round(mbps * 1024) }

async function classifyOn(page) {
  try {
    return await page.evaluate(() => {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {}
      return {
        downlink: Number(c.downlink) || 0,
        rtt: Number(c.rtt) || 0,
        effectiveType: c.effectiveType || '',
        saveData: !!c.saveData,
      }
    })
  } catch { return null }
}

/** Classify the connection once, from any page. Safe to call every job. */
export async function noteLink(page) {
  if (_link || DISABLED) return _link
  _link = await classifyOn(page)
  if (_link) {
    console.log(
      `[bandwidth] link classified: downlink=${_link.downlink}Mbps ` +
      `rtt=${_link.rtt}ms type=${_link.effectiveType || 'n/a'}`
    )
  }
  return _link
}

/** Resolve the total throughput budget (KB/s). 0 => do not throttle. */
function resolveTotals() {
  let down = _totalDownKbps
  let up = _totalUpKbps

  if (!down) {
    const dl = _link && _link.downlink ? _link.downlink : 0
    // Only trust a sub-10 Mbps reading; >= 10 is Chrome's cap ("fast/unknown").
    if (dl > 0 && dl < 10) down = kbpsFromMbps(dl) * FACTOR
  }
  if (!up) {
    const dl = _link && _link.downlink ? _link.downlink : 0
    if (dl > 0 && dl < 10) up = kbpsFromMbps(dl) * 0.5 * FACTOR
  }
  return { down, up }
}

async function apply(entry, downBytes, upBytes) {
  try {
    if (!entry.cdp) entry.cdp = await entry.page.target().createCDPSession()
    await entry.cdp.send('Network.enable')
    await entry.cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: downBytes,
      uploadThroughput: upBytes,
    })
  } catch (e) {
    console.log('[bandwidth] apply failed:', e.message)
  }
}

/**
 * Register a tab as "active" (a job is running on it) and rebalance the link.
 */
export async function registerTab(laneId, page) {
  if (DISABLED || !page) return
  _tabs.set(laneId, { page, cdp: page.__adalCdp || null })
  await rebalance()
}

/** Remove a tab from the active set and rebalance the remaining tabs. */
export async function unregisterTab(laneId) {
  if (DISABLED) return
  _tabs.delete(laneId)
  await rebalance()
}

/**
 * Split the classified link equally between all active tabs.
 *  - ≤ 1 tab → unlimited (no-op).
 *  - ≥ 2 tabs → each gets total/active with floors.
 */
export async function rebalance() {
  if (DISABLED) return
  const entries = [..._tabs.values()].filter(e => e.page)
  const active = entries.length

  if (active <= 1) {
    for (const e of entries) await apply(e, -1, -1)
    return
  }

  const { down, up } = resolveTotals()

  const perDownKbps = down > 0 ? Math.max(Math.floor(down / active), MIN_DOWN_KBPS) : 0
  const perUpKbps   = up   > 0 ? Math.max(Math.floor(up   / active), MIN_UP_KBPS)   : 0

  const downBytes = perDownKbps > 0 ? perDownKbps * 1024 : -1
  const upBytes   = perUpKbps   > 0 ? perUpKbps   * 1024 : -1

  for (const e of entries) await apply(e, downBytes, upBytes)

  if (downBytes > 0 || upBytes > 0) {
    console.log(
      `[bandwidth] fair-share across ${active} tabs → ` +
      `down=${perDownKbps || '∞'}KB/s up=${perUpKbps || '∞'}KB/s each`
    )
  }
}
