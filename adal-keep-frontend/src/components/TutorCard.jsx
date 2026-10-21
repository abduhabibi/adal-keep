import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import api from '../services/api'
import { showMe, startTracking, trackPage, whoAmI } from '../lib/tutor'

/**
 * The daily tutor: a streak, today's goals (one lesson + today's real work),
 * the full tour of every feature, progress, and "Ask Adal".
 *   <TutorCard floating />  a row in the sidebar, under the menu; hovering it shows
 *                           the card beside it. It also opens by itself each time
 *                           the app is opened, until the full tour has shown every part.
 *   <TutorCard />           the same, as a section at the bottom of Settings.
 * <TutorTracker /> (in the layout, every page) counts the features people use.
 */
const T = {
  am: { title: 'የዛሬ ትምህርት', goals: 'የዛሬ ግቦች', show: 'አሳየኝ', go: 'ሂድ', ask: 'አዳልን ይጠይቁ… (ለምሳሌ፦ ሲቪ እንዴት አዘጋጃለሁ?)', send: 'ጠይቅ',
        streak: (n) => `${n} ቀን ተከታታይ`, used: (u, t) => `${t} ባህሪያት ውስጥ ${u}ቱን ይጠቀማሉ`, allDone: 'የዛሬውን ሁሉ ጨርሰዋል! 🎉', thinking: 'እያሰብኩ ነው…', hide: 'ደብቅ',
        tour: 'የሲስተሙ ሙሉ ጉብኝት', tourOf: (s, t) => `${t} ክፍሎች ውስጥ ${s}ቱ ታይተዋል`, start: '▶ ጉብኝቱን ጀምር', cont: '▶ ጉብኝቱን ቀጥል', tourDone: 'ሙሉውን ሲስተም አይተዋል ✓', again: 'እንደገና አሳየኝ' },
  en: { title: "Today's lesson", goals: "Today's goals", show: 'Show me', go: 'Go', ask: 'Ask Adal… (e.g. how do I make a CV?)', send: 'Ask',
        streak: (n) => `${n}-day streak`, used: (u, t) => `You use ${u} of ${t} features`, allDone: 'All done for today! 🎉', thinking: 'Thinking…', hide: 'Hide',
        tour: 'Full tour of the system', tourOf: (s, t) => `${s} of ${t} parts shown`, start: '▶ Start the tour', cont: '▶ Continue the tour', tourDone: 'You have seen the whole system ✓', again: 'Show it again' },
}
// One pop-up per app start (a new tab or window), not on every page change.
const POPPED = 'adal-tutor-popped'

// Gemini writes **bold**: show it as bold, everything else as text.
function Rich({ text }) {
  return String(text || '').split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>)
}

export function TutorTracker() {
  const location = useLocation()
  useEffect(() => { startTracking() }, [])
  useEffect(() => { trackPage(location.pathname) }, [location.pathname])
  return null
}

