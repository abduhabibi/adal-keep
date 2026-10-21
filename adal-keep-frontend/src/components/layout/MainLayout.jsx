import { lazy, Suspense, useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import Navbar from './Navbar'
import Sidebar from './Sidebar'
import ProfileSearchPad from '../ProfileSearchPad'
import { TutorTracker } from '../TutorCard'
import useReadyChime from '../../hooks/useReadyChime'
import useNewVersion from '../../hooks/useNewVersion'

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
  const togglePad = () => setPadOpen(o => {
    try { localStorage.setItem(PAD_KEY, o ? 'closed' : 'open') } catch {}
    return !o
  })

  return (
    <div className="app-shell flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-900">
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
      <Sidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div className="flex flex-col flex-1 min-w-0 h-screen overflow-hidden relative">
        {DEMO && <Suspense fallback={null}><DemoBanner /></Suspense>}
        <Navbar onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <div className="flex flex-1 min-h-0">
          <main className="flex-1 min-w-0 overflow-y-auto transition-colors duration-500 custom-scrollbar">
            <div className={inChat ? 'h-full' : 'p-6'}>
              <Outlet />
            </div>
          </main>

          {padOpen && !inChat && (
            <aside className="hidden md:flex w-72 shrink-0 flex-col p-3 pl-0 min-h-0">
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
