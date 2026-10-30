import { useState, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import ErrorBoundary from './components/shared/ErrorBoundary'
import { Toaster } from 'react-hot-toast'
import MainLayout from './components/layout/MainLayout'
const DashboardPage = lazy(() => fresh(() => import('./pages/DashboardPage')))
const ProfilesPage = lazy(() => fresh(() => import('./pages/ProfilesPage')))
const ProfileDetailPage = lazy(() => fresh(() => import('./pages/ProfileDetailPage')))
const ProfileFormPage = lazy(() => fresh(() => import('./pages/ProfileFormPage')))
const ChatPage = lazy(() => fresh(() => import('./pages/ChatPage')))
const TrashPage = lazy(() => fresh(() => import('./pages/TrashPage')))
const EmployeesPage = lazy(() => fresh(() => import('./pages/EmployeesPage')))
const BrokersPage = lazy(() => fresh(() => import('./pages/BrokersPage')))
const BrokerDetailPage = lazy(() => fresh(() => import('./pages/BrokerDetailPage')))
const ChecklistPage = lazy(() => fresh(() => import('./pages/ChecklistPage')))
const SettingsPage = lazy(() => fresh(() => import('./pages/SettingsPage')))
const NotificationsPage = lazy(() => fresh(() => import('./pages/NotificationsPage')))
import { FileCaptureProvider } from './context/FileCaptureContext'
import { AuthProvider, useAuth } from './context/AuthContext'
const TasksPage = lazy(() => fresh(() => import('./pages/TasksPage')))
import LockScreen from './components/LockScreen'
import IntroWizard from './pages/IntroWizard'
const CVsPage = lazy(() => fresh(() => import('./pages/CVsPage')))
const CVNewPage = lazy(() => fresh(() => import('./pages/CVNewPage')))
const CVTemplatesPage = lazy(() => fresh(() => import('./pages/CVTemplatesPage')))
const CVTemplateEditPage = lazy(() => fresh(() => import('./pages/CVTemplateEditPage')))
const CVTemplateDesignPage = lazy(() => fresh(() => import('./pages/CVTemplateDesignPage')))

// After an update the old page files are gone: a page that cannot load
// reloads Adal Keep once (then the new files are used).
function fresh(load) {
  return load().then((m) => { try { sessionStorage.removeItem('adal-reloaded') } catch {} return m }).catch((e) => {
    let again = false
    try { again = !sessionStorage.getItem('adal-reloaded'); sessionStorage.setItem('adal-reloaded', '1') } catch {}
    if (again) { location.reload(); return new Promise(() => {}) }
    throw e
  })
}

// Each page is loaded when it is first opened: a low-end PC starts faster.
// Every page in its own catcher: a fault shows a notice, never a blank screen.
function Guarded({ children }) { const loc = useLocation(); return <ErrorBoundary resetKey={loc.pathname}>{children}</ErrorBoundary> }
const page = (P) => <Guarded><Suspense fallback={<div className="p-6 text-sm text-slate-400">…</div>}><P /></Suspense></Guarded>

const toaster = (
  <Toaster
    position="top-right"
    toastOptions={{
      className: 'text-sm font-medium',
      style: {
        borderRadius: '12px',
        border: '1px solid #e2e8f0',
        boxShadow: '0 10px 30px -12px rgba(15,28,26,0.25)'
      }
    }}
  />
)

function TrialBanner({ days }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="lock-button fixed top-0 left-0 right-0 z-[9999] !rounded-none !py-2 !text-sm">
        Your free trial ends in {days} day{days === 1 ? '' : 's'} — unlock Adal Keep now →
      </button>
      {open && <LockScreen onClose={() => setOpen(false)} />}
    </>
  )
}

function Shell() {
  const { state, subscription, refresh } = useAuth()

  if (state === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900">
        <div className="w-14 h-14 rounded-2xl overflow-hidden shadow-lg animate-pulse"><img src="/adal-logo.png" alt="Adal" className="h-full w-full object-cover" draggable={false} /></div>
      </div>
    )
  }

  if (state === 'error' && window.__ADAL_CLOUD === true) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-900 gap-4 p-6 text-center">
        <div className="text-5xl">☁️</div>
        <h1 className="text-xl font-bold text-slate-800 dark:text-white">The online copy is not ready</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">
          The phone has no internet, or the office PC has not copied the data online yet
          (it does so every minute while it is on with internet).
        </p>
        <button onClick={refresh} className="px-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl">Retry →</button>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-900 gap-4 p-6 text-center">
        <div className="text-5xl">🔌</div>
        <h1 className="text-xl font-bold text-slate-800 dark:text-white">Backend not reachable</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md">
          Start the backend in a terminal, then click Retry.<br />
          <code className="text-xs bg-slate-200 dark:bg-slate-800 px-2 py-1 rounded mt-2 inline-block">
            cd adal-keep-backend && npm run dev
          </code>
        </p>
        <button onClick={refresh} className="px-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors">
          Retry →
        </button>
      </div>
    )
  }

  // After the free trial nothing else is shown until this PC is unlocked.
  if (subscription?.mode === 'locked') return <>{toaster}<LockScreen /></>
  if (state === 'setup') return <>{toaster}<IntroWizard /></>

  return (
    <FileCaptureProvider>
      <BrowserRouter>
        {toaster}
        {subscription?.mode === 'trial' && subscription.daysLeft <= 3 && <TrialBanner days={subscription.daysLeft} />}
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={page(DashboardPage)} />
            <Route path="profiles" element={page(ProfilesPage)} />
            <Route path="chat" element={page(ChatPage)} />
            <Route path="trash" element={page(TrashPage)} />
            <Route path="profiles/new" element={page(ProfileFormPage)} />
            <Route path="profiles/:id/edit" element={page(ProfileFormPage)} />
            <Route path="profiles/:id" element={page(ProfileDetailPage)} />
            <Route path="employees" element={page(EmployeesPage)} />
            <Route path="brokers" element={page(BrokersPage)} />
            <Route path="brokers/:id" element={page(BrokerDetailPage)} />
            <Route path="checklist" element={page(ChecklistPage)} />
            <Route path="notifications" element={page(NotificationsPage)} />
            <Route path="tasks" element={page(TasksPage)} />
            <Route path="cvs" element={page(CVsPage)} />
            <Route path="cvs/new" element={page(CVNewPage)} />
            <Route path="cvs/templates" element={page(CVTemplatesPage)} />
            <Route path="cvs/templates/new" element={page(CVTemplateEditPage)} />
            <Route path="cvs/templates/design" element={page(CVTemplateDesignPage)} />
            <Route path="cvs/templates/:id/edit" element={page(CVTemplateEditPage)} />
            <Route path="settings" element={page(SettingsPage)} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </FileCaptureProvider>
  )
}

function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}

export default App
