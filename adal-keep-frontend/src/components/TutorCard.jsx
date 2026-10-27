import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import api from '../services/api'
import { showMe, startTracking, trackPage, whoAmI } from '../lib/tutor'

/**
 * The Adal tour.
 *   <TutorTracker />  in the layout, on every page: counts the features people
 *                     use and, once a day, on the first page opened, points at
 *                     up to 3 things worth knowing (Next / Skip tour). Every
 *                     part is shown within 2 weeks.
 *   <TutorCard />     a small panel in Settings: progress, language, and
 *                     "show today's tips again".
 */
const T = {
  am: { title: 'የአዳል ጉብኝት', of: (s, t) => `${t} ነገሮች ውስጥ ${s}ቱ ታይተዋል`, day: (d, n) => `ቀን ${d} / ${n}`,
        again: '▶ የዛሬውን አሳየኝ', done: 'ሁሉንም አይተዋል ✓',
        note: 'በቀን አንድ ጊዜ፣ መጀመሪያ በሚከፍቱት ገጽ ላይ 3 ነገሮችን ያሳያል። በ2 ሳምንት ውስጥ ሁሉም ይታያሉ።' },
  en: { title: 'Adal tour', of: (s, t) => `${s} of ${t} things shown`, day: (d, n) => `Day ${d} of ${n}`,
        again: "▶ Show today's tips", done: 'You have seen everything ✓',
        note: 'Once a day, on the first page you open, it shows 3 things worth knowing. Everything is shown within 2 weeks.' },
}
const today = () => new Date().toLocaleDateString('en-CA')
const CHECKED = () => `adal-tour-${whoAmI()}-${today()}`
let touring = false

/** Today's tips, one after another. force: even when today's were shown. */
async function runTour(navigate, page, force = false) {
  if (touring) return
  if (import.meta.env.VITE_ADMIN === '1' && !force) return   // Adal Keep Admin: no tour
  touring = true
  try {
    const { data } = await api.get('/tutor/tour', { params: { who: whoAmI(), page } })
    try { localStorage.setItem(CHECKED(), '1') } catch {}
    if (!(data.show || force) || !data.lessons.length) return
    await api.post('/tutor/tour/shown', { who: data.who }).catch(() => {})
    const total = data.lessons.length
    for (let i = 0; i < total; i++) {
      const lesson = data.lessons[i]
      const how = await showMe(lesson, navigate, data.lang, { step: i + 1, total, day: data.day, days: data.days })
      await api.post('/tutor/seen', { who: data.who, lesson: lesson.id }).catch(() => {})
      if (how === 'stop') break
    }
    window.dispatchEvent(new Event('adal-tutor-changed'))
  } catch {
  } finally {
    touring = false
  }
}

export function TutorTracker() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => { startTracking() }, [])
  useEffect(() => { trackPage(location.pathname) }, [location.pathname])
  // Once a day, on the first page opened (asked once per day per browser).
  useEffect(() => {
    if (touring) return
    try { if (localStorage.getItem(CHECKED())) return } catch {}
    const t = setTimeout(() => runTour(navigate, location.pathname), 1200)
    return () => clearTimeout(t)
  }, [location.pathname, navigate])
  useEffect(() => {
    const now = () => runTour(navigate, window.location.pathname, true)
    window.addEventListener('adal-tour-now', now)
    return () => window.removeEventListener('adal-tour-now', now)
  }, [navigate])
  return null
}

export default function TutorCard() {
  const [data, setData] = useState(null)
  const load = useCallback(() => {
    api.get('/tutor/tour', { params: { who: whoAmI(), page: '/settings' } }).then(r => setData(r.data)).catch(() => setData(null))
  }, [])
  useEffect(() => {
    load()
    window.addEventListener('adal-tutor-changed', load)
    return () => window.removeEventListener('adal-tutor-changed', load)
  }, [load])
  if (!data) return null
  const t = T[data.lang] || T.am
  const setLang = async (lang) => { await api.post('/tutor/lang', { who: data.who, lang }).catch(() => {}); load() }

  return (
    <section data-tour="tutor" className="panel p-4 text-slate-800 dark:text-slate-100">
      <div className="flex items-center gap-2">
        <span className="text-lg">🎓</span>
        <span className="font-bold text-sm">{t.title}</span>
        {!data.done && <span className="text-[11px] text-slate-500">{t.day(data.day, data.days)}</span>}
        <div className="ml-auto flex items-center gap-1">
          {['am', 'en'].map(l => (
            <button key={l} type="button" onClick={() => setLang(l)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${data.lang === l ? 'bg-teal-600 text-white' : 'text-slate-500 dark:text-slate-300'}`}>
              {l === 'am' ? 'አማ' : 'EN'}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-slate-500 mt-1">{t.note}</p>
      <div className="h-1.5 mt-3 rounded-full bg-indigo-100 dark:bg-indigo-950 overflow-hidden">
        <div className="h-full bg-indigo-500" style={{ width: `${Math.round(100 * data.seen / data.total)}%` }} />
      </div>
      <p className="text-[11px] text-slate-500 mt-1">{t.of(data.seen, data.total)}</p>
      {data.done
        ? <p className="mt-2 text-xs font-semibold text-green-700 dark:text-green-400">{t.done}</p>
        : <button type="button" onClick={() => window.dispatchEvent(new Event('adal-tour-now'))}
            className="mt-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-1.5">
            {t.again}
          </button>}
    </section>
  )
}
