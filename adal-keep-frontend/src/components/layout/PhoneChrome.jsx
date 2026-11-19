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
import { links, settingsLink, trashLink, showTrash } from './Sidebar'
import { swipeBack } from '../../lib/phoneApp'
import Icon from '../shared/Icon'
import { CountryPicker } from './Navbar'

const icon = (name) => <Icon name={name} size={26} strokeWidth={1.6} />
const TABS = [
  { to: '/', label: 'መነሻ', end: true, icon: icon('home') },
  { to: '/profiles', label: 'ፕሮፋይሎች', icon: icon('profiles') },
  { to: '/cvs', label: 'ሲቪዎች', icon: icon('cv') },
  { to: '/chat', label: 'ቻት', icon: icon('chat') },
  { to: '/more', label: 'ተጨማሪ', icon: icon('more') },
]
const tabOf = (path) => TABS.slice(1).find(t => path === t.to || path.startsWith(t.to + '/'))?.to || (path === '/' ? '/' : null)

// Each page's name (the bar's small title).
const NAMES = [
  // Written in Amharic; English comes from lib/i18n.js.
  [/^\/$/, 'መነሻ'], [/^\/profiles\/new/, 'አዲስ ፕሮፋይል'], [/^\/profiles\/[^/]+\/edit/, 'ፕሮፋይል አርም'], [/^\/profiles\/.+/, 'ፕሮፋይል'],
  [/^\/profiles/, 'ፕሮፋይሎች'], [/^\/cvs\/new/, 'አዲስ ሲቪ'], [/^\/cvs\/templates/, 'የሲቪ ቅጦች'], [/^\/cvs/, 'ሲቪዎች'], [/^\/chat/, 'ቻት'],
  [/^\/brokers\/.+/, 'አመቻች'], [/^\/brokers/, 'አመቻቾች'], [/^\/employees/, 'ሰራተኞች'], [/^\/checklist/, 'የክትትል ዝርዝር'],
  [/^\/tasks/, 'ተግባሮች'], [/^\/notifications/, 'ማሳወቂያዎች'], [/^\/trash/, 'መጣያ'], [/^\/settings/, 'ማስተካከያዎች'], [/^\/more/, 'ተጨማሪ'],
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
    const look = () => api.get('/tasks/count').then(r => { if (typeof r.data?.undone !== 'number') throw new Error('no count'); setTasks(r.data.undone) })
      .catch(() => api.get('/tasks').then(r => setTasks((r.data || []).filter(t => ['pending', 'todo', 'in_progress', 'ongoing'].includes(t.status)).length)).catch(() => {}))
    look()
    const t = setInterval(look, 20000)
    return () => clearInterval(t)
  }, [])
  const inner = isInner(pathname)
  return (
    <header className={`phone-topbar flex h-11 shrink-0 items-center px-2 ${scrolled ? 'is-scrolled' : ''}`} style={{ paddingTop: 0 }}>
      <div className={`flex items-center ${inner ? 'w-24' : 'min-w-24'}`}>
        {/* The destination country (the top bar's on a PC): on the main pages. */}
        {!inner && <CountryPicker />}
        {inner && (
          <button type="button" onClick={() => { if (!swipeBack()) navigate(-1) }} className="phone-press flex items-center gap-0.5 rounded-lg py-1 pl-1 pr-2 text-[17px] font-medium text-teal-600 dark:text-teal-400" aria-label="ተመለስ">
            <Icon name="chevronLeft" size={24} strokeWidth={2.2} />
            <span className="ml-1">ተመለስ</span>
          </button>
        )}
      </div>
      <div className={`min-w-0 flex-1 truncate text-center text-[17px] font-semibold transition-opacity duration-200 ${scrolled || inner ? 'opacity-100' : 'opacity-0'}`}>{nameOf(pathname)}</div>
      <div className="flex w-24 items-center justify-end gap-1">
        <NavLink to="/tasks" className="phone-press relative rounded-full p-2 text-slate-600 dark:text-slate-300" aria-label="ተግባሮች">
          {icon('M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9')}
          {tasks > 0 && <span className="absolute right-0.5 top-0.5 min-w-[18px] rounded-full bg-red-500 px-1 text-center text-[11px] font-bold leading-[18px] text-white">{tasks > 99 ? '99+' : tasks}</span>}
        </NavLink>
        <NavLink to="/notifications" className="phone-press rounded-full p-2 text-slate-600 dark:text-slate-300" aria-label="ማሳወቂያዎች">
          {icon('M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 0 0-4-5.7V5a2 2 0 1 0-4 0v.3A6 6 0 0 0 6 11v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9')}
        </NavLink>
      </div>
    </header>
  )
}


/** More: every other page as one grouped list, as iPhone Settings. */
export function MorePage() {
  const { company } = useAuth()
  const shown = ['/', '/profiles', '/cvs', '/chat']
  const rest = links.filter(l => !shown.includes(l.to))
  const groups = [
    { title: 'ሥራ', items: rest },
    { title: 'Adal Keep', items: [settingsLink, ...(showTrash() ? [trashLink] : [])] },
  ]
  return (
    <div className="phone-more mx-auto max-w-xl pb-6">
      <h1 className="px-1 pb-4 pt-1 text-[34px] font-bold leading-tight tracking-tight">ተጨማሪ</h1>
      <div className="phone-group mb-6 flex items-center gap-3 p-3">
        <img src="/adal-logo.png" alt="" className="h-14 w-14 rounded-2xl object-cover" />
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold">{company ? `Adal ${company}` : 'Adal Keep'}</div>
        </div>
      </div>
      {groups.map(g => (
        <section key={g.title} className="mb-6">
          <div className="px-4 pb-1.5 text-[13px] uppercase tracking-wide text-slate-500">{g.title}</div>
          <div className="phone-group overflow-hidden">
            {g.items.map((l, i) => (
              <NavLink key={l.to} to={l.to} className="phone-row phone-press flex items-center gap-3 px-3 py-2.5">
                <span className="ak-tile flex h-8 w-8 shrink-0 items-center justify-center rounded-lg [&_svg]:h-[18px] [&_svg]:w-[18px]">{l.icon}</span>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2 py-1">
                  <span className="min-w-0 text-[17px] leading-snug">{l.label}</span>
                  <Icon name="chevronRight" size={16} strokeWidth={2} className="shrink-0 text-slate-300 dark:text-slate-600" />
                </span>
              </NavLink>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