export default function TutorCard({ floating = false, collapsed = false }) {
  const navigate = useNavigate()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(!floating)
  const [touring, setTouring] = useState(false)
  const [q, setQ] = useState('')
  const [answer, setAnswer] = useState(null)
  const [asking, setAsking] = useState(false)
  const stopRef = useRef(false)
  // Sidebar mode: where the card goes (beside the row) and the hover timing.
  const rowRef = useRef(null)
  const closeTimer = useRef(null)
  const [pos, setPos] = useState(null)
  const place = useCallback(() => {
    const r = rowRef.current?.getBoundingClientRect()
    const edge = rowRef.current?.closest('aside')?.getBoundingClientRect().right ?? r?.right
    if (r) setPos({ left: edge + 10, bottom: Math.max(12, window.innerHeight - r.bottom - 8) })
  }, [])
  const show = () => { clearTimeout(closeTimer.current); place(); setOpen(true) }
  const hideSoon = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => setOpen(false), 300) }

  const load = useCallback(async () => {
    try {
      const r = await api.get('/tutor/today', { params: { who: whoAmI() } })
      setData(r.data)
      return r.data
    } catch { setData(null) }
  }, [])

  useEffect(() => {
    load().then(d => {
      if (!floating || !d) return
      // Opens by itself every time the app is opened, until the tour is complete.
      try {
        if (!d.tour.done && !sessionStorage.getItem(POPPED)) { setTimeout(show, 300); sessionStorage.setItem(POPPED, '1') }
      } catch { if (!d.tour.done) setTimeout(show, 300) }
    })
    const onChange = () => load()
    window.addEventListener('adal-tutor-changed', onChange)
    return () => window.removeEventListener('adal-tutor-changed', onChange)
  }, [load, floating])

  // Opened by itself (no hover): a click anywhere else closes it.
  useEffect(() => {
    if (!floating || !open || touring) return
    const onDown = (e) => {
      if (rowRef.current?.contains(e.target) || e.target.closest?.('[data-tutor-card]')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [floating, open, touring])

  if (!data) return null
  const t = T[data.lang] || T.am
  const doneCount = data.goals.filter(g => g.done).length
  const tour = data.tour

  const post = async (path, body) => {
    try { const r = await api.post(path, { who: data.who, ...body }); setData(r.data); return r.data } catch { return null }
  }
  const lessonShow = async (lesson) => {
    if (floating) setOpen(false)
    await showMe(lesson, navigate, data.lang)
    await post('/tutor/seen', { lesson: lesson.id })
    if (lesson.id === data.lesson.id) await post('/tutor/goal', { goal: 'lesson' })
  }
  // The full tour: every part not shown yet, one after another.
  const runTour = async () => {
    if (touring) return
    const list = tour.remaining.length ? tour.remaining : []
    if (!list.length) return
    setTouring(true); stopRef.current = false
    if (floating) setOpen(false)
    let step = tour.seen
    for (const lesson of list) {
      step++
      const how = await showMe(lesson, navigate, data.lang, { step, total: tour.total })
      await post('/tutor/seen', { lesson: lesson.id })
      if (how === 'stop' || stopRef.current) break
    }
    setTouring(false)
    if (floating) show()
  }
  const setLang = async (lang) => { await post('/tutor/lang', { lang }); setAnswer(null) }
  const ask = async (e) => {
    e.preventDefault()
    if (!q.trim() || asking) return
    setAsking(true); setAnswer(null)
    try {
      const r = await api.post('/tutor/ask', { who: data.who, question: q, lang: data.lang })
      setAnswer(r.data)
    } catch {
      setAnswer({ answer: data.lang === 'en' ? 'Could not reach the tutor.' : 'አስተማሪውን ማግኘት አልተቻለም።' })
    } finally { setAsking(false) }
  }

  // Sidebar row: always there, under the menu.
  const row = floating && (
    <button
      ref={rowRef}
      type="button"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onClick={() => (open ? setOpen(false) : show())}
      title={collapsed ? t.title : ''}
      className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 ${open ? 'bg-slate-100 dark:bg-slate-800' : ''} ${collapsed ? 'justify-center px-0' : ''}`}
    >
      <span className="shrink-0 text-base leading-none">🎓</span>
      {!collapsed && (
        <span className="flex-1 min-w-0 flex items-center gap-1.5 text-left">
          <span className="truncate">{data.lang === 'en' ? 'Adal tutor' : 'የአዳል አስተማሪ'}</span>
          <span className="ml-auto text-[11px] font-semibold text-orange-600 dark:text-orange-400">🔥{data.streak.days}</span>
          {!tour.done && <span className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">{tour.seen}/{tour.total}</span>}
        </span>
      )}
    </button>
  )
  if (floating && !open) return row

  const shell = floating
    ? 'fixed z-[60] w-[min(360px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-y-auto rounded-2xl shadow-2xl border border-slate-200 bg-white text-slate-800 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600'
    : 'panel overflow-hidden text-slate-800 dark:text-slate-100'

  const card = (
    <section
      data-tour={floating ? undefined : 'tutor'}
      data-tutor-card
      className={shell}
      style={floating && pos ? { left: pos.left, bottom: pos.bottom } : undefined}
      onMouseEnter={floating ? show : undefined}
      onMouseLeave={floating ? hideSoon : undefined}
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="text-lg">🎓</span>
        <span className="font-bold text-sm">{data.lang === 'en' ? 'Adal tutor' : 'የአዳል አስተማሪ'}</span>
        <span className="text-xs font-semibold text-orange-600 dark:text-orange-400">🔥 {t.streak(data.streak.days)}</span>
        <div className="ml-auto flex items-center gap-1">
          {['am', 'en'].map(l => (
            <button key={l} type="button" onClick={() => setLang(l)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${data.lang === l ? 'bg-teal-600 text-white' : 'text-slate-500 dark:text-slate-300'}`}>
              {l === 'am' ? 'አማ' : 'EN'}
            </button>
          ))}
          {floating && <button type="button" onClick={() => setOpen(false)} className="ml-1 px-1.5 text-slate-400 hover:text-slate-600" title={t.hide}>—</button>}
        </div>
      </div>

      {/* Full tour */}
      <div className="mx-4 mt-3 rounded-xl p-3 bg-indigo-50 dark:bg-indigo-900/30">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-indigo-700 dark:text-indigo-300">{t.tour}</p>
          <p className="text-[10px] text-slate-500">{t.tourOf(tour.seen, tour.total)}</p>
        </div>
        <div className="h-1.5 mt-1.5 rounded-full bg-indigo-100 dark:bg-indigo-950 overflow-hidden">
          <div className="h-full bg-indigo-500" style={{ width: `${Math.round(100 * tour.seen / tour.total)}%` }} />
        </div>
        {tour.done
          ? <p className="mt-2 text-xs font-semibold text-green-700 dark:text-green-400">{t.tourDone}</p>
          : <button type="button" onClick={runTour} disabled={touring}
              className="mt-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-3 py-1.5 disabled:opacity-60">
              {tour.seen ? t.cont : t.start}
            </button>}
      </div>

      {/* Today's lesson */}
      <div className="mx-4 mt-3 rounded-xl p-3 bg-teal-50 dark:bg-teal-900/30">
        <p className="text-[10px] uppercase tracking-wide font-semibold text-teal-700 dark:text-teal-300">{t.title}</p>
        <p className="font-semibold text-sm mt-0.5">{data.lesson.title} {data.lesson.done && '✓'}</p>
        <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{data.lesson.body}</p>
        <button type="button" onClick={() => lessonShow(data.lesson)}
          className="mt-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold px-3 py-1.5">
          👉 {data.lesson.done ? t.again : t.show}
        </button>
      </div>

      {/* Goals */}
      <div className="px-4 mt-3">
        <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">{t.goals} · {doneCount}/{data.goals.length}</p>
        <ul className="mt-1 space-y-1">
          {data.goals.map(g => (
            <li key={g.id} className="flex items-center gap-2 text-xs">
              <span className={`flex-none w-4 h-4 rounded-full border flex items-center justify-center text-[10px] ${g.done ? 'bg-green-500 border-green-500 text-white' : 'border-slate-300 dark:border-slate-500'}`}>{g.done ? '✓' : ''}</span>
              <span className={`flex-1 ${g.done ? 'line-through text-slate-400' : ''}`}>{g.text}</span>
              {!g.done && (g.lesson
                ? <button type="button" onClick={() => lessonShow(data.lesson)} className="text-teal-700 dark:text-teal-300 font-semibold">{t.show}</button>
                : <button type="button" onClick={() => { post('/tutor/goal', { goal: g.id }); if (floating) setOpen(false); navigate(g.route) }} className="text-teal-700 dark:text-teal-300 font-semibold">{t.go} →</button>)}
            </li>
          ))}
        </ul>
        {data.allDone && <p className="mt-2 text-xs font-semibold text-green-600 dark:text-green-400">{t.allDone}</p>}
      </div>

      {/* Progress */}
      <div className="px-4 mt-3">
        <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-teal-500 to-indigo-500" style={{ width: `${Math.round(100 * data.progress.used / data.progress.total)}%` }} />
        </div>
        <p className="text-[10px] text-slate-500 mt-1">{t.used(data.progress.used, data.progress.total)}</p>
      </div>

      {/* Ask Adal */}
      <form onSubmit={ask} className="px-4 pb-4 mt-3">
        <div className="flex gap-1.5">
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t.ask}
            className="flex-1 min-w-0 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none" />
          <button type="submit" disabled={asking || !q.trim()} className="rounded-lg bg-slate-800 dark:bg-slate-600 text-white text-xs font-semibold px-3 disabled:opacity-50">{t.send}</button>
        </div>
        {asking && <p className="text-xs text-slate-500 mt-2">{t.thinking}</p>}
        {answer && (
          <div className="mt-2 rounded-lg bg-slate-50 dark:bg-slate-900/60 p-2.5 text-xs leading-relaxed whitespace-pre-line">
            <Rich text={answer.answer} />
            {answer.lesson && (
              <button type="button" onClick={() => lessonShow(answer.lesson)} className="mt-2 block text-teal-700 dark:text-teal-300 font-semibold">
                👉 {t.show}: {answer.lesson.title}
              </button>
            )}
          </div>
        )}
      </form>
    </section>
  )
  return floating ? <>{row}{card}</> : card
}
