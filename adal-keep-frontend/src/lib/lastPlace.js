// Where the person was: the dashboard's "Continue" button opens it again,
// also after Adal Keep was closed (kept in this browser).
const KEY = 'adal-last-place'
const PAGES = [
  [/^\/profiles\/new/, 'አዲስ ፕሮፋይል'], [/^\/profiles\/\d+\/edit/, 'ፕሮፋይል'], [/^\/profiles\/\d+/, 'ፕሮፋይል'], [/^\/profiles/, 'ፕሮፋይሎች'],
  [/^\/cvs\/new/, 'አዲስ ሲቪ'], [/^\/cvs/, 'ሲቪዎች'], [/^\/chat/, 'ቻት'], [/^\/tasks/, 'ተግባሮች'], [/^\/checklist/, 'የክትትል ዝርዝር'],
  [/^\/brokers\/\d+/, 'አመቻቾች'], [/^\/brokers/, 'አመቻቾች'], [/^\/employees/, 'ሰራተኞች'], [/^\/settings/, 'ማስተካከያዎች'],
  [/^\/notifications/, 'ማሳወቂያዎች'], [/^\/trash/, 'መጣያ'],
]

export function rememberPlace(path) {
  if (!path || path === '/' || path.startsWith('/login')) return
  const kind = PAGES.find(([re]) => re.test(path))?.[1] || 'ገጽ'
  const save = (name) => { try { localStorage.setItem(KEY, JSON.stringify({ path, kind, name: name || '', at: Date.now() })) } catch {} }
  save('')
  // A profile or broker page: its name too, once the page has drawn it.
  if (/^\/(profiles|brokers)\/\d+/.test(path)) {
    const look = (tries) => setTimeout(() => {
      if (window.location.pathname + window.location.search !== path) return
      const h = (document.querySelector('main h1') || document.querySelector('h1'))?.textContent?.trim()
      if (h) save(h.slice(0, 60))
      else if (tries > 0) look(tries - 1)
    }, 1500)
    look(6)
  }
}

export function lastPlace() {
  try { const p = JSON.parse(localStorage.getItem(KEY) || 'null'); return p?.path ? p : null } catch { return null }
}
