/**
 * CVs → 📥 Add from Musaned: pick a girl (search) and the CV template; the run
 * signs in to Musaned (a person types the code), opens her in the HR Pool,
 * copies her passport and photo, fills her profile from the passport and makes
 * her CV. Her run opens at once, so the sign-in code can be typed there.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import Button from './shared/Button'

const TEMPLATE_KEY = 'adal-musaned-cv-template'
const err = (e) => e?.response?.data?.error || e.message

export default function AddFromMusaned({ onClose }) {
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState(null)
  const [templates, setTemplates] = useState([])
  const [templateId, setTemplateId] = useState(() => { try { return Number(localStorage.getItem(TEMPLATE_KEY)) || '' } catch { return '' } })
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(0)

  useEffect(() => {
    api.get('/profiles').then(r => setProfiles(r.data || [])).catch(() => setProfiles([]))
    api.get('/cv/templates').then(r => {
      const list = (r.data || []).filter(t => t.is_active !== 0)
      setTemplates(list)
      setTemplateId(id => list.some(t => t.id === Number(id)) ? Number(id) : (list[0]?.id || ''))
    }).catch(() => {})
  }, [])
  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (profiles || []).filter(p => p.passport_number && (!s || `${p.full_name} ${p.passport_number} ${p.phone_number || ''}`.toLowerCase().includes(s))).slice(0, 60)
  }, [profiles, q])

  const start = async (p) => {
    if (!templateId) return toast.error('Choose the CV template first')
    setBusy(p.id)
    try { localStorage.setItem(TEMPLATE_KEY, String(templateId)) } catch {}
    try {
      const { data } = await api.post(`/profiles/${p.id}/automations/musaned_cv_import/start`, { template_id: templateId })
      toast.success(`${p.full_name}: Musaned opens — type the sign-in code when it asks`, { duration: 6000 })
      onClose()
      navigate(`/profiles/${p.id}?run=${data.runId}`)
    } catch (e) { toast.error(err(e), { duration: 8000 }) }
    setBusy(0)
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-t-2xl bg-white shadow-xl animate-fade-up dark:bg-slate-900 sm:rounded-2xl" onClick={e => e.stopPropagation()}>
        <div className="space-y-3 border-b border-slate-100 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-bold">📥 Add from Musaned</h2>
            <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">✕</button>
          </div>
          <p className="text-xs text-slate-500">Her passport and photo are copied from Musaned's HR Pool, her profile is filled from the passport, and her CV is made.</p>
          <label className="flex items-center gap-2 text-sm">
            <span className="shrink-0 font-semibold">CV template</span>
            <select className="field flex-1" value={templateId} onChange={e => setTemplateId(Number(e.target.value))}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <input autoFocus className="field w-full" placeholder="Search name, passport or phone…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
          {profiles === null && <li className="p-6 text-center text-sm text-slate-400">Loading…</li>}
          {profiles && !shown.length && <li className="p-6 text-center text-sm text-slate-500">No profile with a passport number matches</li>}
          {shown.map(p => (
            <li key={p.id}>
              <button type="button" disabled={!!busy} onClick={() => start(p)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-teal-50 disabled:opacity-60 dark:hover:bg-teal-900/20">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{p.full_name}</span>
                  <span className="text-xs text-slate-500">{p.passport_number}{p.broker_name ? ` · ${p.broker_name}` : ''}</span>
                </span>
                <span className="shrink-0 text-xs font-semibold text-teal-700 dark:text-teal-400">{busy === p.id ? 'Starting…' : 'Add →'}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body)
}
