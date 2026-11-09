import { lazy, Suspense, useEffect, useState } from 'react'
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
  // A swipe from left to right (a phone): back — out of the open chat or
  // profile; with nothing to go back from, the sidebar. Right to left closes it.
  useEffect(() => {
    if (wide) return
    let start = null
    const down = (e) => {
      const t = e.touches?.[0]
      if (!t || e.touches.length > 1) { start = null; return }
      // Not from something that moves sideways itself (a slider, a list scrolling sideways, the mic).
      for (let el = e.target; el && el !== document.body; el = el.parentElement) {
        if (el.dataset?.noSwipe !== undefined || el.tagName === 'INPUT' && el.type === 'range') { start = null; return }
        if (el.scrollWidth > el.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollLeft > 0) { start = null; return }
      }
      start = { x: t.clientX, y: t.clientY, at: Date.now() }
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
        {!(bare && !wide) && <Navbar onMenuClick={() => setSidebarOpen(!sidebarOpen)} />}
        <div className="flex flex-1 min-h-0">
          <main className="flex-1 min-w-0 overflow-y-auto transition-colors duration-500 custom-scrollbar">
            <div className={inChat ? 'h-full' : 'px-3 py-4 sm:p-6'}>
              <Outlet />
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
