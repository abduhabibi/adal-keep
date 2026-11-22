import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const TEXT = {
  current: ['bg-green-100 text-green-700', 'Up to date'],
  'needs-prepare': ['bg-amber-100 text-amber-700', 'Needs PREPARE'],
  'old-installers': ['bg-amber-100 text-amber-700', 'Old installers'],
}

/** The Adal Keep USB plugged into this PC: shows its state and offers to bring it up to date. Nothing shows without one. */
export default function UsbCard() {
  const [info, setInfo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    let live = true
    const load = () => api.get('/system/update/usb').then(r => live && setInfo(r.data)).catch(() => {})
    load()
    const t = setInterval(load, 8000)
    return () => { live = false; clearInterval(t) }
  }, [])

  if (!info?.drives?.length) return null

  const fix = async (root) => {
    setBusy(true)
    try {
      const r = await api.post('/system/update/usb/fix', { root })
      setResult(r.data)
      const d = await api.get('/system/update/usb'); setInfo(d.data)
      if (r.data.failed?.length) toast.error(`${r.data.failed.length} file(s) could not be copied`)
      else toast.success('The USB is updated')
    } catch (e) { toast.error(e.response?.data?.error || 'The USB could not be updated') }
    finally { setBusy(false) }
  }

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-3">Adal Keep USB</h2>
      {info.drives.map(d => (
        <div key={d.root} className="space-y-2 mb-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono">{d.root}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${TEXT[d.state]?.[0] || ''}`}>{TEXT[d.state]?.[1] || d.state}</span>
          </div>
          {d.reasons?.map((t, i) => <p key={i} className="text-sm text-slate-600 dark:text-slate-300">{t}</p>)}
          {d.canFix && d.state !== 'current' && (
            <Button onClick={() => fix(d.root)} isLoading={busy}>Copy the latest installers and phone app to the USB</Button>
          )}
        </div>
      ))}
      {result?.failed?.map(f => <p key={f.name} className="text-xs text-red-600">{f.name}: {f.error}</p>)}
      <p className="text-xs text-amber-600">{info.eject}</p>
    </Card>
  )
}
