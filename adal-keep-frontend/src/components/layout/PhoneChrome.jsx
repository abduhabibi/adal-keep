/**
 * The phone's frame, in the iPhone's own way (asked on 2026-11-16: "mind
 * blowing, unimaginably easy, Apple navigation, too fast"):
 *
 *   PhoneTabBar  five tabs at the bottom — Home, Profiles, CVs, Chat, More —
 *                always in reach of the thumb; a tab tapped again goes back to
 *                its top (as on an iPhone).
 *   PhoneTopBar  a slim bar: ‹ back on a page inside a page, the page's name
 *                fading in once its own big title has scrolled away, the bell.
 *   MorePage     everything else as one grouped list (as iPhone Settings).
 *   pageMotion   a page opened slides in from the right, going back slides it
 *                from the left, a tab change just fades — transform and
 *                opacity only, so it never stutters.
 *   prefetchTabs the five tabs' pages are fetched while the phone is idle, so
 *                a tap opens them at once.
 */
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import api from '../../services/api'
import { useAuth } from '../../context/AuthContext'
import { links, settingsLink, trashLink, onMainPC } from './Sidebar'
import { swipeBack } from '../../lib/phoneApp'

const icon = (d, extra = null) => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d={d} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />{extra}
  </svg>
)
const TABS = [
  { to: '/', label: 'Home', end: true, icon: icon('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9.5Z') },
  { to: '/profiles', label: 'Profiles', icon: icon('M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM21 19v-1a4 4 0 0 0-3-3.87M15.5 3.13a3.5 3.5 0 0 1 0 6.75') },
  { to: '/cvs', label: 'CVs', icon: icon('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z M14 3v5h5 M9 13h6 M9 17h4') },
  { to: '/chat', label: 'Chat', icon: icon('M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z') },
  { to: '/more', label: 'More', icon: icon('M5 12h.01M12 12h.01M19 12h.01', <><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></>) },
]
const tabOf = (path) => TABS.slice(1).find(t => path === t.to || path.startsWith(t.to + '/'))?.to || (path === '/' ? '/' : null)

// Each page's name (the bar's small title).
const NAMES = [
  [/^\/$/, 'Home'], [/^\/profiles\/new/, 'New profile'], [/^\/profiles\/[^/]+\/edit/, 'Edit profile'], [/^\/profiles\/.+/, 'Profile'],
  [/^\/profiles/, 'Profiles'], [/^\/cvs\/new/, 'New CV'], [/^\/cvs\/templates/, 'CV templates'], [/^\/cvs/, 'CVs'], [/^\/chat/, 'Chat'],
  [/^\/brokers\/.+/, 'Broker'], [/^\/brokers/, 'Brokers'], [/^\/employees/, 'Employees'], [/^\/checklist/, 'Checklists'],
  [/^\/tasks/, 'Tasks'], [/^\/notifications/, 'Notifications'], [/^\/trash/, 'Trash'], [/^\/settings/, 'Settings'], [/^\/more/, 'More'],
]
const nameOf = (path) => NAMES.find(([re]) => re.test(path))?.[1] || 'Adal Keep'
// A page inside a page (a profile, a broker, a new CV …): it has a back arrow.
const isInner = (path) => path.split('/').filter(Boolean).length >= 2

/** The tabs' pages, fetched while the phone is idle: a tap then opens at once. */
export function prefetchTabs() {
  const go = () => {
    for (const load of [() => import('../../pages/ProfilesPage'), () => import('../../pages/CVsPage'), () => import('../../pages/ChatPage'),
      () => import('../../pages/DashboardPage'), () => import('../../pages/ProfileDetailPage'), () => import('../../pages/NotificationsPage'),
      () => import('../../pages/SettingsPage'), () => import('../../pages/BrokersPage'), () => import('../../pages/TasksPage')]) load().catch(() => {})
  }
  ;(window.requestIdleCallback || ((f) => setTimeout(f, 1200)))(go, { timeout: 4000 })
}

/** How the page comes in: 'push' (deeper), 'pop' (back) or 'tab' (another tab). */
export function usePageMotion() {
  const { pathname } = useLocation()
  const type = useNavigationType()
  const last = useRef(pathname)
  const [motion, setMotion] = useState('')
  useEffect(() => {
    const from = last.current
    last.current = pathname
    if (from === pathname) return
    const depth = (p) => p.split('/').filter(Boolean).length
    setMotion(type === 'POP' ? 'phone-pop' : tabOf(from) !== tabOf(pathname) && depth(pathname) <= 1 ? 'phone-fade' : depth(pathname) > depth(from) ? 'phone-push' : 'phone-fade')
  }, [pathname, type])
  return motion
}

