/**
 * Settings → Portals: is each government portal answering now? Checked by
 * the PC every 3 hours (services/portalHealth.js); "Check now" asks again.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

export default function PortalsHealthCard() {
  const [s, setS] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.get('/system/portals').then(r => setS(r.data)).catch(() => {}) }, [])
  const now = async () => { setBusy(true); try { setS((await api.get('/system/portals?now=1', { timeout: 120000 })).data) } catch {} finally { setBusy(false) } }
  const list = s?.portals || []
  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🌐</span> Portals now</h2>
      <p className="text-sm text-slate-500 mb-3" translate="no">
        {s?.at ? `Checked ${new Date(s.at).toLocaleString()}. ` : 'Not checked yet. '}A portal that does not answer is down on its side — the robots wait for it.
      </p>
      {!!list.length && <ul className="grid gap-1.5 sm:grid-cols-2 mb-3 text-sm" translate="no">
        {list.map(p => <li key={p.key} className={`rounded-lg px-3 py-2 ${p.ok ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>
          {p.ok ? '✓' : '✗'} <b>{p.name}</b>{p.ok ? (p.ms ? ` · ${(p.ms / 1000).toFixed(1)} s` : '') : ` — ${p.why}`}
        </li>)}
      </ul>}
      <Button size="sm" variant="secondary" disabled={busy} onClick={now}>{busy ? 'Checking…' : 'Check now'}</Button>
    </Card>
  )
}
