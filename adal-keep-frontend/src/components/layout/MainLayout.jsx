import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { rememberPlace } from '../../lib/lastPlace'
import Navbar from './Navbar'
import Sidebar from './Sidebar'
import ProfileSearchPad from '../ProfileSearchPad'
import { TutorTracker } from '../TutorCard'
import PhoneCalls from '../PhoneCalls'
import JoinRequests from '../JoinRequests'
import { PcAccessRequests } from '../PcAccessGate'
import AttentionBar from '../AttentionBar'
import HelpButton from '../HelpButton'
import useReadyChime from '../../hooks/useReadyChime'
import useNewVersion from '../../hooks/useNewVersion'
import api from '../../services/api'
import UpdateBanner from '../UpdateBanner'
import WhatsNewCard from '../WhatsNewCard'
import StandbyBanner from '../StandbyBanner'
import SafetyAlerts from '../SafetyAlerts'
import { PresencePing } from '../OfficeCards'
import { tellChanged } from '../../lib/changes'
import { byItself } from '../../lib/windowNote'
import { swipeBack } from '../../lib/phoneApp'
import { PhoneTabBar, PhoneTopBar, usePageMotion, prefetchTabs } from './PhoneChrome'

const PAD_KEY = 'adal-search-pad'

// Public demo build only (src/demo): the run-tab window and the demo banner.
const DEMO = import.meta.env.VITE_DEMO === '1'
const DemoBanner = DEMO ? lazy(() => import('../../demo/DemoBrowser').then(m => ({ default: m.DemoBanner }))) : null
const DemoBrowser = DEMO ? lazy(() => import('../../demo/DemoBrowser')) : null

// The pages that ask again by themselves (their own refresh or lib/changes.js).
const ASKS_AGAIN = /^\/(profiles(\/\d+)?|checklist|chat|tasks|notifications|office|whatsapp|employees)?(\/|$)/

function readPad() {
  try { return localStorage.getItem(PAD_KEY) !== 'closed' } catch { return true }
}

