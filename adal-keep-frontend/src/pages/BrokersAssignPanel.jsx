import { useEffect, useState } from 'react'
import api from '../services/api'
import toast from 'react-hot-toast'

export default function BrokersAssignPanel({ brokerId, onAssigned }) {
  const [unassigned, setUnassigned] = useState([])
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const bid = Number(brokerId)

  const load = async () => {
    try {
      const res = await api.get('/profiles')
      const list = Array.isArray(res.data) ? res.data : (res.data?.data || [])
      setUnassigned(list.filter(p => !p.broker_id).slice(0, 50))
    } catch {
      setUnassigned([])
    }
  }

  useEffect(() => { load() }, [])

  const assign = async (profileId) => {
    const pid = Number(profileId)
    if (!bid || !pid || busy) return
    setBusy(true)
    try {
      await api.post('/brokers/assign', { profileId: pid, brokerId: bid })
      toast.success('ፕሮፋይል ተመድቧል')
      // remove from unassigned only after success
      setUnassigned(prev => prev.filter(p => p.id !== pid))
      // parent reloads assigned table — no full page reload
      if (typeof onAssigned === 'function') await onAssigned()
      else await load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'መመደብ አልተቻለም')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-dashed border-slate-300 p-3">
        <p className="text-xs font-semibold text-slate-500 mb-2">
          ያልተመደቡ ({unassigned.length}) — ጎትት ወይም ጠቅ አድርግ
        </p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {unassigned.map(p => (
            <div
              key={p.id}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('text/plain', String(p.id))
                e.dataTransfer.effectAllowed = 'move'
              }}
              onClick={() => assign(p.id)}
              className="cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm hover:border-teal-400"
            >
              {p.full_name}
              <span className="block text-[10px] text-slate-400">{p.passport_number || '—'}</span>
            </div>
          ))}
          {!unassigned.length && (
            <p className="text-xs text-slate-400">ሁሉም ተመድበዋል</p>
          )}
        </div>
      </div>
      <div
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault()
          setOver(false)
          const id = Number(e.dataTransfer.getData('text/plain'))
          if (id) assign(id)
        }}
        className={`rounded-xl border-2 border-dashed p-6 flex items-center justify-center text-sm min-h-[120px] ${
          over ? 'border-teal-500 bg-teal-50' : 'border-slate-300 bg-slate-50'
        }`}
      >
        {busy ? '...' : 'እዚህ ይጣሉ → ወደ የተመደቡ ይጨመራል'}
      </div>
    </div>
  )
}
