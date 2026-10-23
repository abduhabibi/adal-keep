import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import PageHeader from '../components/shared/PageHeader'
import Card from '../components/shared/Card'
import Button from '../components/shared/Button'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'
import Modal from '../components/shared/Modal'
import { getTheme, applyTheme } from '../lib/theme'
import { getLang, setLang } from '../lib/i18n'
import { whoAmI } from '../lib/tutor'
import TutorCard from '../components/TutorCard'
import TutorAdoption from '../components/TutorAdoption'
import MainPCCard from '../components/MainPCCard'
import WafidCard from '../components/WafidCard'

export default function SettingsPage() {
  const { subscription, refresh } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
  const [theme, setTheme] = useState(getTheme)
  const [currentWallpaper, setCurrentWallpaper] = useState(null)
  const [uploadingWallpaper, setUploadingWallpaper] = useState(false)
  const [networkIp, setNetworkIp] = useState('10.134.230.82')
  const [port] = useState('3000')
  const [checking, setChecking] = useState(false)
  const [hasUpdate, setHasUpdate] = useState(false)
  const [updateInfo, setUpdateInfo] = useState(null)
  // Update popup: 'uptodate' | 'available' | 'installing' | 'done' | 'error'
  const [updateModal, setUpdateModal] = useState(null)
  const [updateMessage, setUpdateMessage] = useState('')
  const [applying, setApplying] = useState(false)
  const [accessCode, setAccessCode] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  
  // New state for Agency Email
  const [agencyEmail, setAgencyEmail] = useState('')

  useEffect(() => {
    loadSettings()
    loadWallpaper()
    if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      setNetworkIp(window.location.hostname)
    }
    setLoading(false)
  }, [])

  const loadSettings = async () => {
    try {
      const res = await api.get('/settings')
      const settings = res.data || {}
      setAgencyEmail(settings.agency_email || '')
    } catch (err) {
      console.error('Failed to load settings', err)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    try {
      await api.put('/settings', {
        agency_email: agencyEmail.trim(),
      })
      toast.success('Settings saved successfully')
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  const loadWallpaper = async () => {
    try {
      const res = await api.get(`/wallpaper?t=${Date.now()}`, { responseType: 'blob' })
      setCurrentWallpaper(URL.createObjectURL(res.data))
    } catch {
      setCurrentWallpaper(null)
    }
  }

  const chooseTheme = (t) => setTheme(applyTheme(t))


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
    setChecking(true)
    try {
      const res = await api.get('/system/update/check')
      setUpdateInfo(res.data)
      setHasUpdate(!!res.data.hasUpdate)
      setUpdateModal(res.data.hasUpdate ? 'available' : 'uptodate')
    } catch (err) {
      setUpdateInfo(null)
      setUpdateMessage(err.response?.data?.error || 'Could not reach GitHub to check for updates.')
      setUpdateModal('error')
    } finally {
      setChecking(false)
    }
  }

  const handleApplyUpdate = async () => {
    setApplying(true)
    setUpdateModal('installing')
    try {
      const res = await api.post('/system/update/apply')
      setUpdateMessage(res.data?.message || 'Update installed.')
      setHasUpdate(false)
      setUpdateModal('done')
    } catch (err) {
      setUpdateMessage(err.response?.data?.error || 'Update failed.')
      setUpdateModal('error')
    } finally {
      setApplying(false)
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

      {/* NEW: Agency Settings Card */}
      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          <span>🏢</span> የኤጀንሲ ቅንብሮች (Agency Settings)
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">
              Agency Email (for Musaned/Notifications)
            </label>
            <Input
              type="email"
              placeholder="e.g., admin@youragency.com"
              value={agencyEmail}
              onChange={(e) => setAgencyEmail(e.target.value)}
            />
            <p className="text-xs text-slate-500 mt-1.5">
              This email will be used as the default contact for automated workflows like Musaned.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={saveSettings} isLoading={saving}>
              Save Settings
            </Button>
          </div>
        </div>
      </Card>

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
          <div className="flex justify-between items-center p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border">
            <span className="text-sm font-medium">PC number</span>
            <span className="font-mono text-lg font-bold tracking-[0.2em]">{subscription?.pcNumber || '—'}</span>
          </div>
          {!isActive && (
            <p className="text-xs text-slate-500">
              Call {subscription?.sellerPhone || '0995668080'}, tell them the PC number, and type the 6-digit code they give you.
            </p>
          )}
          <form onSubmit={handleUnlock} className="pt-4 border-t flex gap-2">
            <Input
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="6-digit code"
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

      {import.meta.env.VITE_DEMO !== '1' && <WafidCard />}
      {import.meta.env.VITE_DEMO !== '1' && <MainPCCard />}

      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          <span>🌐</span> Language · ቋንቋ
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[['am', 'አማርኛ', 'Amharic'], ['en', 'English', 'እንግሊዝኛ']].map(([id, label, other]) => (
            <button key={id} type="button" onClick={async () => {
                if (getLang() === id) return
                // The tips panel follows the app's language.
                await api.post('/tutor/lang', { who: whoAmI(), lang: id }).catch(() => {})
                setLang(id)
              }}
              className={`rounded-xl border-2 p-4 text-left transition ${getLang() === id ? 'border-teal-500 bg-teal-50/60 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 hover:border-teal-300'}`}>
              <span className="block font-semibold" translate="no">{label}</span>
              <span className="block text-xs text-slate-500 dark:text-slate-400" translate="no">{other}{getLang() === id ? ' · on' : ''}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500" translate="no">Saved on this PC. Profile data and chat messages stay as they were written.</p>
      </Card>

      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          <span>🎨</span> መልክ
        </h2>
        <div data-tour="theme-picker" className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { id: 'light', label: 'Light', am: 'ብርሃን', swatch: 'bg-gradient-to-br from-white to-slate-200' },
            { id: 'dark', label: 'Dark', am: 'ጨለማ', swatch: 'bg-gradient-to-br from-slate-800 to-black' },
            { id: 'gradient', label: 'Gradient', am: 'ቀለማት', swatch: 'theme-swatch-gradient' },
          ].map(t => (
            <button
              key={t.id}
              type="button"
              onClick={() => chooseTheme(t.id)}
              className={`flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-colors ${
                theme === t.id ? 'border-teal-500 bg-teal-50/60 dark:bg-teal-900/20' : 'border-slate-200 dark:border-slate-700 hover:border-teal-300'
              }`}
            >
              <span className={`h-10 w-10 shrink-0 rounded-lg border border-slate-300 dark:border-slate-600 ${t.swatch}`} />
              <span>
                <span className="block font-semibold text-slate-800 dark:text-slate-100">{t.label}</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">{t.am}{theme === t.id ? ' · on' : ''}</span>
              </span>
            </button>
          ))}
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
        <div className="space-y-4">
      <Modal
        isOpen={!!updateModal}
        onClose={() => { if (updateModal !== 'installing') setUpdateModal(null) }}
        title={{
          uptodate: 'You are up to date',
          available: 'Update available',
          installing: 'Installing update…',
          done: 'Update installed',
          error: 'Update problem',
        }[updateModal] || ''}
        size="sm"
      >
        <div className="space-y-4 text-sm text-slate-600 dark:text-slate-300">
          {updateModal === 'uptodate' && (
            <p>This copy already matches the latest version on GitHub{updateInfo?.latest?.short ? ` (${updateInfo.latest.short})` : ''}.</p>
          )}
          {updateModal === 'available' && (
            <>
              <p>A newer version is published on GitHub.</p>
              {updateInfo?.latest?.message && (
                <p className="rounded-lg bg-slate-50 dark:bg-slate-800 p-3 font-mono text-xs">{updateInfo.latest.message}</p>
              )}
              <p className="text-xs text-slate-500">
                Installing downloads the new code and its dependencies. Restart the app afterwards. Your data is kept.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setUpdateModal(null)}>Later</Button>
                <Button onClick={handleApplyUpdate} className="bg-green-600 hover:bg-green-700">Install update</Button>
              </div>
            </>
          )}
          {updateModal === 'installing' && (
            <div className="flex items-center gap-3">
              <Spinner />
              <span>Downloading from GitHub and installing. This can take a few minutes.</span>
            </div>
          )}
          {updateModal === 'done' && (
            <>
              <p>{updateMessage}</p>
              <p className="text-xs text-slate-500">Close this window, then restart Adal Keep to use the new version.</p>
              <div className="flex justify-end"><Button onClick={() => setUpdateModal(null)}>OK</Button></div>
            </>
          )}
          {updateModal === 'error' && (
            <>
              <p className="whitespace-pre-wrap break-words">{updateMessage}</p>
              <div className="flex justify-end"><Button onClick={() => setUpdateModal(null)}>Close</Button></div>
            </>
          )}
          {updateModal === 'uptodate' && (
            <div className="flex justify-end"><Button onClick={() => setUpdateModal(null)}>OK</Button></div>
          )}
        </div>
      </Modal>

          <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border">
            <div>
              <h3 className="font-medium">Software Updates</h3>
              <p className="text-sm text-slate-500">Check GitHub for the latest version and install it</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <Button data-tour="check-updates" onClick={handleCheckUpdate} isLoading={checking}>
                {checking ? 'Checking...' : 'Check for Updates'}
              </Button>
              {hasUpdate && (
                <Button onClick={handleApplyUpdate} isLoading={applying} className="bg-green-600 hover:bg-green-700">
                  {applying ? 'Installing...' : 'Download & Install Update'}
                </Button>
              )}
            </div>
          </div>
          {updateInfo && (
            <div className="p-4 rounded-xl border bg-white dark:bg-slate-900 text-sm space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                  updateInfo.hasUpdate ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                }`}>
                  {updateInfo.hasUpdate ? 'Update available' : 'Up to date'}
                </span>
                <span className="text-xs text-slate-500">
                  branch: <code className="font-mono">{updateInfo.branch}</code>
                </span>
              </div>
              <div className="grid gap-1 text-slate-600 dark:text-slate-300">
                <div>
                  <span className="text-slate-400">Installed:</span>{' '}
                  <code className="font-mono">{updateInfo.installed?.short || 'unknown'}</code>
                  {updateInfo.installed?.branch ? <> on <code className="font-mono">{updateInfo.installed.branch}</code></> : null}
                </div>
                <div>
                  <span className="text-slate-400">Latest:</span>{' '}
                  <code className="font-mono">{updateInfo.latest?.short}</code>
                  {updateInfo.latest?.message ? <> — {updateInfo.latest.message}</> : null}
                </div>
                {updateInfo.latest?.date && (
                  <div>
                    <span className="text-slate-400">Published:</span>{' '}
                    {new Date(updateInfo.latest.date).toLocaleString()}
                  </div>
                )}
              </div>
              <div className="pt-1">
                <a
                  href={updateInfo.compareUrl || updateInfo.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-teal-600 hover:underline"
                >
                  {updateInfo.hasUpdate ? 'View changes on GitHub' : 'View repository on GitHub'}
                </a>
              </div>
              {updateInfo.note && <p className="text-xs text-amber-600">{updateInfo.note}</p>}
            </div>
          )}
        </div>
      </Card>

      {/* Daily tutor and who uses what — at the bottom of Settings */}
      <TutorCard />
      <TutorAdoption />
    </div>
  )
}
