import { useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import MainLayout from './components/layout/MainLayout'
import DashboardPage from './pages/DashboardPage'
import ProfilesPage from './pages/ProfilesPage'
import ProfileDetailPage from './pages/ProfileDetailPage'
import ProfileFormPage from './pages/ProfileFormPage'
import EmployeesPage from './pages/EmployeesPage'
import BrokersPage from './pages/BrokersPage'
import BrokerDetailPage from './pages/BrokerDetailPage'
import ChecklistPage from './pages/ChecklistPage'
import SettingsPage from './pages/SettingsPage'
import NotificationsPage from './pages/NotificationsPage'
import { FileCaptureProvider } from './context/FileCaptureContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import TasksPage from './pages/TasksPage'
import LockScreen from './components/LockScreen'
import IntroWizard from './pages/IntroWizard'
import CVsPage from './pages/CVsPage'
import CVNewPage from './pages/CVNewPage'
import CVTemplatesPage from './pages/CVTemplatesPage'
import CVTemplateEditPage from './pages/CVTemplateEditPage'

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
        <div className="w-14 h-14 rounded-2xl bg-teal-600 text-white flex items-center justify-center text-2xl font-bold animate-pulse">አ</div>
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
            <Route index element={<DashboardPage />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="profiles/new" element={<ProfileFormPage />} />
            <Route path="profiles/:id/edit" element={<ProfileFormPage />} />
            <Route path="profiles/:id" element={<ProfileDetailPage />} />
            <Route path="employees" element={<EmployeesPage />} />
            <Route path="brokers" element={<BrokersPage />} />
            <Route path="brokers/:id" element={<BrokerDetailPage />} />
            <Route path="checklist" element={<ChecklistPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="cvs" element={<CVsPage />} />
            <Route path="cvs/new" element={<CVNewPage />} />
            <Route path="cvs/templates" element={<CVTemplatesPage />} />
            <Route path="cvs/templates/new" element={<CVTemplateEditPage />} />
            <Route path="cvs/templates/:id/edit" element={<CVTemplateEditPage />} />
            <Route path="settings" element={<SettingsPage />} />
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
