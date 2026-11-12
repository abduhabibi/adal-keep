import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Navbar from './Navbar'
import Sidebar from './Sidebar'
import ProfileSearchPad from '../ProfileSearchPad'
import { TutorTracker } from '../TutorCard'
import PhoneCalls from '../PhoneCalls'
import JoinRequests from '../JoinRequests'
import { PcAccessRequests } from '../PcAccessGate'
import AttentionBar from '../AttentionBar'
import useReadyChime from '../../hooks/useReadyChime'
import useNewVersion from '../../hooks/useNewVersion'
import api from '../../services/api'
import UpdateBanner from '../UpdateBanner'
import { swipeBack } from '../../lib/phoneApp'

const PAD_KEY = 'adal-search-pad'

// Public demo build only (src/demo): the run-tab window and the demo banner.
const DEMO = import.meta.env.VITE_DEMO === '1'
const DemoBanner = DEMO ? lazy(() => import('../../demo/DemoBrowser').then(m => ({ default: m.DemoBanner }))) : null
const DemoBrowser = DEMO ? lazy(() => import('../../demo/DemoBrowser')) : null

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
  // again with it — once per visit, never while something is being typed.
  const [pageKey, setPageKey] = useState(0)
  const visit = useRef({ path: '', at: 0, redone: false })
  useEffect(() => { api.adalVisit?.(); visit.current = { path: pathname, at: Date.now(), redone: false } }, [pathname])
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
  // On a phone the top bar goes away while scrolling down (more room) and
  // comes back on the way up, or at the top of the page.
  const mainRef = useRef(null)
  const [barHidden, setBarHidden] = useState(false)
  useEffect(() => {
    const el = mainRef.current
    if (!el || wide) { setBarHidden(false); return }
    let last = el.scrollTop
    const on = () => {
      const y = el.scrollTop, d = y - last
      if (y < 40) setBarHidden(false)
      else if (d > 8) setBarHidden(true)
      else if (d < -8) setBarHidden(false)
      if (Math.abs(d) > 8) last = y
    }
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [wide])
  useEffect(() => { setBarHidden(false) }, [pathname])
  // A swipe from left to right (a phone): back — out of the open chat or
  // profile; with nothing to go back from, the sidebar. Right to left closes
  // the sidebar, else goes forward again (what the back swipe left).
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
        if (!swipeBack()) setSidebarOpen(true)
      } else if (sidebarOpen) setSidebarOpen(false)
      else if (!s.sideways) history.forward()
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchend', up, { passive: true })
    return () => { window.removeEventListener('touchstart', down); window.removeEventListener('touchend', up) }
  }, [wide, sidebarOpen])
  const togglePad = () => setPadOpen(o => {
    try { localStorage.setItem(PAD_KEY, o ? 'closed' : 'open') } catch {}
    return !o
  })

  return (
    <div className="app-shell flex h-[var(--app-h,100vh)] overflow-hidden bg-slate-50 dark:bg-slate-900">
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
      <Sidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div className="flex flex-col flex-1 min-w-0 h-[var(--app-h,100vh)] overflow-hidden relative">
        {DEMO && <Suspense fallback={null}><DemoBanner /></Suspense>}
        {!DEMO && <FollowerBanner />}
        {!DEMO && <UpdateBanner />}
        {!(bare && !wide) && (
          <div className={`shrink-0 transition-[margin,opacity] duration-200 ${barHidden ? 'pointer-events-none opacity-0' : ''}`} style={barHidden ? { marginTop: '-5.5rem' } : undefined}>
            <Navbar onMenuClick={() => setSidebarOpen(!sidebarOpen)} />
          </div>
        )}
        <div className="flex flex-1 min-h-0">
          <main ref={mainRef} className="flex-1 min-w-0 overflow-y-auto transition-colors duration-500 custom-scrollbar">
            <div className={inChat ? 'h-full' : 'px-3 py-4 sm:p-6'}>
              <Outlet key={pageKey} />
            </div>
          </main>

          {padOpen && !inChat && wide && (
            <aside className="search-pad hidden md:flex w-72 shrink-0 flex-col p-3 pl-0 min-h-0">
              <ProfileSearchPad title="Profiles — search" autoFocusKey maxHeight="max-h-none" className="flex-1" />
            </aside>
          )}
        </div>

        {!inChat && <button
          type="button"
          onClick={togglePad}
          title={padOpen ? 'Hide the profiles search pad' : 'Show the profiles search pad (Ctrl+K)'}
          className="hidden md:flex absolute right-3 bottom-3 z-30 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-lg bg-teal-600 text-white hover:bg-teal-700"
        >
          ⌕ {padOpen ? 'Hide search' : 'Search profiles'}
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
