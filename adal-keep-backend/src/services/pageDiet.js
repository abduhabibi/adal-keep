/**
 * pageDiet.js — what a run's page does not need does not come down (tabManager.setupTab asks here, before its own rules).
 * Measured on the real public pages (2026-11-25): Musaned loads an analytics program (maze.co) and a speed monitor
 * (apm.tamkeentech.sa) that go on sending for as long as the tab is open; fonts came also from Google's font host
 * (it counted as the captcha's). Only what is named here; a site's own pages, programs and data always come.
 * ADAL_PAGE_DIET=0 turns it off; any doubt or error: it comes down.
 */
const MEASURERS = /(^|\.)(maze\.co|apm\.tamkeentech\.sa|cloudflareinsights\.com|newrelic\.com|nr-data\.net|sentry\.io|datadoghq\.com|browser-intake-datadoghq\.com|fullstory\.com|mouseflow\.com|smartlook\.com|mixpanel\.com|segment\.io|segment\.com|amplitude\.com|intercom\.io|intercomcdn\.com|tawk\.to|bing\.com|bat\.bing\.com|ads-twitter\.com|googleadservices\.com|googlesyndication\.com)$/i
const CAPTCHA = /\/recaptcha\/|hcaptcha\.com|challenges\.cloudflare\.com/i
const host = (u) => { try { return new URL(u).hostname.toLowerCase() } catch { return '' } }

/** req: puppeteer's request. pictures: this page's pictures and fonts are wanted (a captcha's are the site's own). */
export function notNeeded(req, { pictures = false } = {}) {
  if (process.env.ADAL_PAGE_DIET === '0') return false
  try {
    const url = req.url(), h = host(url)
    if (req.isNavigationRequest() || CAPTCHA.test(url)) return false
    if (MEASURERS.test(h)) return true
    // (Google's box in its own frame keeps its letters.)
    if (req.resourceType() === 'font' && !pictures) return !CAPTCHA.test(req.frame()?.url() || '')
  } catch {}
  return false
}
