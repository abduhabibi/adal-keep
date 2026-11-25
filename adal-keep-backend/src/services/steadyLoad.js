/**
 * steadyLoad.js — a site's page on a line that loses connections in bursts (2026-11-25, two PCs of one office: 2 of 12
 * new connections never answered, the next ones in 165 ms; one 60 s wait on a lost one was a failed run).
 *
 *   steadyGoto(page, url)  opens a page: no answer in 7 s, or the connection refused / lost / its name not found →
 *                          stopped and asked again at once, up to 60 s in all; one whose answer has begun gets the
 *                          rest of the time. Only for opening a page (a reading): nothing that was pressed or sent is
 *                          ever done again.
 *   inCallback(url)        the sign-in is just coming back to the site ("…/#state=…&code=…"): its app is at work,
 *                          never navigated away from.
 * ADAL_STEADY=0: one try of 60 s, as before.
 */
const LOST = /ERR_(CONNECTION_(TIMED_OUT|RESET|CLOSED|REFUSED|ABORTED|FAILED)|TIMED_OUT|NAME_NOT_RESOLVED|NETWORK_CHANGED|EMPTY_RESPONSE|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|SSL_PROTOCOL_ERROR|HTTP2_PING_FAILED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|SOCKET_NOT_CONNECTED|DNS_TIMED_OUT)/
export const lostConnection = (m) => LOST.test(String(m || ''))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function inCallback(url) {
  try {
    const u = new URL(url)
    if (!/(^|\.)musaned\.com\.sa$/.test(u.hostname)) return false
    const q = new URLSearchParams(`${u.hash.replace(/^#\/?\??/, '')}&${u.search.slice(1)}`)
    return q.has('state') && (q.has('code') || q.has('session_state') || q.has('iss'))
  } catch { return false }
}

export async function steadyGoto(page, url, { answerMs = 7000, totalMs = 60000, waitUntil = 'domcontentloaded', log = () => {}, isCancelled = null } = {}) {
  if (process.env.ADAL_STEADY === '0') return page.goto(url, { waitUntil, timeout: totalMs })
  const end = Date.now() + totalMs
  let n = 0, last = null
  for (;;) {
    if (isCancelled?.()) { const e = new Error('Cancelled by user'); e.cancelled = true; throw e }
    n++
    const left = end - Date.now()
    let answered = false
    const seen = (res) => { try { if (res.request().isNavigationRequest() && res.frame() === page.mainFrame()) answered = true } catch {} }
    page.on?.('response', seen)
    let timer = null, gaveUp = false
    const t0 = Date.now()
    try {
      const go = page.goto(url, { waitUntil, timeout: Math.max(1000, left) })
      go.catch(() => {})
      const quiet = new Promise((_, no) => { timer = setTimeout(() => { if (!answered) { gaveUp = true; no(new Error('no answer')) } }, Math.min(answerMs, left)) })
      const r = await Promise.race([go, quiet])
      if (n > 1) log(`the site answered on try ${n}`)
      return r
    } catch (e) {
      last = e
      const took = Date.now() - t0
      const again = (gaveUp || lostConnection(e.message)) && end - Date.now() > 3000
      if (!again) throw gaveUp ? new Error(`Navigation timeout of ${totalMs} ms exceeded (no answer in ${n} tries)`) : e
      // The lost one is dropped: what comes of it later does not disturb the next.
      await Promise.race([stop(page), sleep(1500)])
      log(`no answer from ${hostOf(url)} (${gaveUp ? `${Math.round(took / 1000)} s` : String(e.message).match(/ERR_\w+/)?.[0] || 'lost'}) — asking again (try ${n + 1})`)
      if (!gaveUp && took < 1000) await sleep(Math.min(700, 150 * n))
    } finally { clearTimeout(timer); page.off?.('response', seen) }
    void last
  }
}
async function stop(page) {
  try {
    const s = page.__adalCdp || (page.__adalStopCdp ||= await page.createCDPSession())
    await s.send('Page.stopLoading')
  } catch {}
}
const hostOf = (u) => { try { return new URL(u).hostname } catch { return 'the site' } }
