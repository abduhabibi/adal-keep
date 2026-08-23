import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import PageHeader from '../components/shared/PageHeader'
import Card from '../components/shared/Card'
import Button from '../components/shared/Button'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'

export default function SettingsPage() {
  const { subscription, refresh, user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [darkMode, setDarkMode] = useState(false)
  const [currentWallpaper, setCurrentWallpaper] = useState(null)
  const [uploadingWallpaper, setUploadingWallpaper] = useState(false)
  const [networkIp, setNetworkIp] = useState('10.134.230.82')
  const [port] = useState('3000')
  const [updating, setUpdating] = useState(false)
  const [accessCode, setAccessCode] = useState('')
  const [unlocking, setUnlocking] = useState(false)

  useEffect(() => {
    loadWallpaper()
    const savedTheme = localStorage.getItem('adal-theme')
    const isDark = savedTheme === 'dark' || document.documentElement.getAttribute('data-theme') === 'dark'
    setDarkMode(isDark)
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      setNetworkIp(window.location.hostname)
    }
    setLoading(false)
  }, [])

  const loadWallpaper = async () => {
    try {
      const res = await api.get(`/wallpaper?t=${Date.now()}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      setCurrentWallpaper(url)
    } catch {
      setCurrentWallpaper(null)
    }
  }

  const toggleDarkMode = () => {
    const newDarkMode = !darkMode
    setDarkMode(newDarkMode)
    const newTheme = newDarkMode ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', newTheme)
    if (newDarkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem('adal-theme', newTheme)
  }

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
      toast.success('Wallpaper updated!')
      loadWallpaper()
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

  const handleቅዳ = (text) => {
    navigator.clipboard.writeText(text)
    toast.success('Link copied to clipboard!')
  }

  const handleCheckUpdate = async () => {
    setUpdating(true)
    try {
      const res = await api.post('/system/update')
      toast.success(res.data?.message || 'System is up to date!')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to check for updates')
    } finally {
      setUpdating(false)
    }
  }

  const handleUnlock = async (e) => {
    e.preventDefault()
    if (!accessCode.trim()) {
      toast.error('Please enter an access code')
      return
    }
    setUnlocking(true)
    try {
      await api.post('/subscription/unlock', { code: accessCode })
      await refresh()
      toast.success('Access granted! Timer restarted.')
      setAccessCode('')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invalid access code')
    } finally {
      setUnlocking(false)
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  const localUrl = `http://localhost:${port}`
  const networkUrl = `http://${networkIp}:${port}`
  const daysLeft = subscription?.daysLeft
  const isሙከራ = subscription?.mode === 'trial'
  const isReadOnly = subscription?.mode === 'read_only'
  const isንቁ = subscription?.mode === 'active'

  return (
    <div className="animate-fade-up max-w-4xl mx-auto space-y-6 pb-12">
      <PageHeader 
        title="የስርዓት ቅንብሮች" 
        subtitle="መልክ፣ አውታረ መረብ፣ ምዝገባ እና የስርዓት ማሻሻያዎችን ያስተዳድሩ" 
      />

      {/* 1. ምዝገባ ሁኔታ */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🔑</span> ምዝገባ
        </h2>
        <div className="space-y-4">
          <div className="flex justify-between items-center p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">ሁኔታ</span>
            <span className={`chip px-3 py-1 rounded-full text-xs font-medium ${
              isንቁ ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
              isሙከራ ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400' :
              'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
            }`}>
              {isንቁ ? 'ንቁ' : isሙከራ ? `ሙከራ (${daysLeft} days left)` : 'ጊዜው አልፏል'}
            </span>
          </div>
          
          {subscription?.paidUntil && (
            <div className="flex justify-between items-center p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">እስከ</span>
              <span className="text-sm font-medium text-slate-900 dark:text-white">
                {new Date(subscription.paidUntil).toLocaleDateString()}
              </span>
            </div>
          )}

          <form onSubmit={handleUnlock} className="pt-4 border-t border-slate-200 dark:border-slate-700">
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              የመዳረሻ ኮድ ያስገቡ
            </label>
            <div className="flex gap-2">
              <Input
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value)}
                placeholder="የመዳረሻ ኮድዎን እዚህ ይለጥፉ..."
                className="flex-1"
              />
              <Button type="submit" isLoading={unlocking} disabled={!accessCode.trim()}>
                አንቃ
              </Button>
            </div>
          </form>
        </div>
      </Card>

      {/* 2. የአውታረ መረብ ስርጭት Info */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-2 flex items-center gap-2">
          <span>🌐</span> የአውታረ መረብ ስርጭት
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          አዳል ኬፕ በአካባቢዎ እና በአውታረ መረብ ላይ ንቁ ነው:
        </p>
        <div className="space-y-3 bg-slate-50 dark:bg-slate-800/60 p-4 rounded-xl border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300 w-20">አካባቢያዊ:</span>
            <code className="flex-1 bg-white dark:bg-slate-900 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-teal-600 dark:text-teal-400 font-mono text-sm">
              {localUrl}
            </code>
            <Button variant="secondary" onClick={() => handleቅዳ(localUrl)}>ቅዳ</Button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300 w-20">አውታረ መረብ:</span>
            <code className="flex-1 bg-white dark:bg-slate-900 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-teal-600 dark:text-teal-400 font-mono text-sm">
              {networkUrl}
            </code>
            <Button variant="secondary" onClick={() => handleቅዳ(networkUrl)}>ቅዳ</Button>
          </div>
        </div>
      </Card>

      {/* 3. መልክ */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🎨</span> መልክ
        </h2>
        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
          <div>
            <h3 className="font-medium text-slate-900 dark:text-white">ጨለማ ሁነታ</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">በመተግበሪያው ውስጥ ጨለማ ገጽታ ይቀያይሩ</p>
          </div>
          <button 
            onClick={toggleDarkMode}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
              darkMode ? 'bg-teal-600' : 'bg-slate-300'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              darkMode ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </Card>

      {/* 4. Wallpaper Settings */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🖼️</span> የጀርባ ምስል
        </h2>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="aspect-video w-full rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900 overflow-hidden flex items-center justify-center relative">
            {currentWallpaper ? (
              <img src={currentWallpaper} alt="Wallpaper Preview" className="w-full h-full object-cover" />
            ) : (
              <div className="text-center text-slate-400">
                <svg className="w-10 h-10 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-sm">ብጁ የጀርባ ምስል የለም</p>
              </div>
            )}
          </div>
          <div className="flex flex-col justify-center gap-3">
            <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-xl cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {uploadingWallpaper ? 'በመስቀል ላይ...' : 'የጀርባ ምስል ለመስቀል ይጫኑ'}
                </p>
                <p className="text-xs text-slate-400 mt-1">JPG, PNG እስከ 5ሜባ</p>
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
                className="w-full px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-xl hover:bg-red-100 transition-colors"
              >
                የጀርባ ምስል አስወግድ
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* 5. የስርዓት ማሻሻያዎች */}
      <Card>
        <h2 className="font-display text-lg font-bold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
          <span>🔄</span> የስርዓት ማሻሻያዎች
        </h2>
        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
          <div>
            <h3 className="font-medium text-slate-900 dark:text-white">ማሻሻያዎችን ፈትሽ</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">ከስርዓት ማከማቻ የቅርብ ጊዜ ማሻሻያዎችን ያግኙ እና ይተግብሩ</p>
          </div>
          <Button onClick={handleCheckUpdate} isLoading={updating}>ማሻሻያዎችን ፈትሽ</Button>
        </div>
      </Card>
    </div>
  )
}
