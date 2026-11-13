/**
 * Broker → the profiles nobody is assigned to yet: search them (name,
 * passport, phone), newest first, and tap one — she goes to this broker. On
 * a PC she can be dragged onto the box too. On a phone with the office PC
 * off she moves at once (the PC saves it when it is on).
 */
import { useEffect, useMemo, useState } from 'react'
import api from '../services/api'
import toast from 'react-hot-toast'

const SHOWN = 60

export default function BrokersAssignPanel({ brokerId, onAssigned }) {
  const [all, setAll] = useState(null)
  const [q, setQ] = useState('')
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(0)
  const bid = Number(brokerId)

  const load = async () => {
    try {
      const res = await api.get('/profiles')
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      setAll(list.filter(p => !p.broker_id).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))))
    } catch {
      setAll([])
    }
  }
  useEffect(() => { load() }, [])

  const found = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = all || []
    if (!s) return list
    return list.filter(p => [p.full_name, p.passport_number, p.phone_number, p.labor_id].some(v => String(v || '').toLowerCase().includes(s)))
  }, [all, q])

  const assign = async (profileId) => {
    const pid = Number(profileId)
    if (!bid || !pid || busy) return
    setBusy(pid)
    try {
      const { data } = await api.post('/brokers/assign', { profileId: pid, brokerId: bid })
      const who = all?.find(p => p.id === pid)?.full_name || 'She'
      toast.success(data?.queued ? `${who} → this broker (the PC saves it when it is on)` : `${who} → this broker`)
      setAll(prev => (prev || []).filter(p => p.id !== pid))
      if (typeof onAssigned === 'function') await onAssigned()
    } catch (e) {
      toast.error(e.response?.data?.error || 'መመደብ አልተቻለም')
      await load()
    } finally {
      setBusy(0)
    }
  }

  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-700">
        <p className="mb-2 text-xs font-semibold text-slate-500">
          ያልተመደቡ ({all ? all.length : '…'}) — ፈልገው ይንኩ: ወደዚህ ደላላ ይገባሉ
        </p>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="ስም፣ ፓስፖርት ወይም ስልክ ይፈልጉ…" type="search"
          className="mb-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {found.slice(0, SHOWN).map(p => (
            <button
              type="button"
              key={p.id}
              draggable
              onDragStart={e => { e.dataTransfer.setData('text/plain', String(p.id)); e.dataTransfer.effectAllowed = 'move' }}
              onClick={() => assign(p.id)}
              disabled={!!busy}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm shadow-sm hover:border-teal-400 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">{p.full_name}</span>
                <span className="block text-[10px] text-slate-400">{p.passport_number || '—'}{p.phone_number ? ` · ${p.phone_number}` : ''}</span>
              </span>
              <span className="shrink-0 rounded-md bg-teal-600 px-2 py-1 text-xs font-semibold text-white">{busy === p.id ? '…' : '＋'}</span>
            </button>
          ))}
          {found.length > SHOWN && <p className="text-center text-[11px] text-slate-400">{found.length - SHOWN} more — search to find her</p>}
          {all && !found.length && (
            <p className="text-xs text-slate-400">{q ? 'ማንም አልተገኘም' : 'ሁሉም ተመድበዋል'}</p>
          )}
        </div>
      </div>
      {/* Dragging is for a mouse: a phone taps. */}
      <div
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault()
          setOver(false)
          const id = Number(e.dataTransfer.getData('text/plain'))
          if (id) assign(id)
        }}
        className={`hidden min-h-[120px] items-center justify-center rounded-xl border-2 border-dashed p-6 text-sm md:flex ${
          over ? 'border-teal-500 bg-teal-50' : 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-900'
        }`}
      >
        {busy ? '...' : 'እዚህ ይጣሉ → ወደ የተመደቡ ይጨመራል'}
      </div>
    </div>
  )
}
