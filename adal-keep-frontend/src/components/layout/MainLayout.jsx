import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import Navbar from './Navbar'
import Sidebar from './Sidebar'
import ProfileSearchPad from '../ProfileSearchPad'

const PAD_KEY = 'adal-search-pad'

function readPad() {
  try { return localStorage.getItem(PAD_KEY) !== 'closed' } catch { return true }
}

export default function MainLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // The profiles search pad is on every page (docked right); it can be folded away.
  const [padOpen, setPadOpen] = useState(readPad)
  const togglePad = () => setPadOpen(o => {
    try { localStorage.setItem(PAD_KEY, o ? 'closed' : 'open') } catch {}
    return !o
  })

  return (
    <div className="app-shell flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-900">
      {/* Moving gradients — only painted in the Gradient theme */}
      <div className="gradient-backdrop" aria-hidden="true">
        <span /><span /><span /><span />
      </div>

      <Sidebar
        isOpen={sidebarOpen}
        onToggle={() => setSidebarOpen(!sidebarOpen)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      <div className="flex flex-col flex-1 min-w-0 h-screen overflow-hidden relative">
        <Navbar onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <div className="flex flex-1 min-h-0">
          <main className="flex-1 min-w-0 overflow-y-auto transition-colors duration-500 custom-scrollbar">
            <div className="p-6">
              <Outlet />
            </div>
          </main>

          {padOpen && (
            <aside className="hidden md:flex w-72 shrink-0 flex-col p-3 pl-0 min-h-0">
              <ProfileSearchPad title="Profiles — search" autoFocusKey maxHeight="max-h-none" className="flex-1" />
            </aside>
          )}
        </div>

        <button
          type="button"
          onClick={togglePad}
          title={padOpen ? 'Hide the profiles search pad' : 'Show the profiles search pad (Ctrl+K)'}
          className="hidden md:flex absolute right-3 bottom-3 z-30 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-lg bg-teal-600 text-white hover:bg-teal-700"
        >
          ⌕ {padOpen ? 'Hide search' : 'Search profiles'}
        </button>
      </div>
    </div>
  )
}
