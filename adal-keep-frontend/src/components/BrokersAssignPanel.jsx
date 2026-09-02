import { useEffect, useState } from 'react'
import api from '../services/api'
import toast from 'react-hot-toast'

export default function BrokersAssignPanel({ brokerId, onAssigned }) {
  const [unassigned, setUnassigned] = useState([])
  const [over, setOver] = useState(false)

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
    if (!brokerId || !profileId) return
    try {
      // Prefer dedicated assign if present
      try {
        await api.post('/brokers/assign', { profileId, brokerId })
      } catch {
        await api.patch(`/profiles/${profileId}`, { broker_id: brokerId })
      }
      toast.success('ፕሮፋይል ተመድቧል')
      setUnassigned(prev => prev.filter(p => p.id !== profileId))
      onAssigned?.()
    } catch (e) {
      toast.error(e.response?.data?.error || 'መመደብ አልተቻለም')
    }
  }

  return (
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-dashed border-slate-300 p-3">
        <p className="text-xs font-semibold text-slate-500 mb-2">ያልተመደቡ ፕሮፋይሎች (ይጎትቱ)</p>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {unassigned.map(p => (
            <div
              key={p.id}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData('application/x-profile-id', String(p.id))
                e.dataTransfer.setData('text/plain', String(p.id))
                e.dataTransfer.effectAllowed = 'move'
              }}
              className="cursor-grab rounded-lg bg-white border border-slate-200 px-3 py-2 text-sm shadow-sm active:cursor-grabbing"
            >
              {p.full_name}
              <span className="block text-[10px] text-slate-400">{p.passport_number || '—'}</span>
            </div>
          ))}
          {!unassigned.length && <p className="text-xs text-slate-400">ሁሉም ተመድበዋል</p>}
        </div>
      </div>
      <div
        onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => {
          e.preventDefault()
          setOver(false)
          const raw =
            e.dataTransfer.getData('application/x-profile-id') ||
            e.dataTransfer.getData('text/plain')
          const id = Number(raw)
          if (id) assign(id)
        }}
        className={`rounded-xl border-2 border-dashed p-6 flex items-center justify-center text-sm min-h-[120px] ${
          over ? 'border-teal-500 bg-teal-50' : 'border-slate-300 bg-slate-50'
        }`}
      >
        እዚህ ይጣሉ — ለዚህ ደላላ ለመመደብ
      </div>
    </div>
  )
}
