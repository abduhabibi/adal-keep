import { useState, useEffect, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import ErrorBoundary from './components/shared/ErrorBoundary'
import { Toaster } from 'react-hot-toast'
import MainLayout from './components/layout/MainLayout'
import { MorePage } from './components/layout/PhoneChrome'
const DashboardPage = lazy(() => fresh(() => import('./pages/DashboardPage')))
const ProfilesPage = lazy(() => fresh(() => import('./pages/ProfilesPage')))
const ProfileDetailPage = lazy(() => fresh(() => import('./pages/ProfileDetailPage')))
const ProfileFormPage = lazy(() => fresh(() => import('./pages/ProfileFormPage')))
const ChatPage = lazy(() => fresh(() => import('./pages/ChatPage')))
const RunHistoryPage = lazy(() => fresh(() => import('./pages/RunHistoryPage')))
const BillingPage = lazy(() => fresh(() => import('./pages/BillingPage')))
const TrashPage = lazy(() => fresh(() => import('./pages/TrashPage')))
const EmployeesPage = lazy(() => fresh(() => import('./pages/EmployeesPage')))
const BrokersPage = lazy(() => fresh(() => import('./pages/BrokersPage')))
const BrokerDetailPage = lazy(() => fresh(() => import('./pages/BrokerDetailPage')))
const ChecklistPage = lazy(() => fresh(() => import('./pages/ChecklistPage')))
const OfficePage = lazy(() => fresh(() => import('./pages/OfficePage')))
const SettingsPage = lazy(() => fresh(() => import('./pages/SettingsPage')))
const WhatsAppLinkPage = lazy(() => fresh(() => import('./pages/WhatsAppLinkPage')))
const NotificationsPage = lazy(() => fresh(() => import('./pages/NotificationsPage')))
import { FileCaptureProvider } from './context/FileCaptureContext'
import { AuthProvider, useAuth } from './context/AuthContext'
const TasksPage = lazy(() => fresh(() => import('./pages/TasksPage')))
// The lock screen and the first-start wizard are seen rarely: their code is
// fetched only when one is shown (a smaller first download on every start).
const LockScreen = lazy(() => fresh(() => import('./components/LockScreen')))
import PcAccessGate, { SuspendedScreen } from './components/PcAccessGate'
import api, { joinInfo } from './services/api'
import { reloadOnce } from './lib/reloadGuard'
const IntroWizard = lazy(() => fresh(() => import('./pages/SignUpAgency')))   // first-run sign-up (flag), then the first-start wizard
const SignupBanner = lazy(() => fresh(() => import('./pages/SignUpAgency').then(m => ({ default: m.SignupBanner }))))
const JoinAgency = lazy(() => fresh(() => import('./pages/JoinAgency')))
const CVsPage = lazy(() => fresh(() => import('./pages/CVsPage')))
const CVNewPage = lazy(() => fresh(() => import('./pages/CVNewPage')))
const CVTemplatesPage = lazy(() => fresh(() => import('./pages/CVTemplatesPage')))
const CVTemplateEditPage = lazy(() => fresh(() => import('./pages/CVTemplateEditPage')))
const CVTemplateDesignPage = lazy(() => fresh(() => import('./pages/CVTemplateDesignPage')))

// Every page's code, fetched once while nothing else is happening: opening a
// tab never waits for its code (the browser keeps those files for good).
if (typeof window !== 'undefined' && import.meta.env.VITE_DEMO !== '1') {
  const warm = () => [() => import('./pages/DashboardPage'), () => import('./pages/ProfilesPage'), () => import('./pages/ProfileDetailPage'), () => import('./pages/ProfileFormPage'), () => import('./pages/ChatPage'), () => import('./pages/TrashPage'), () => import('./pages/EmployeesPage'), () => import('./pages/BrokersPage'), () => import('./pages/BrokerDetailPage'), () => import('./pages/ChecklistPage'), () => import('./pages/SettingsPage'), () => import('./pages/NotificationsPage'), () => import('./pages/TasksPage'), () => import('./pages/CVsPage'), () => import('./pages/CVNewPage'), () => import('./pages/CVTemplatesPage'), () => import('./pages/CVTemplateEditPage'), () => import('./pages/CVTemplateDesignPage')]
    .reduce((p, load) => p.then(() => new Promise(r => (window.requestIdleCallback || setTimeout)(() => load().catch(() => {}).finally(r)))), Promise.resolve())
  window.addEventListener('load', () => setTimeout(warm, 2500), { once: true })
}

// After an update the old page files are gone: a page that cannot load reloads
// Adal Keep once (then the new files are used). Never again within a minute: the
// "once" was forgotten as soon as any other page loaded (and every page is warmed
// right after the start), so a page whose file stayed missing reloaded forever,
// blank in between. Now the page's catcher shows the error with a Reload button.
function fresh(load) {
  return load().catch((e) => {
    if (reloadOnce(`a page's file did not load: ${e?.message || e}`)) return new Promise(() => {})
    throw e
  })
}

// Each page is loaded when it is first opened: a low-end PC starts faster.
// Every page in its own catcher: a fault shows a notice, never a blank screen.
function Guarded({ children }) { const loc = useLocation(); return <ErrorBoundary resetKey={loc.pathname}>{children}</ErrorBoundary> }
const page = (P) => <Guarded><Suspense fallback={<div className="p-6 text-sm text-slate-400">…</div>}><P /></Suspense></Guarded>

const toaster = (
  <Toaster
    position="top-center"
    containerStyle={{ top: 64 }}
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

function TrialBanner({ days, renew }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="lock-button fixed top-0 left-0 right-0 z-[9999] !rounded-none !py-2 !text-sm">
        {renew ? `Your 6 paid months end in ${days} day${days === 1 ? '' : 's'} — renew now →`
          : `Your free trial ends in ${days} day${days === 1 ? '' : 's'} — unlock Adal Keep now →`}
      </button>
      {open && <Suspense fallback={null}><LockScreen onClose={() => setOpen(false)} /></Suspense>}
    </>
  )
}

// Opened from another computer: the main PC must have said "Yes" to it.
const GATED = !(import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1' || import.meta.env.VITE_DEMO === '1')

function Shell() {
  const { state, subscription, refresh } = useAuth()
  const [pcGate, setPcGate] = useState(false)
  const [suspended, setSuspended] = useState(false)
  useEffect(() => {
    const on = () => setSuspended(true)
    window.addEventListener('adal-suspended', on)
    return () => window.removeEventListener('adal-suspended', on)
  }, [])
  useEffect(() => {
    if (!GATED) return
    api.get('/pc-access/status').then(r => {
      if (r.data?.state === 'suspended') setSuspended(true)
      else if (r.data?.state && r.data.state !== 'approved') setPcGate(true)
      // Let in by the key this window keeps, the cookie gone (a cleared browser): the cookie again, for the documents.
      else if (!r.data?.here && joinInfo().number) api.post('/pc-access/resume').catch(() => {})
    }).catch(() => {})
    const on = () => setPcGate(true)
    window.addEventListener('adal-pc-access', on)
    return () => window.removeEventListener('adal-pc-access', on)
  }, [])
  if (suspended) return <>{toaster}<SuspendedScreen /></>
  if (pcGate) return <>{toaster}<PcAccessGate /></>

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
  if (subscription?.mode === 'locked') return <>{toaster}<Suspense fallback={null}><LockScreen /></Suspense></>
  // A Companion install joins an agency (its own full copy) instead of starting one.
  if (state === 'join') return <>{toaster}<Suspense fallback={null}><JoinAgency /></Suspense></>
  if (state === 'setup') return <>{toaster}<Suspense fallback={null}><IntroWizard /></Suspense></>

  return (
    <FileCaptureProvider>
      <BrowserRouter>
        {toaster}
        <Suspense fallback={null}><SignupBanner /></Suspense>
        {subscription?.mode === 'trial' && subscription.daysLeft <= 3 && <TrialBanner days={subscription.daysLeft} />}
        {subscription?.mode === 'active' && subscription.paidUntil && !subscription.forGood && subscription.paidDaysLeft <= 7 && <TrialBanner renew days={subscription.paidDaysLeft} />}
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={page(DashboardPage)} />
            <Route path="profiles" element={page(ProfilesPage)} />
            <Route path="chat" element={page(ChatPage)} />
            <Route path="trash" element={page(TrashPage)} />
            <Route path="billing" element={page(BillingPage)} />
            <Route path="robot-history" element={page(RunHistoryPage)} />
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
            <Route path="cvs/templates/new" element={<Navigate to="/cvs/templates/design" replace />} />
            <Route path="cvs/templates/design" element={page(CVTemplateDesignPage)} />
            <Route path="cvs/templates/:id/edit" element={page(CVTemplateEditPage)} />
            <Route path="office" element={page(OfficePage)} />
            <Route path="settings" element={page(SettingsPage)} />
            <Route path="whatsapp" element={page(WhatsAppLinkPage)} />
            {/* The phone's More tab: every other page as one list (layout/PhoneChrome.jsx). */}
            <Route path="more" element={<Guarded><MorePage /></Guarded>} />
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