export default function MainLayout() {
  useReadyChime()
  const newVersion = useNewVersion()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // The chat needs the room: the sidebar folds the moment it opens.
  const { pathname } = useLocation()
  // Pages open from what this device kept (services/api.js); the PC's fresh
  // answer, when it differs and comes within a few seconds, shows the page
  // again with it — once per visit, never while something is being typed, and never
  // once this page has been used (clicked, scrolled, a key): then it asks again in
  // place, or (a page that cannot) says there is something newer.
  const [pageKey, setPageKey] = useState(0)
  const visit = useRef({ path: '', at: 0, redone: false, used: false })
  const [newer, setNewer] = useState(false)
  useEffect(() => {
    const used = (e) => { if (mainRef.current?.contains(e.target)) visit.current.used = true }
    const all = ['pointerdown', 'wheel', 'keydown', 'touchmove']
    for (const e of all) window.addEventListener(e, used, { passive: true, capture: true })
    return () => { for (const e of all) window.removeEventListener(e, used, { capture: true }) }
  }, [])
  useEffect(() => { api.adalVisit?.(); visit.current = { path: pathname, at: Date.now(), redone: false, used: false }; setNewer(false); rememberPlace(pathname + window.location.search) }, [pathname])
  useEffect(() => {
    let timer = null
    const on = () => {
      const v = visit.current
      if (v.redone || Date.now() - v.at > 6000) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        const el = document.activeElement
        if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
        if (visit.current !== v || v.redone) return
        v.redone = true
        api.adalVisit?.()
        if (v.used && !byItself()) {
          if (ASKS_AGAIN.test(v.path)) tellChanged(['*']); else setNewer(true)
          return
        }
        setPageKey(k => k + 1)
      }, 350)
    }
    window.addEventListener('adal-data-fresh', on)
    return () => { window.removeEventListener('adal-data-fresh', on); clearTimeout(timer) }
  }, [])
  const inChat = pathname.startsWith('/chat')
  useEffect(() => { if (inChat) setSidebarCollapsed(true) }, [inChat])
  // The profiles search pad is on every page (docked right); it can be folded away.
  const [padOpen, setPadOpen] = useState(readPad)
  // The pad loads every profile: on a phone (where it is not shown) it is not made at all.
  const [wide, setWide] = useState(() => window.matchMedia?.('(min-width: 768px)').matches ?? true)
  useEffect(() => {
    const m = window.matchMedia?.('(min-width: 768px)')
    if (!m) return
    const on = () => setWide(m.matches)
    m.addEventListener?.('change', on)
    return () => m.removeEventListener?.('change', on)
  }, [])
  // An open chat fills the phone (no top bar), as in Telegram.
  const [bare, setBare] = useState(false)
  useEffect(() => {
    const on = (e) => setBare(!!e.detail)
    window.addEventListener('adal-fullscreen', on)
    return () => window.removeEventListener('adal-fullscreen', on)
  }, [])
  // The phone (a narrow screen): the iPhone's way — a slim top bar, the tabs at
  // the bottom, pages that slide in and out (PhoneChrome.jsx, asked on 2026-11-16).
  // The page never changes size while it scrolls (Settings → Portals stuttered).
  const mainRef = useRef(null)
  const motion = usePageMotion()
  useEffect(() => { if (!wide) prefetchTabs() }, [wide])
  // A swipe from left to right (a phone): back — out of the open chat or
  // profile (the More tab holds the rest: no sidebar on a phone). Right to
  // left goes forward again (what the back swipe left).
  useEffect(() => {
    if (wide) return
    let start = null
    const down = (e) => {
      const t = e.touches?.[0]
      if (!t || e.touches.length > 1) { start = null; return }
      // Not from something that moves sideways itself (a slider, a list scrolling sideways, the mic).
      let sideways = false
      for (let el = e.target; el && el !== document.body; el = el.parentElement) {
        if (el.dataset?.noSwipe !== undefined || el.tagName === 'INPUT' && el.type === 'range') { start = null; return }
        const scrollsX = el.scrollWidth > el.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowX)
        if (scrollsX && el.scrollLeft > 0) { start = null; return }
        if (scrollsX) sideways = true   // a table or tab row that scrolls sideways: no forward swipe from it
      }
      start = { x: t.clientX, y: t.clientY, at: Date.now(), sideways }
    }
    const up = (e) => {
      const s = start; start = null
      const t = e.changedTouches?.[0]
      if (!s || !t || Date.now() - s.at > 700) return
      const dx = t.clientX - s.x, dy = t.clientY - s.y
      if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return
      if (dx > 0) {
        if (sidebarOpen) return
        swipeBack()
      } else if (sidebarOpen) setSidebarOpen(false)
      else if (!s.sideways) history.forward()
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchend', up, { passive: true })
    return () => { window.removeEventListener('touchstart', down); window.removeEventListener('touchend', up) }
  }, [wide, sidebarOpen])
  // The watch list is filled by dragging profiles from the pad: it opens with it.
  const onWatchList = pathname.startsWith('/checklist')
  useEffect(() => { if (onWatchList) setPadOpen(true) }, [onWatchList])
  const togglePad = () => setPadOpen(o => {
    try { localStorage.setItem(PAD_KEY, o ? 'closed' : 'open') } catch {}
    return !o
  })

  return (
    <div className="app-shell flex h-[var(--app-h,100vh)] overflow-hidden bg-[var(--bg)]">
      {newVersion && (
        <button type="button" onClick={() => window.location.reload()}
          className="fixed bottom-4 left-1/2 z-[9990] -translate-x-1/2 rounded-full bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-teal-700">
          Adal Keep was updated — click to reload ↻
        </button>
      )}
      {/* Moving gradients — only painted in the Gradient theme */}
      <div className="gradient-backdrop" aria-hidden="true">
        <span /><span /><span /><span />
      </div>

      {DEMO && <Suspense fallback={null}><DemoBrowser /></Suspense>}
      {!DEMO && <TutorTracker />}
      {!DEMO && <JoinRequests />}
      {!DEMO && <PcAccessRequests />}
      {!DEMO && <AttentionBar />}
      {!DEMO && <PhoneCalls />}
      {!DEMO && <WhatsNewCard />}
      {!DEMO && !inChat && !bare && <HelpButton phone={!wide} />}   {/* Help → a ticket for Adal (on where Adal opened the control tower) */}
      {/* (A phone has the More tab instead of the side menu.) */}
      {wide && <Sidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />}

      <div className="flex flex-col flex-1 min-w-0 h-[var(--app-h,100vh)] overflow-hidden relative">
        {DEMO && <Suspense fallback={null}><DemoBanner /></Suspense>}
        {!DEMO && <FollowerBanner />}
        {!DEMO && <UpdateBanner />}
        {!DEMO && <StandbyBanner />}
        {!DEMO && <SafetyAlerts />}
        {!DEMO && <PresencePing />}
        {wide && (
          <div className="shrink-0">
            <Navbar onMenuClick={() => setSidebarOpen(!sidebarOpen)} />
          </div>
        )}
        {!wide && !bare && <PhoneTopBar scroller={mainRef} />}
        <div className="relative flex flex-1 min-h-0">
          <main ref={mainRef} className="flex-1 min-w-0 overflow-y-auto overscroll-contain custom-scrollbar"
            style={!wide && !bare ? { paddingBottom: 'calc(58px + env(safe-area-inset-bottom))' } : undefined}>
            <div key={wide ? 'page' : pathname} className={`${inChat ? 'h-full' : wide ? 'px-3 py-4 sm:p-6' : 'px-4 pb-4 pt-1'} ${wide ? '' : motion}`}>
              {newer && <button type="button" data-newer="" onClick={() => { setNewer(false); setPageKey(k => k + 1) }} className="mb-2 rounded-full bg-teal-600 px-3 py-1 text-xs font-semibold text-white hover:bg-teal-700">Newer data came — show it</button>}
              <Outlet key={pageKey} />
            </div>
          </main>

          {padOpen && !inChat && wide && (
            <aside className="search-pad hidden md:flex w-72 shrink-0 flex-col p-3 pl-0 min-h-0">
              <ProfileSearchPad title="Profiles — search" autoFocusKey maxHeight="max-h-none" className="flex-1" />
            </aside>
          )}
        </div>

        {!wide && !bare && <PhoneTabBar />}
        {!inChat && <button
          type="button"
          onClick={togglePad}
          title={padOpen ? 'Hide the profiles search pad' : 'Show the profiles search pad (Ctrl+K)'}
          className="hidden md:flex absolute right-3 bottom-3 z-30 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-lg bg-teal-600 text-white hover:bg-teal-700"
        >
          ⌕ {padOpen ? 'ፍለጋውን ደብቅ' : 'ፕሮፋይሎችን ፈልግ'}
        </button>}
      </div>
    </div>
  )
}

// On a PC that follows another main PC, this PC's own page holds no current
// data: say so and point to the main PC.
function FollowerBanner() {
  const [main, setMain] = useState('')
  useEffect(() => {
    api.get('/health').then(r => setMain(r.data?.role === 'follower' ? r.data.main_url || '' : '')).catch(() => {})
  }, [])
  if (!main) return null
  return (
    <div translate="no" className="flex flex-wrap items-center gap-3 bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 px-4 py-2 text-sm">
      <span>This PC follows the main PC — the agency's data is there, not here.</span>
      <a href={main} className="rounded-md bg-amber-600 px-3 py-1 font-semibold text-white hover:bg-amber-700">Open the main PC</a>
      <a href="/settings" className="underline">Change in Settings</a>
    </div>
  )
}
