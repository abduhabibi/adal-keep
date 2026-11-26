/**
 * siteMap/musaned.js — Musaned's screens once signed in, and the ways between them, up to the Add Candidate pre-check
 * (docs/robot-architecture.md, part 1). Sign-in screens are one gate here: the run's sign-in path does them.
 * Recognisers read the address and marks on the page only (instantScreen's look plus three marks), never AI.
 */
import { LOOK_IN_PAGE } from '../instantScreen.js'

export const ROOT = 'https://tawtheeq.musaned.com.sa'
const MUSANED = /(^|\.)musaned\.com\.sa$/i, SIGN_IN = /(^|\.)wahid\.sa$/i

function MARKS_IN_PAGE() {
  const seen = (e) => { if (!e || !e.getClientRects().length) return false; const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) !== 0 }
  const btn = (re) => [...document.querySelectorAll('button, a, [role="button"]')].some(e => re.test((e.textContent || '').trim()) && seen(e))
  return {
    url: location.href,
    // (Its window's own title too: an "ID Number" box alone may be a list's search.)
    idBox: [...document.querySelectorAll('input')].some(i => /id\s*number/i.test(i.placeholder || '') && seen(i)) && /candidate\s+pre-check/i.test(document.body?.innerText || ''),
    addNew: btn(/add\s+new\s+candidate/i),
    hrPoolLink: [...document.querySelectorAll('a, button, [role="button"], [role="menuitem"]')].some(e => (/\/hr-pool/i.test(e.getAttribute('href') || '') || /^hr\s*pool$/i.test((e.textContent || '').trim())) && seen(e)),
    loading: !document.body || (document.body.innerText || '').trim().length < 20,
  }
}

async function look(page) {
  const url = page.url()
  if (/^chrome-error:/i.test(url)) return { url, chromeError: true }
  const [a, b] = await Promise.all([page.evaluate(LOOK_IN_PAGE), page.evaluate(MARKS_IN_PAGE)])
  return { ...a, ...b }
}

// Clicks the first seen element whose text (or href) matches; true when clicked.
const clickIn = (page, src, href = '') => page.evaluate((src, href) => {
  const re = new RegExp(src, 'i'), h = href ? new RegExp(href, 'i') : null
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 5 && r.height > 5 }
  const el = [...document.querySelectorAll('a, button, [role="button"], [role="menuitem"]')].find(e => seen(e) && ((h && h.test(e.getAttribute('href') || '')) || re.test((e.textContent || '').trim())))
  if (!el) return false
  el.scrollIntoView({ block: 'center' }); el.click(); return true
}, src, href)
const mustClick = async (page, src, href, what) => { if (!(await clickIn(page, src, href))) throw new Error(`${what} is not on the screen`) }

const musaned = (f) => MUSANED.test(f.host || '') && !f.password && !f.code && !f.captcha

export const musanedMap = {
  site: 'musaned',
  look,
  screens: [
    { name: 'chrome-error', is: (f) => !!f.chromeError },
    { name: 'signed-out', gate: 'sign-in', is: (f) => SIGN_IN.test(f.host || '') || (MUSANED.test(f.host || '') && (f.password || f.code || f.captcha || f.picker)) },
    { name: 'precheck', is: (f) => musaned(f) && f.idBox },
    { name: 'add-form', is: (f) => musaned(f) && /\/hr-pool\/candidates\/add/i.test(f.path) && !f.idBox },
    { name: 'hr-pool', is: (f) => musaned(f) && /^\/hr-pool\/?$/i.test(f.path) && f.addNew },
    { name: 'landing', is: (f) => musaned(f) && f.goTo && f.nav < 2 },
    { name: 'dashboard', is: (f) => musaned(f) && f.nav >= 2 && !f.goTo && !/^\/hr-pool/i.test(f.path) && !/^\/(login|auth)\b/.test(f.path) },
  ],
  actions: [
    { name: 'go-to-dashboard', says: 'Press "Go to dashboard"', from: ['landing'], to: ['dashboard'], cost: 1, ms: 20000, safe: true, do: (p) => mustClick(p, '^go\\s+to\\s+dashboard$', '', '"Go to dashboard"') },
    { name: 'click-hr-pool', says: 'Click "HR Pool" in the menu', from: ['dashboard', 'add-form'], to: ['hr-pool'], cost: 1, ms: 20000, safe: true, do: (p) => mustClick(p, '^hr\\s*pool$', '/hr-pool', 'HR Pool') },
    { name: 'add-new-candidate', says: 'Click "Add new candidate"', from: ['hr-pool'], to: ['precheck'], cost: 1, ms: 20000, safe: true, do: (p) => mustClick(p, 'add\\s+new\\s+candidate', '', '"Add new candidate"') },
    // Musaned's own address of the HR Pool — never one made from a Chrome error page's address.
    { name: 'open-hr-pool', says: "Open the HR Pool's address", from: '*', notFrom: ['signed-out', 'hr-pool', 'precheck'], to: ['hr-pool'], cost: 5, ms: 45000, safe: true, do: (p) => p.goto(`${ROOT}/hr-pool`, { waitUntil: 'domcontentloaded', timeout: 45000 }) },
  ],
}