/** The bottom tabs. Hidden while the keyboard is up (it would sit on it). */
export function PhoneTabBar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [keyboard, setKeyboard] = useState(false)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const full = window.innerHeight
    const on = () => setKeyboard(vv.height < full * 0.75)
    vv.addEventListener('resize', on)
    return () => vv.removeEventListener('resize', on)
  }, [])
  if (keyboard) return null
  const here = tabOf(pathname)
  return (
    <nav className="phone-tabbar fixed inset-x-0 bottom-0 z-40 flex border-t" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} aria-label="Tabs">
      {TABS.map(t => {
        const on = here === t.to || (t.to === '/more' && here === null)
        return (
          <NavLink key={t.to} to={t.to} end={t.end} aria-current={on ? 'page' : undefined}
            onClick={(e) => {
              // The tab you are on, tapped again: back to its top (and its first page).
              if (!on) return
              e.preventDefault()
              const main = document.querySelector('main')
              if (pathname !== t.to) navigate(t.to)
              else main?.scrollTo({ top: 0, behavior: 'smooth' })
            }}
            className={`phone-tab flex flex-1 flex-col items-center justify-center gap-0.5 pt-1.5 pb-1 ${on ? 'is-on' : ''}`}>
            {t.icon}
            <span className="text-[10.5px] font-semibold leading-none">{t.label}</span>
          </NavLink>
        )
      })}
    </nav>
  )
}

/** The slim top bar: back, the page's name once its own title scrolled away, the bell. */
export function PhoneTopBar({ scroller }) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [scrolled, setScrolled] = useState(false)
  const [tasks, setTasks] = useState(0)
  useEffect(() => {
    const el = scroller?.current
    if (!el) return
    const on = () => setScrolled(el.scrollTop > 48)
    on()
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [scroller, pathname])
  useEffect(() => {
    const look = () => api.get('/tasks').then(r => setTasks((r.data || []).filter(t => ['pending', 'todo', 'in_progress', 'ongoing'].includes(t.status)).length)).catch(() => {})
    look()
    const t = setInterval(look, 20000)
    return () => clearInterval(t)
  }, [])
  const inner = isInner(pathname)
  return (
    <header className={`phone-topbar flex h-11 shrink-0 items-center px-2 ${scrolled ? 'is-scrolled' : ''}`} style={{ paddingTop: 0 }}>
      <div className="flex w-24 items-center">
        {inner && (
          <button type="button" onClick={() => { if (!swipeBack()) navigate(-1) }} className="phone-press flex items-center gap-0.5 rounded-lg py-1 pl-1 pr-2 text-[17px] font-medium text-teal-600 dark:text-teal-400" aria-label="Back">
            <svg width="13" height="21" viewBox="0 0 13 21" fill="none" aria-hidden="true"><path d="M11 2 2.5 10.5 11 19" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span className="ml-1">Back</span>
          </button>
        )}
      </div>
      <div className={`min-w-0 flex-1 truncate text-center text-[17px] font-semibold transition-opacity duration-200 ${scrolled || inner ? 'opacity-100' : 'opacity-0'}`}>{nameOf(pathname)}</div>
      <div className="flex w-24 items-center justify-end gap-1">
        <NavLink to="/tasks" className="phone-press relative rounded-full p-2 text-slate-600 dark:text-slate-300" aria-label="Tasks">
          {icon('M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9')}
          {tasks > 0 && <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-red-500 px-1 text-center text-[11px] font-bold leading-[18px] text-white">{tasks > 99 ? '99+' : tasks}</span>}
        </NavLink>
        <NavLink to="/notifications" className="phone-press rounded-full p-2 text-slate-600 dark:text-slate-300" aria-label="Notifications">
          {icon('M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-4-5.7V5a2 2 0 1 0-4 0v.3A6 6 0 0 0 6 11v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9')}
        </NavLink>
      </div>
    </header>
  )
}

const TINTS = ['#0ea5e9', '#22c55e', '#f59e0b', '#a855f7', '#ef4444', '#14b8a6', '#6366f1', '#f97316', '#64748b']

/** More: every other page as one grouped list, as iPhone Settings. */
export function MorePage() {
  const { company } = useAuth()
  const shown = ['/', '/profiles', '/cvs', '/chat']
  const rest = links.filter(l => !shown.includes(l.to))
  const groups = [
    { title: 'Work', items: rest },
    { title: 'Adal Keep', items: [settingsLink, ...(onMainPC() ? [trashLink] : [])] },
  ]
  let n = 0
  return (
    <div className="phone-more mx-auto max-w-xl pb-6">
      <h1 className="px-1 pb-4 pt-1 text-[34px] font-bold leading-tight tracking-tight">More</h1>
      <div className="phone-group mb-6 flex items-center gap-3 p-3">
        <img src="/adal-logo.png" alt="" className="h-14 w-14 rounded-2xl object-cover" />
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold">{company ? `Adal ${company}` : 'Adal Keep'}</div>
          <div className="text-[13px] text-slate-500">Your agency</div>
        </div>
      </div>
      {groups.map(g => (
        <section key={g.title} className="mb-6">
          <div className="px-4 pb-1.5 text-[13px] uppercase tracking-wide text-slate-500">{g.title}</div>
          <div className="phone-group overflow-hidden">
            {g.items.map((l, i) => (
              <NavLink key={l.to} to={l.to} className="phone-row phone-press flex items-center gap-3 px-3 py-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white [&_svg]:h-[18px] [&_svg]:w-[18px]" style={{ background: TINTS[n++ % TINTS.length] }}>{l.icon}</span>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2 py-1">
                  <span className="truncate text-[17px]">{l.label}</span>
                  <svg width="8" height="13" viewBox="0 0 8 13" fill="none" className="shrink-0 text-slate-300 dark:text-slate-600" aria-hidden="true"><path d="m1.5 1.5 5 5-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
              </NavLink>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
