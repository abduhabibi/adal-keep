/**
 * Settings → Wafid medical: what the booking form uses for every profile,
 * and the medical result check (Medical · Applied → Fit / Rejected).
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Card from './shared/Card'
import Button from './shared/Button'

const CITIES = ['Addis Ababa', 'Adama', 'Jimma']
const STATE = { fit: '✅ FIT', unfit: '❌ UNFIT', pending: '⏳ not final yet', none: '— no record yet', challenge: '⚠ robot check', unknown: '? could not read' }

export default function WafidCard() {
  const [s, setS] = useState(null)
  const [check, setCheck] = useState(null)

  useEffect(() => {
    api.get('/wafid/settings').then(r => setS(r.data)).catch(() => {})
    api.get('/wafid/check').then(r => setCheck(r.data)).catch(() => {})
  }, [])
  useEffect(() => {
    if (!check?.running) return
    const t = setInterval(() => api.get('/wafid/check').then(r => setCheck(r.data)).catch(() => {}), 3000)
    return () => clearInterval(t)
  }, [check?.running])

  if (!s) return null
  const save = async (patch) => {
    const next = { ...s, ...patch }
    setS(next)
    try { setS((await api.post('/wafid/settings', patch)).data); toast.success('Saved') } catch { toast.error('Could not save') }
  }
  const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm'

  return (
    <Card>
      <h2 className="font-display text-lg font-bold mb-1 flex items-center gap-2" translate="no"><span>🩺</span> Wafid medical</h2>
      <p className="text-sm text-slate-500 mb-4" translate="no">
        “Book Wafid medical” fills the whole Wafid form and ticks “I confirm…”, then rings. You check it, press Save And Continue, enter the SMS code and pay.
        It starts by itself when a Musaned run is marked done.
      </p>
      <div className="grid gap-3 sm:grid-cols-3" translate="no">
        <label className="text-sm">City of the medical
          <select className={field} value={s.city} onChange={e => save({ city: e.target.value })}>
            {CITIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="text-sm">Passport issue place
          <input className={field} defaultValue={s.issue_place} onBlur={e => e.target.value.trim() !== s.issue_place && save({ issue_place: e.target.value })} />
        </label>
        <label className="text-sm">Position applied for
          <input className={field} defaultValue={s.position} onBlur={e => e.target.value.trim() !== s.position && save({ position: e.target.value })} />
        </label>
      </div>
      <p className="mt-2 text-xs text-slate-500" translate="no">
        Email on the form: {s.email || <b className="text-red-600">none — set the Agency Email above</b>}. Phone, names, dates and passport come from each profile.
      </p>

      <div className="mt-4 border-t border-slate-200 dark:border-slate-700 pt-3" translate="no">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="sm" disabled={check?.running}
            onClick={async () => { await api.post('/wafid/check').catch(() => {}); setCheck({ running: true, results: [] }) }}>
            {check?.running ? `Checking… ${check.results?.length || 0} done` : 'Check medical results now'}
          </Button>
          <span className="text-xs text-slate-500">
            Every “Medical · Applied” profile is looked up on wafid.com every 4 hours by itself.{check?.last ? ` Last: ${new Date(check.last).toLocaleString()}` : ''}
          </span>
        </div>
        {check?.results?.length > 0 && (
          <ul className="mt-2 text-sm space-y-0.5">
            {check.results.map(r => <li key={r.id}><span className="font-medium">{r.name}</span> <span className="text-slate-400 font-mono text-xs">{r.passport}</span> — {STATE[r.state] || r.state}</li>)}
          </ul>
        )}
      </div>
    </Card>
  )
}
