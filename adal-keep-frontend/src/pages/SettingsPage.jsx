import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
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
import MainPCCard from '../components/MainPCCard'
import AgencyPCsCard from '../components/AgencyPCsCard'
import { CompanionSwitchCard } from '../components/CompanionSwitchPC'
import WafidCard from '../components/WafidCard'
import PortalsHealthCard from '../components/PortalsHealthCard'
import SharePowerCard from '../components/SharePowerCard'
import AutomationHealthCard from '../components/AutomationHealthCard'
import InsuranceCard from '../components/InsuranceCard'
import BackupCard from '../components/BackupCard'
import AuditLogCard from '../components/AuditLogCard'
import RollbackCard from '../components/RollbackCard'
import TelegramChannelCard from '../components/TelegramChannelCard'
import { ConnectedDevices } from '../components/PcAccessGate'
import { StartupCard, SupportCard } from '../components/AttentionBar'
import MusanedAuthenticatorCard, { MusanedCodesCard } from '../components/MusanedAuthenticatorCard'
import ErrorBoundary from '../components/shared/ErrorBoundary'
import { useCan } from '../lib/staffPerms'
import PhoneCard from '../components/PhoneCard'
import UsbCard from '../components/UsbCard'
import WhatsAppCard from '../components/WhatsAppCard'
import AiKeysCard from '../components/AiKeysCard'
import TransitionsCard from '../components/TransitionsCard'
import PlanCard from '../components/PlanCard'
import EproSignatureCard from '../components/EproSignatureCard'
import Segmented from '../components/shared/Segmented'
import { onCompanionOnline, phoneCloud } from '../lib/phoneMode'

// The tabs of Settings: [id, name].
// The phone app (a narrow PC window keeps every tab).
// An Adal Companion's online pages are a PC: every tab (lib/phoneMode.js).
const isPhoneView = () => !onCompanionOnline() && (!!window.Capacitor?.isNativePlatform?.() || import.meta.env.VITE_PHONE === '1')
const SETTINGS_TABS = [
  ['agency', 'Agency'],
  ['plan', 'Plan'],
  ['portals', 'Portals'],
  ['health', 'Health'],
  ['integrations', 'Integrations'],
  ['transitions', 'Transitions'],
  ['backup', 'Backup & updates'],
  ['look', 'Look & language'],
]

