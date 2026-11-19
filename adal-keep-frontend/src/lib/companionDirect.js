/**
 * On an Adal Companion PC, in the online pages (127.0.0.1:47801): the main PC
 * is asked directly whenever it can be reached — on the office network or
 * through Tailscale — instead of every click and every change going through
 * the cloud (that was slow: asked on 2026-11-17, "the update gets really
 * sluggish"). AdalKeep.exe (adal-launcher/online.go, /main) tries the address
 * the Companion found and the office addresses the main PC sends online; the
 * first that answers opens, at the same page. When the main PC goes away
 * again, its page comes back here (lib/companionOnline.js).
 */
const ON_COMPANION = typeof location !== 'undefined' && location.host === '127.0.0.1:47801'

async function look() {
  let tries = ''
  try {
    const { pcAddresses } = await import('../cloud/adapter.js')
    const { list, port } = await pcAddresses()
    tries = list.map(a => `${a}:${port}`).join(',')
  } catch {}
  const r = await fetch(`/main?try=${encodeURIComponent(tries)}`, { headers: { 'X-Adal': '1' } })
  if (!r.ok) return null           // an older AdalKeep.exe: it has no /main
  return (await r.json().catch(() => ({})))?.url || null
}

export function startCompanionDirect() {
  if (!ON_COMPANION) return
  let stopped = false
  const run = async () => {
    if (stopped) return
    let url = null
    try { url = await look() } catch {}
    if (url === null && stopped) return
    if (url) {
      stopped = true
      // A page about a profile made here (not on the PC yet) opens the list instead.
      const here = /\/-\d+/.test(location.pathname) ? '/' : location.pathname
      // With the main PC's number (and this PC's online account): in there at once, nothing typed again.
      let pc = null
      try { pc = JSON.parse(localStorage.getItem('adal-pc') || 'null') } catch {}
      const hand = pc?.number ? `#adal_number=${encodeURIComponent(pc.number)}${pc.cloud?.device ? `&adal_device=${encodeURIComponent(pc.cloud.device)}` : ''}` : ''
      location.replace(`${url.replace(/\/$/, '')}${here}?adal_companion=1&adal_online=ok${hand}`)
      return
    }
    setTimeout(run, 10000)
  }
  setTimeout(run, 500)
}
