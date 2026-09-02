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
  const { subscription, refresh } = useAuth()
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
      setCurrentWallpaper(URL.createObjectURL(res.data))
    } catch {
      setCurrentWallpaper(null)
    }
  }

  const toggleDarkMode = () => {
    const next = !darkMode
    setDarkMode(next)
    const theme = next ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', theme)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('adal-theme', theme)
  }

  const handleWallpaperUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) return toast.error('Max 5MB')
    setUploadingWallpaper(true)
    const fd = new FormData()
    fd.append('wallpaper', file)
    try {
      await api.post('/settings/wallpaper', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast.success('Wallpaper updated')
      loadWallpaper()
      window.dispatchEvent(new Event('wallpaper-changed'))
    } catch {
      toast.error('Upload failed')
    } finally {
      setUploadingWallpaper(false)
    }
  }

  const handleRemoveWallpaper = async () => {
    if (!confirm('Remove wallpaper?')) return
    try {
      await api.delete('/settings/wallpaper')
      setCurrentWallpaper(null)
      toast.success('Removed')
      window.dispatchEvent(new Event('wallpaper-changed'))
    } catch {
      toast.error('Failed')
    }
  }

  const handleCopy = (t) => {
    navigator.clipboard.writeText(t)
    toast.success('Copied')
  }

  const handleCheckUpdate = async () => {
    setUpdating(true)
    try {
      const res = await api.post('/system/update')
      toast.success(res.data?.message || 'Up to date')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Update check failed')
    } finally {
      setUpdating(false)
    }
  }

  const handleUnlock = async (e) => {
    e.preventDefault()
    if (!accessCode.trim()) return toast.error('Enter access code')
    setUnlocking(true)
    try {
      await api.post('/subscription/unlock', { code: accessCode })
      await refresh()
      toast.success('Access granted')
      setAccessCode('')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invalid code')
    } finally {
      setUnlocking(false)
    }
  }

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Spinner /></div>
  }

  const localUrl = `http://localhost:${port}`
  const networkUrl = `http://${networkIp}:${port}`
  const daysLeft = subscription?.daysLeft
  const isTrial = subscription?.mode === 'trial'
  const isActive = subscription?.mode === 'active'

  return (
    <div className="animate-fade-up max-w-4xl mx-auto space-y-6 pb-12">
      <PageHeader
        title="የስርዓት ቅንብሮች"
        subtitle="መልክ፣ አውታረ መረብ፣ ምዝገባ እና ማሻሻያዎች"
      />

      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          <span>🔑</span> ምዝገባ
        </h2>
        <div className="space-y-4">
          <div className="flex justify-between items-center p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border">
            <span className="text-sm font-medium">ሁኔታ</span>
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${
              isActive ? 'bg-green-100 text-green-700' :
              isTrial ? 'bg-blue-100 text-blue-700' : 'bg-red-100 text-red-700'
            }`}>
              {isActive ? 'ንቁ' : isTrial ? `ሙከራ (${daysLeft} days)` : 'ጊዜው አልፏል'}
            </span>
          </div>
          <form onSubmit={handleUnlock} className="pt-4 border-t flex gap-2">
            <Input
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              placeholder="የመዳረሻ ኮድ..."
              className="flex-1"
            />
            <Button type="submit" isLoading={unlocking}>አንቃ</Button>
          </form>
        </div>
      </Card>

      <Card>
        <h2 className="font-display text-lg font-bold mb-2 flex items-center gap-2">
          <span>🌐</span> የአውታረ መረብ
        </h2>
        <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border">
          <div className="flex items-center gap-4">
            <span className="text-sm w-20">አካባቢያዊ</span>
            <code className="flex-1 text-sm text-teal-600 font-mono">{localUrl}</code>
            <Button variant="secondary" onClick={() => handleCopy(localUrl)}>ቅዳ</Button>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm w-20">አውታረ መረብ</span>
            <code className="flex-1 text-sm text-teal-600 font-mono">{networkUrl}</code>
            <Button variant="secondary" onClick={() => handleCopy(networkUrl)}>ቅዳ</Button>
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-3">
          Pextran login is saved inside <strong>Brave password manager</strong> only.
          Log in once in the agent Brave window; Brave will autofill next time.
        </p>
      </Card>

      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          <span>🎨</span> መልክ
        </h2>
        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border">
          <div>
            <h3 className="font-medium">ጨለማ ሁነታ</h3>
            <p className="text-sm text-slate-500">Dark mode</p>
          </div>
          <button
            onClick={toggleDarkMode}
            className={`relative inline-flex h-6 w-11 items-center rounded-full ${darkMode ? 'bg-teal-600' : 'bg-slate-300'}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${darkMode ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
      </Card>

      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          <span>🖼️</span> የጀርባ ምስል
        </h2>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="aspect-video rounded-xl border-2 border-dashed flex items-center justify-center bg-slate-100 dark:bg-slate-900 overflow-hidden">
            {currentWallpaper
              ? <img src={currentWallpaper} alt="" className="w-full h-full object-cover" />
              : <p className="text-sm text-slate-400">No wallpaper</p>}
          </div>
          <div className="flex flex-col justify-center gap-3">
            <label className="flex flex-col items-center justify-center h-32 border-2 border-dashed rounded-xl cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800">
              <span className="text-sm text-slate-500">{uploadingWallpaper ? 'Uploading…' : 'Upload wallpaper'}</span>
              <input type="file" className="hidden" accept="image/jpeg,image/png" onChange={handleWallpaperUpload} />
            </label>
            {currentWallpaper && (
              <button onClick={handleRemoveWallpaper} className="text-sm text-red-600">Remove</button>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          <span>🔄</span> ማሻሻያዎች
        </h2>
        <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border">
          <div>
            <h3 className="font-medium">Check updates</h3>
            <p className="text-sm text-slate-500">Pull latest system updates</p>
          </div>
          <Button onClick={handleCheckUpdate} isLoading={updating}>Check</Button>
        </div>
      </Card>
    </div>
  )
}
