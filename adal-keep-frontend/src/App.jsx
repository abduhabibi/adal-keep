import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { useState } from 'react'
import MainLayout from './components/layout/MainLayout'
import DashboardPage from './pages/DashboardPage'
import ProfilesPage from './pages/ProfilesPage'
import ProfileDetailPage from './pages/ProfileDetailPage'
import ProfileFormPage from './pages/ProfileFormPage'
import BrokersPage from './pages/BrokersPage'
import BrokerDetailPage from './pages/BrokerDetailPage'
import ChecklistPage from './pages/ChecklistPage'
import SettingsPage from './pages/SettingsPage'
import FileCaptureContext from './context/FileCaptureContext'

function App() {
  const [capturedFiles, setCapturedFiles] = useState([])

  return (
    <FileCaptureContext.Provider value={{ capturedFiles, setCapturedFiles }}>
      <BrowserRouter>
        <Toaster
          position="top-right"
          toastOptions={{
            className: 'text-sm font-medium',
            style: {
              borderRadius: '12px',
              border: '1px solid #e2e8f0',
              boxShadow: '0 10px 30px -12px rgba(15,28,26,0.25)',
            },
          }}
        />
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="profiles" element={<ProfilesPage />} />
            <Route path="profiles/new" element={<ProfileFormPage />} />
            <Route path="profiles/:id/edit" element={<ProfileFormPage />} />
            <Route path="profiles/:id" element={<ProfileDetailPage />} />
            <Route path="brokers" element={<BrokersPage />} />
            <Route path="brokers/:id" element={<BrokerDetailPage />} />
            <Route path="checklist" element={<ChecklistPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </FileCaptureContext.Provider>
  )
}

export default App