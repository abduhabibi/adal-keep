/**
 * portalHealth.js — is each government portal answering? Checked shortly
 * after start and every 3 hours: one plain request per portal (no sign-in,
 * nothing sent). A portal that does not answer, or answers with a server
 * error, is asked again a minute later before it counts as down. When none
 * answers, it is this PC's internet, not the portals.
 *
 * The result goes to Adal Keep Admin with the PC's health (diag.js), so a
 * portal that is down is known before an agency's robot fails on it.
 */
export const PORTALS = [
  { key: 'musaned', name: 'Musaned', url: 'https://tawtheeq.musaned.com.sa/' },
  { key: 'mofa', name: 'Visa platform', url: 'https://visa.mofa.gov.sa/' },
  { key: 'tasheer', name: 'Tasheer', url: 'https://agents.tasheer.com/' },
  { key: 'wafid', name: 'Wafid', url: 'https://wafid.com/' },
  { key: 'lmis', name: 'LMIS', url: 'https://lmis.gov.et/' },
  { key: 'enjaz', name: 'Enjaz Plus', url: 'https://v2.enjazplus.com/' },
]

const EVERY = 3 * 3600 * 1000
let last = { at: null, portals: [] }
let timer = null

async function ask(url, { fetchFn = fetch, timeoutMs = 20_000 } = {}) {
  const t0 = Date.now()
  try {
    const r = await fetchFn(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AdalKeep-health' } })
    try { await r.body?.cancel?.() } catch {}
    // Any answer below 500 means the portal is up (a firewall's 403 to a plain request included).
    if (r.status >= 500) return { ok: false, why: `server error ${r.status}`, ms: Date.now() - t0 }
    return { ok: true, status: r.status, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, why: /timeout|abort/i.test(`${e.name} ${e.message}`) ? 'no answer in 20 s' : (e.cause?.code || e.message || 'unreachable'), ms: Date.now() - t0 }
  }
}

/** Checks every portal once (a failed one twice). */
export async function checkPortals({ fetchFn = fetch, retryMs = 60_000, portals = PORTALS } = {}) {
  let out = await Promise.all(portals.map(async p => ({ key: p.key, name: p.name, ...(await ask(p.url, { fetchFn })) })))
  const failed = out.filter(p => !p.ok)
  if (failed.length) {
    await new Promise(r => setTimeout(r, retryMs))
    const again = await Promise.all(failed.map(async p => ({ ...p, ...(await ask(portals.find(x => x.key === p.key).url, { fetchFn })) })))
    out = out.map(p => again.find(a => a.key === p.key) || p)
  }
  // Nothing answered: the PC is offline — one line, not six.
  if (out.length > 1 && out.every(p => !p.ok)) out = [{ key: 'internet', name: 'Internet', ok: false, why: 'no portal answered: this PC is offline' }]
  last = { at: new Date().toISOString(), portals: out }
  const down = out.filter(p => !p.ok)
  if (down.length) console.warn(`[portals] not answering: ${down.map(p => `${p.name} (${p.why})`).join(', ')}`)
  return last
}

export const portalStatus = () => last

export function startPortalHealth() {
  if (timer || process.env.NODE_ENV === 'test') return
  setTimeout(() => checkPortals().catch(() => {}), 2 * 60 * 1000).unref?.()
  timer = setInterval(async () => { if ((await import('./runFocus.js')).held('the portal check')) return; checkPortals().catch(() => {}) }, EVERY)
  timer.unref?.()
}
