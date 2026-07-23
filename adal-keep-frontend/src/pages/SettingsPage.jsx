import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Card from '../components/shared/Card'
import Input from '../components/shared/Input'
import Button from '../components/shared/Button'
import Spinner from '../components/shared/Spinner'

export default function SettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState({ host: '0.0.0.0', port: '4000' })
  
  // New State for Appearance & Wallpaper
  const [darkMode, setDarkMode] = useState(false)
  const [currentWallpaper, setCurrentWallpaper] = useState(null)
  const [uploadingWallpaper, setUploadingWallpaper] = useState(false)

  // State for System Update
  const [updating, setUpdating] = useState(false)

  useEffect(() => {
    loadSettings()
    loadWallpaper()
    // Initialize Dark Mode from localStorage
    const isDark = localStorage.getItem('adal_theme') === 'dark'
    setDarkMode(isDark)
    if (isDark) document.documentElement.classList.add('dark')
  }, [])

  const loadSettings = async () => {
    try {
      const res = await api.get('/settings')
      setSettings({ host: res.data.host, port: res.data.port })
    } catch {
      toast.error('Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  const loadWallpaper = async () => {
    try {
      // Add a timestamp to prevent caching
      const res = await api.get(`/wallpaper?t=${Date.now()}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      setCurrentWallpaper(url)
    } catch {
      setCurrentWallpaper(null)
    }
  }

  const handleSaveNetwork = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api.post('/settings', settings)
      toast.success('Network settings saved! Restart backend to apply.')
    } catch {
      toast.error('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  // --- Dark Mode Toggle ---
  const toggleDarkMode = () => {
    const newDarkMode = !darkMode
    setDarkMode(newDarkMode)
    if (newDarkMode) {
      document.documentElement.classList.add('dark')
      localStorage.setItem('adal_theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('adal_theme', 'light')
    }
  }

  // --- Wallpaper Upload ---
  const handleWallpaperUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return

    if (file.size > 5 * 1024 * 1024) {
      toast.error('File is too large. Max 5MB.')
      return
    }

    setUploadingWallpaper(true)
    const formData = new FormData()
    formData.append('wallpaper', file)

    try {
      await api.post('/settings/wallpaper', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })
      toast.success('Wallpaper updated for all users!')
      loadWallpaper() // Refresh preview
      // Dispatch event to update background immediately without reload
      window.dispatchEvent(new Event('wallpaper-changed'))
    } catch {
      toast.error('Failed to upload wallpaper')
    } finally {
      setUploadingWallpaper(false)
    }
  }

  const handleRemoveWallpaper = async () => {
    if (!confirm('Remove the custom wallpaper?')) return
    try {
      await api.delete('/settings/wallpaper')
      setCurrentWallpaper(null)
      toast.success('Wallpaper removed')
      window.dispatchEvent(new Event('wallpaper-changed'))
    } catch {
      toast.error('Failed to remove wallpaper')
    }
  }

  // --- System Update Handler ---
  const handleCheckUpdate = async () => {
    setUpdating(true)
    try {
      const res = await api.post('/system/update')
      toast.success(res.data.message)
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to check for updates')
    } finally {
      setUpdating(false)
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  return (
    <div className="animate-fade-up max-w-4xl mx-auto space-y-6 pb-12">
      <PageHeader 
        title="System Settings" 
        subtitle="Configure network access, appearance, and system preferences" 
      />

      {/* 1. Appearance Settings (Dark Mode) */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🎨</span> Appearance
        </h2>
        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
          <div>
            <h3 className="font-medium text-slate-900 dark:text-white">Dark Mode</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Toggle between light and dark themes globally</p>
          </div>
          <button 
            onClick={toggleDarkMode}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-2 ${
              darkMode ? 'bg-teal-600' : 'bg-slate-300'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              darkMode ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </Card>

      {/* 2. Wallpaper Settings */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🖼️</span> Background Wallpaper
        </h2>
        
        <div className="grid gap-6 md:grid-cols-2">
          {/* Preview */}
          <div className="aspect-video w-full rounded-lg border-2 border-dashed border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900 overflow-hidden flex items-center justify-center relative">
            {currentWallpaper ? (
              <img src={currentWallpaper} alt="Wallpaper Preview" className="w-full h-full object-cover" />
            ) : (
              <div className="text-center text-slate-400">
                <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                <p className="text-sm">No custom wallpaper</p>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex flex-col justify-center gap-3">
            <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <svg className="w-8 h-8 mb-2 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {uploadingWallpaper ? 'Uploading...' : 'Click to upload wallpaper'}
                </p>
                <p className="text-xs text-slate-400">JPG, PNG up to 5MB</p>
              </div>
              <input 
                type="file" 
                className="hidden" 
                accept="image/jpeg, image/png"
                onChange={handleWallpaperUpload}
                disabled={uploadingWallpaper}
              />
            </label>
            
            {currentWallpaper && (
              <button 
                onClick={handleRemoveWallpaper}
                className="w-full px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
              >
                Remove Wallpaper
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* 3. Network Settings */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🌐</span> Network & Access
        </h2>
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 mb-6">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            <strong>Note:</strong> To isolate this app to a specific Wi-Fi, connect your PC to that Wi-Fi in OS settings, find its IP (e.g., 192.168.8.10), and enter it below. A server restart is required.
          </p>
        </div>
        <form onSubmit={handleSaveNetwork} className="grid gap-4 sm:grid-cols-2">
          <Input 
            label="Server Host IP" 
            value={settings.host} 
            onChange={(e) => setSettings({...settings, host: e.target.value})}
            placeholder="0.0.0.0 (All networks) or 192.168.x.x"
          />
          <Input 
            label="Server Port" 
            value={settings.port} 
            onChange={(e) => setSettings({...settings, port: e.target.value})}
            placeholder="4000"
          />
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" isLoading={saving}>Save Network Settings</Button>
          </div>
        </form>
      </Card>

      {/* 4. System Updates */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🔄</span> System Updates
        </h2>
        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
          <div>
            <h3 className="font-medium text-slate-900 dark:text-white">Check for Updates</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Fetch and apply the latest changes from the repository</p>
          </div>
          <Button onClick={handleCheckUpdate} isLoading={updating}>
            Check for Updates
          </Button>
        </div>
      </Card>
    </div>
  )
}