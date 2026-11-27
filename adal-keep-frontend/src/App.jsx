import { useState, useEffect, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import ErrorBoundary from './components/shared/ErrorBoundary'
import { Toaster } from 'react-hot-toast'
import MainLayout from './components/layout/MainLayout'
import { lazyPage, warmPages, FirstPage, PageComing } from './lib/pageCode'
import { off } from './lib/offSwitch'
import { tellChanged } from './lib/changes'
import { MorePage } from './components/layout/PhoneChrome'
import OneTab from './components/shared/OneTab'
const DashboardPage = lazyPage(() => import('./pages/DashboardPage'))
const ProfilesPage = lazyPage(() => import('./pages/ProfilesPage'))
const ProfileDetailPage = lazyPage(() => import('./pages/ProfileDetailPage'))
const ProfileFormPage = lazyPage(() => import('./pages/ProfileFormPage'))
const ChatPage = lazyPage(() => import('./pages/ChatPage'))
const RunHistoryPage = lazyPage(() => import('./pages/RunHistoryPage'))
const BillingPage = lazyPage(() => import('./pages/BillingPage'))
const TrashPage = lazyPage(() => import('./pages/TrashPage'))
const EmployeesPage = lazyPage(() => import('./pages/EmployeesPage'))
const BrokersPage = lazyPage(() => import('./pages/BrokersPage'))
const BrokerDetailPage = lazyPage(() => import('./pages/BrokerDetailPage'))
const ChecklistPage = lazyPage(() => import('./pages/ChecklistPage'))
const OfficePage = lazyPage(() => import('./pages/OfficePage'))
const SettingsPage = lazyPage(() => import('./pages/SettingsPage'))
const WhatsAppSentPage = lazyPage(() => import('./pages/WhatsAppSentPage'))
const WhatsAppLinkPage = lazyPage(() => import('./pages/WhatsAppLinkPage'))
const NotificationsPage = lazyPage(() => import('./pages/NotificationsPage'))
import { FileCaptureProvider } from './context/FileCaptureContext'
import { ScanHost } from './components/ScanButton'
import { AuthProvider, useAuth } from './context/AuthContext'
const TasksPage = lazyPage(() => import('./pages/TasksPage'))
// The lock screen and the first-start wizard are seen rarely: their code is
// fetched only when one is shown (a smaller first download on every start).
const LockScreen = lazyPage(() => import('./components/LockScreen'))
import PcAccessGate, { SuspendedScreen } from './components/PcAccessGate'
import api, { joinInfo } from './services/api'
const IntroWizard = lazyPage(() => import('./pages/SignUpAgency'))   // first-run sign-up (flag), then the first-start wizard
const SignupBanner = lazyPage(() => import('./pages/SignUpAgency'), m => m.SignupBanner)
const JoinAgency = lazyPage(() => import('./pages/JoinAgency'))
const CVsPage = lazyPage(() => import('./pages/CVsPage'))
const CVNewPage = lazyPage(() => import('./pages/CVNewPage'))
const CVTemplatesPage = lazyPage(() => import('./pages/CVTemplatesPage'))
const CVTemplateEditPage = lazyPage(() => import('./pages/CVTemplateEditPage'))
const CVTemplateDesignPage = lazyPage(() => import('./pages/CVTemplateDesignPage'))

// Every page's code, fetched once while nothing else is happening, the pages used most
// first: opening a tab never waits for its code (the browser keeps those files for good).
if (typeof window !== 'undefined' && import.meta.env.VITE_DEMO !== '1') {
  const warm = () => warmPages([ProfilesPage, CVsPage, ProfileDetailPage, DashboardPage, CVNewPage, ProfileFormPage, TasksPage, BrokersPage, BrokerDetailPage, ChecklistPage, ChatPage, SettingsPage, EmployeesPage, NotificationsPage, WhatsAppSentPage, TrashPage, CVTemplatesPage, CVTemplateEditPage, CVTemplateDesignPage])
  const start = () => setTimeout(warm, 600)
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true })
}

// Each page is loaded when it is first opened: a low-end PC starts faster.
// Every page in its own catcher: a fault shows a notice, never a blank screen.
function Guarded({ children }) { const loc = useLocation(); return <ErrorBoundary resetKey={loc.pathname}>{children}</ErrorBoundary> }
const page = (P) => <Guarded><FirstPage><P /></FirstPage></Guarded>

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
          : `Your free trial ends in ${days} day${days === 1 ? '' : 's'} — how to pay →`}
      </button>
      {open && <Suspense fallback={null}><LockScreen onClose={() => setOpen(false)} /></Suspense>}
    </>
  )
}

// Opened from another computer: the main PC must have said "Yes" to it.
const GATED = !(import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1' || import.meta.env.VITE_DEMO === '1')

function Shell() {
  const { state, refresh, forgetOpen } = useAuth()
  const [pcGate, setPcGate] = useState(false)
  const [suspended, setSuspended] = useState(false)
  useEffect(() => {
    const on = () => { forgetOpen(); import('./lib/pics').then(p => p.clearPics()).catch(() => {}); setSuspended(true) }
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
  // In again: the pages stay as they are and ask again for what they show.
  const inAgain = () => { setPcGate(false); if (state !== 'ready') refresh(); tellChanged(['*']) }
  if (suspended) return <>{toaster}<SuspendedScreen /></>
  return <>{pcGate && <PcAccessGate onIn={inAgain} onOut={forgetOpen} />}<Inside /></>
}

function Inside() {
  const { state, subscription, refresh, quiet } = useAuth()
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

  // Locked by Adal (Adal Keep Admin): nothing else is shown until Adal unlocks it. Nothing else locks.
  if (subscription?.mode === 'locked') return <>{toaster}<Suspense fallback={null}><LockScreen /></Suspense></>
  // A Companion install joins an agency (its own full copy) instead of starting one.
  if (state === 'join') return <>{toaster}<Suspense fallback={null}><JoinAgency /></Suspense></>
  if (state === 'setup') return <>{toaster}<Suspense fallback={null}><IntroWizard /></Suspense></>

  return (
    <FileCaptureProvider>
      {/* A page is shown when it is ready: until then the one before stays (lib/pageCode.jsx). */}
      <BrowserRouter future={{ v7_startTransition: !off('pages') }}>
        <PageComing />
        {quiet && <div role="status" data-pc-quiet="" className="fixed bottom-3 left-1/2 z-[9990] flex -translate-x-1/2 items-center gap-3 rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg">The PC is not answering — this is what was last seen here.<button type="button" onClick={refresh} className="rounded-full bg-teal-600 px-3 py-1">Try again</button></div>}
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
            <Route path="whatsapp-sent" element={page(WhatsAppSentPage)} />
            <Route path="whatsapp" element={page(WhatsAppLinkPage)} />
            {/* The phone's More tab: every other page as one list (layout/PhoneChrome.jsx). */}
            <Route path="more" element={<Guarded><MorePage /></Guarded>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <ScanHost />
      </BrowserRouter>
    </FileCaptureProvider>
  )
}

function App() {
  return (
    <AuthProvider>
      <OneTab />
      <Shell />
    </AuthProvider>
  )
}

export default App
