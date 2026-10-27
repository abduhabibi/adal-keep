/**
 * The Adal tour, browser side (backend: routes/tutor.js).
 *   whoAmI()      the employee signed in here, or this browser's own private id
 *   startTracking the features a person uses (pages + tagged buttons)
 *   showMe()      open the lesson's page and point at the real button
 * The tutor only explains and points; it never clicks anything itself.
 */
import api from '../services/api'

// Not signed in as an employee: a private id for this browser on this PC, made
// once and kept. Everyone has their own tour; nobody
// shares one ("owner" used to be shared by every PC on an install).
const SELF_KEY = 'adal-tutor-self'
let selfId = null
function selfOf() {
  if (selfId) return selfId
  try {
    selfId = localStorage.getItem(SELF_KEY)
    if (!selfId) {
      selfId = 'pc-' + Math.random().toString(36).slice(2, 10)
      localStorage.setItem(SELF_KEY, selfId)
    }
  } catch {
    selfId = selfId || 'pc-' + Math.random().toString(36).slice(2, 10)
  }
  return selfId
}

export function whoAmI() {
  try {
    const e = JSON.parse(localStorage.getItem('adal_active_employee') || 'null')
    if (e?.id != null) return String(e.id)
  } catch {}
  return selfOf()
}

// data-tour value → feature (lesson id)
const TARGET_FEATURE = {
  'search-pad': 'search',
  'new-profile': 'new_profile',
  'field-upload': 'upload_doc',
  'cv-create': 'cv_create',
  'run-police_certificate': 'police_run',
  'run-musaned_add_candidate': 'musaned_run',
  'theme-picker': 'theme',
  'new-broker': 'broker_create',
  'new-employee': 'employee_create',
  'new-checklist': 'checklist',
  'new-cv': 'cv_page',
  'check-updates': 'updates',
}
// Visiting these pages counts as using the feature.
const PAGE_FEATURE = [
  [/^\/checklist/, 'checklist'], [/^\/brokers/, 'brokers'], [/^\/tasks/, 'tasks'],
  [/^\/notifications/, 'notifications'], [/^\/cvs\/?$/, 'cv_page'],
]

const sent = new Set()
export function track(feature) {
  if (!feature) return
  const key = `${whoAmI()}:${feature}`
  if (sent.has(key)) return
  sent.add(key)
  api.post('/tutor/event', { who: whoAmI(), feature })
    .then(() => window.dispatchEvent(new Event('adal-tutor-changed')))
    .catch(() => sent.delete(key))
}
export function trackPage(pathname) {
  for (const [re, f] of PAGE_FEATURE) if (re.test(pathname)) track(f)
}

let started = false
export function startTracking() {
  if (started) return
  started = true
  const onUse = (e) => {
    const el = e.target?.closest?.('[data-tour]')
    if (el) track(TARGET_FEATURE[el.getAttribute('data-tour')])
  }
  document.addEventListener('click', onUse, true)
  document.addEventListener('focusin', onUse, true)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key?.toLowerCase() === 'k') track('search')
  })
}

// ---------------------------------------------------------------- spotlight
let current = null
function clearSpot() {
  if (!current) return
  current.cleanup()
  current = null
}

function bubble(lesson, lang, onClose, tour) {
  const en = lang === 'en'
  const b = document.createElement('div')
  b.className = 'adal-spot-bubble'
  b.setAttribute('role', 'dialog')
  b.innerHTML = `<small></small><strong></strong><p></p><div class="adal-spot-actions"><button type="button" class="ok"></button></div>`
  b.querySelector('small').textContent = tour ? `${en ? `Adal tour · day ${tour.day} of ${tour.days}` : `የአዳል ጉብኝት · ቀን ${tour.day} / ${tour.days}`} · ${tour.step}/${tour.total}` : ''
  b.querySelector('strong').textContent = lesson.title
  b.querySelector('p').textContent = lesson.body
  const ok = b.querySelector('.ok')
  ok.textContent = tour ? (tour.step < tour.total ? (en ? 'Next →' : 'ቀጣይ →') : (en ? 'Done' : 'ጨርስ')) : (en ? 'Got it' : 'ገባኝ')
  ok.onclick = () => onClose('next')
  if (tour) {
    const stop = document.createElement('button')
    stop.type = 'button'; stop.className = 'stop'
    stop.textContent = en ? 'Skip tour' : 'ጉብኝቱን ዝለል'
    stop.onclick = () => onClose('stop')
    b.querySelector('.adal-spot-actions').appendChild(stop)
  }
  return b
}

/**
 * Open the lesson's page and point at its button. `navigate` is react-router's.
 * Resolves 'next' when the person closes the bubble or clicks the button,
 * 'stop' when they stop the tour. `tour` = { step, total } during the full tour.
 */
export async function showMe(lesson, navigate, lang = 'am', tour = null) {
  clearSpot()
  if (lesson.route && window.location.pathname !== lesson.route) navigate(lesson.route)

  let el = null
  if (lesson.target) {
    for (let i = 0; i < 40 && !el; i++) {
      await new Promise(r => setTimeout(r, 150))
      el = document.querySelector(`[data-tour="${lesson.target}"]`)
    }
  } else {
    await new Promise(r => setTimeout(r, 300))
  }

  return new Promise((resolve) => {
    const ring = document.createElement('div')
    ring.className = 'adal-spot-ring'
    const b = bubble(lesson, lang, (how) => done(how), tour)
    document.body.append(ring, b)

    const place = () => {
      if (!el || !document.body.contains(el)) {
        ring.style.display = 'none'
        Object.assign(b.style, { left: '50%', top: '30%', transform: 'translateX(-50%)' })
        return
      }
      const r = el.getBoundingClientRect()
      ring.style.display = ''
      Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` })
      const below = r.bottom + 14 + 150 < window.innerHeight
      const left = Math.min(Math.max(12, r.left), window.innerWidth - 332)
      Object.assign(b.style, { left: `${left}px`, top: below ? `${r.bottom + 14}px` : `${Math.max(12, r.top - 14 - b.offsetHeight)}px`, transform: 'none' })
    }
    if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' })
    place()
    const onMove = () => place()
    const onKey = (e) => { if (e.key === 'Escape') done(tour ? 'stop' : 'next') }
    const onTargetClick = (e) => { if (el && el.contains(e.target)) setTimeout(() => done('next'), 50) }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    window.addEventListener('keydown', onKey)
    document.addEventListener('click', onTargetClick, true)
    const timer = setInterval(place, 400)

    function done(how = 'next') {
      clearSpot()
      resolve(how)
    }
    current = {
      cleanup() {
        clearInterval(timer)
        window.removeEventListener('scroll', onMove, true)
        window.removeEventListener('resize', onMove)
        window.removeEventListener('keydown', onKey)
        document.removeEventListener('click', onTargetClick, true)
        ring.remove(); b.remove()
      },
    }
  })
}