export default function SettingsPage() {
  const { subscription, refresh } = useAuth()
  // Which tab: ?tab=… (links like "Settings → WhatsApp" open it), else the agency.
  const [params, setParams] = useSearchParams()
  // ?tab=whatsapp (older links) opens Integrations, where WhatsApp now is.
  const asked = params.get('tab') === 'whatsapp' ? 'integrations' : params.get('tab')
  // A phone has no Transitions (moving from another system is done on a PC).
  // (Backups and software updates are the PC's too: the phone's own update is in This phone.)
  const TABS = phoneCloud() || isPhoneView() ? SETTINGS_TABS.filter(([id]) => id !== 'transitions' && !(isPhoneView() && id === 'backup')) : SETTINGS_TABS
  const tab = TABS.some(([id]) => id === asked) ? asked : 'agency'
  // "Connect WhatsApp" buttons: straight to its card.
  useEffect(() => {
    if (params.get('tab') !== 'whatsapp') return
    const t = setTimeout(() => document.getElementById('whatsapp')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 600)
    return () => clearTimeout(t)
  }, [params])
  const setTab = (id) => { setParams(id === 'agency' ? {} : { tab: id }, { replace: true }); window.scrollTo({ top: 0 }) }
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
  const [theme, setTheme] = useState(getTheme)
  const [currentWallpaper, setCurrentWallpaper] = useState(null)
  const [uploadingWallpaper, setUploadingWallpaper] = useState(false)
  const [checking, setChecking] = useState(false)
  const [hasUpdate, setHasUpdate] = useState(false)
  // Updates install by themselves (when no run is working) unless turned off.
  const [autoUpdate, setAutoUpdate] = useState(true)
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
    setLoading(false)
  }, [])

  const loadSettings = async () => {
    try {
      const res = await api.get('/settings')
      const settings = res.data || {}
      setAgencyEmail(settings.agency_email || '')
      setAutoUpdate(String(settings.auto_update || 'on').toLowerCase() !== 'off')
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

  // The wallpaper is this device's own (lib/wallpaper.js): PC or phone.
  const loadWallpaper = async () => {
    const { currentWallpaper } = await import('../lib/wallpaper')
    setCurrentWallpaper(await currentWallpaper())
  }

  const chooseTheme = (t) => setTheme(applyTheme(t))


  const handleWallpaperUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 25 * 1024 * 1024) return toast.error('Max 25 MB')
    setUploadingWallpaper(true)
    try {
      const { setWallpaper } = await import('../lib/wallpaper')
      setCurrentWallpaper(await setWallpaper(file))
      toast.success('Wallpaper set on this device')
    } catch (err) {
      toast.error(err?.message || 'That picture could not be used')
    } finally {
      setUploadingWallpaper(false)
    }
  }

  const handleRemoveWallpaper = async () => {
    if (!confirm('Remove wallpaper?')) return
    try {
      const { removeWallpaper } = await import('../lib/wallpaper')
      await removeWallpaper()
      setCurrentWallpaper(null)
      toast.success('Removed')
    } catch {
      toast.error('Failed')
    }
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
      setUpdateMessage([err.response?.data?.error || 'Could not reach the updates.', err.response?.data?.details].filter(Boolean).join(' — '))
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

  const daysLeft = subscription?.daysLeft
  const canSettings = useCan('change_settings')
  const isTrial = subscription?.mode === 'trial'
  const isActive = subscription?.mode === 'active'

  return (
    <div className="animate-fade-up max-w-4xl mx-auto space-y-6 pb-12">
      <PageHeader
        title="የስርዓት ቅንብሮች"
      />
      {!canSettings && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          Your role cannot change settings: you can look, and the admin changes them.
        </div>
      )}
      {/* Settings in tabs — a short page instead of one long scroll. */}
      <div className="sticky top-0 z-20 py-1" translate="no">
        <Segmented wrap options={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === 'agency' && <>
      {phoneCloud() && <ErrorBoundary small name="This phone"><PhoneCard /></ErrorBoundary>}
      {!window.__ADAL_CLOUD && import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Connected devices"><ConnectedDevices /></ErrorBoundary>}
      {!window.__ADAL_CLOUD && import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Startup"><StartupCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Remote support"><SupportCard /></ErrorBoundary>}
      {/* NEW: Agency Settings Card */}
      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          የኤጀንሲ ቅንብሮች
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
          ምዝገባ
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
      {import.meta.env.VITE_DEMO !== '1' && !isPhoneView() && <ErrorBoundary small name="The agency's PCs"><AgencyPCsCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && !isPhoneView() && <ErrorBoundary small name="Main PC & phones"><MainPCCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && !isPhoneView() && <ErrorBoundary small name="PCs working together"><SharePowerCard /></ErrorBoundary>}
      {/* An Adal Companion only: log out of its main PC, connect to another. */}
      <CompanionSwitchCard />
      </>}
      {tab === 'plan' && import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Plan"><PlanCard /></ErrorBoundary>}
      {tab === 'portals' && <>
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Portals now"><PortalsHealthCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Musaned authenticator"><MusanedAuthenticatorCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Wafid"><WafidCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Insurance"><InsuranceCard /></ErrorBoundary>}
      </>}
      {tab === 'health' && import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Health"><AutomationHealthCard /></ErrorBoundary>}
      {tab === 'integrations' && <>
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Musaned code"><MusanedCodesCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="EPRO signature"><EproSignatureCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && <div id="whatsapp" className="scroll-mt-20"><ErrorBoundary small name="WhatsApp"><WhatsAppCard /></ErrorBoundary></div>}
      {import.meta.env.VITE_DEMO !== '1' && !isPhoneView() && <ErrorBoundary small name="Photo refining keys"><AiKeysCard /></ErrorBoundary>}
      {import.meta.env.VITE_DEMO !== '1' && !isPhoneView() && <ErrorBoundary small name="Telegram"><TelegramChannelCard /></ErrorBoundary>}
      </>}
      {tab === 'transitions' && import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Transitions"><TransitionsCard /></ErrorBoundary>}
      {tab === 'backup' && <>
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Backup"><BackupCard /></ErrorBoundary>}
      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          ማሻሻያዎች
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
              <label className="mt-2 flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={autoUpdate} onChange={async (e) => {
                  const on = e.target.checked
                  setAutoUpdate(on)
                  try { await api.put('/settings', { auto_update: on ? 'on' : 'off' }); toast.success(on ? 'Updates install by themselves' : 'Updates wait for you') }
                  catch { setAutoUpdate(!on); toast.error('Could not save') }
                }} />
                <span><b>Update by itself</b> — a new version installs as soon as no automation run is working (checked every 15 minutes)</span>
              </label>
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
          <RollbackCard />
        </div>
      </Card>
      <UsbCard />
      {import.meta.env.VITE_DEMO !== '1' && <ErrorBoundary small name="Audit log"><AuditLogCard /></ErrorBoundary>}
      </>}
      {tab === 'look' && <>
      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          Language · ቋንቋ
        </h2>
        <p className="text-xs text-slate-500 mb-3" translate="no">Saved for the employee signed in here · Arabic reads right to left</p>
        <Segmented translate="no" options={[['en', 'English'], ['am', 'አማርኛ'], ['ar', 'العربية']]} value={getLang()} onChange={(id) => {
            if (getLang() === id) return
            // The tips panel follows the app's language — told in the
            // background (on a phone the PC can be slow or off; the switch
            // never waits for it).
            Promise.race([api.post('/tutor/lang', { who: whoAmI(), lang: id }).catch(() => {}), new Promise(r => setTimeout(r, 800))])
              .finally(() => setLang(id))
          }} />
      </Card>
      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          መልክ
        </h2>
        <Segmented data-tour="theme-picker" options={[['light', 'Light'], ['dark', 'Dark'], ['gradient', 'Gradient']]} value={theme} onChange={chooseTheme} />
      </Card>
      <Card>
        <h2 className="font-display text-lg font-bold mb-4 flex items-center gap-2">
          የጀርባ ምስል
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
              <input type="file" className="hidden" accept="image/*" onChange={handleWallpaperUpload} />
            </label>
            {currentWallpaper && (
              <button onClick={handleRemoveWallpaper} className="text-sm text-red-600">Remove</button>
            )}
          </div>
        </div>
      </Card>
      {/* The Adal tour — at the bottom of Settings */}
      <ErrorBoundary small name="Tutor"><TutorCard /></ErrorBoundary>
      </>}
    </div>
  )
}
