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
