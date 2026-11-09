/**
 * Adal Keep opened inside the phone app (adal-phone): its WebView adds
 * "AdalKeepPhone" to the user agent. The app's own pairing screen lives at
 * http://localhost/ inside the phone.
 */
export const IN_PHONE_APP = typeof navigator !== 'undefined' && /AdalKeepPhone/.test(navigator.userAgent || '')
export const PAIR_PAGE = 'http://localhost/connect.html?pair=1'

// The phone's back button (adal-phone MainActivity asks window.__adalBack()):
// the newest open full-screen view closes first, then the page goes back.
const backStack = []
export function onBack(fn) { backStack.push(fn); return () => { const i = backStack.lastIndexOf(fn); if (i >= 0) backStack.splice(i, 1) } }
if (typeof window !== 'undefined') window.__adalBack = () => {
  if (backStack.length) { try { backStack[backStack.length - 1]() } catch {} return true }
  if ((history.state?.idx || 0) > 0) { history.back(); return true }
  if (location.pathname !== '/' && location.pathname !== '/index.html') {
    history.replaceState({ ...(history.state || {}), idx: 0 }, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    return true
  }
  return false
}

/**
 * A swipe from left to right: back — the newest open view closes (an open
 * chat, a selection…), else the page goes back. False when there is nothing
 * to go back from: the swipe then opens the sidebar.
 */
export function swipeBack() {
  if (backStack.length) { try { backStack[backStack.length - 1]() } catch {} return true }
  // Back only out of a page inside a page (a profile, a broker, an edit): from a
  // menu page (Profiles, Brokers, Chat…) the swipe opens the sidebar.
  const parts = location.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return false
  if ((history.state?.idx || 0) > 0) { history.back(); return true }
  const up = '/' + parts.slice(0, -1).join('/')
  history.replaceState({ ...(history.state || {}), idx: 0 }, '', up)
  window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  return true
}

/** An outside link (a WhatsApp chat…): on a phone the WebView hands it to the app
 *  that opens it (WhatsApp); on a PC a new tab. */
export function openOutside(url) {
  if (!url) return
  if (IN_PHONE_APP || window.__ADAL_CLOUD) { window.location.href = url; return }
  window.open(url, '_blank', 'noopener')
}

const printer = () => { const p = window.Capacitor?.Plugins?.AdalDiscovery; return p?.printHtml ? p : null }
/** A page to print: window.print() does nothing in the phone app, so Android's
 *  print screen opens instead. False when not in the app: print as usual. */
export async function printOnPhone(html) {
  if (!printer()) return false
  await printer().printHtml({ html })
  return true
}
/** A stored file to print, in the phone app: a PDF as it is, a picture on a page. */
export async function printFileOnPhone(blob, name) {
  if (!printer()) return false
  const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob) })
  if (/pdf/i.test(blob.type)) await printer().printPdf({ base64: String(data).split(',')[1], name: name || 'Adal Keep.pdf' })
  else await printer().printHtml({ html: `<!doctype html><html><body style="margin:0"><img src="${data}" style="width:100%"></body></html>` })
  return true
}
