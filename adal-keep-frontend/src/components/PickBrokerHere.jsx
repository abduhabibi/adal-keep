/**
 * Make a CV → "Assign a broker first": the broker is picked right here (a
 * phone has no other page open to go and do it), or a new one is added.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

const err = (e) => e?.response?.data?.error || e.message

export default function PickBrokerHere({ profileId, onDone }) {
  const [brokers, setBrokers] = useState(null)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.get('/brokers').then(r => setBrokers(r.data || [])).catch(() => setBrokers([])) }, [])

  const save = async () => {
    setBusy(true)
    try {
      let bid = id
      if (bid === 'new') {
        if (!name.trim()) { setBusy(false); return toast.error('Type the broker\'s name') }
        let by = ''
        try { const a = JSON.parse(localStorage.getItem('adal_active_employee') || 'null'); by = a?.name || a?.full_name || '' } catch {}
        const { data } = await api.post('/brokers', { name: name.trim(), contact1: phone.trim(), created_by: by || 'unknown' })
        // The PC is off: the new broker gets its number there — she is given it once it is saved.
        if (data?.queued || !(Number(data?.id) > 0)) { setBusy(false); return toast.success(`${name.trim()} is saved when the PC is on — then pick them here for her`, { duration: 7000 }) }
        bid = data?.id
      }
      if (!bid) { setBusy(false); return toast.error('Pick a broker') }
      await api.put(`/profiles/${profileId}`, { broker_id: Number(bid) })
      window.dispatchEvent(new Event('adal-profile-changed'))
      toast.success('Broker set')
      onDone?.(Number(bid))
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <select value={id} onChange={e => setId(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-900">
        <option value="">{brokers === null ? 'Loading brokers…' : '— Pick her broker —'}</option>
        {(brokers || []).filter(b => Number(b.id) > 0).map(b => <option key={b.id} value={b.id}>{b.name}{b.contact1 ? ` · ${b.contact1}` : ''}</option>)}
        <option value="new">＋ A new broker…</option>
      </select>
      {id === 'new' && <>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Broker's name" className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
        <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone" inputMode="tel" className="w-36 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-600 dark:bg-slate-900" />
      </>}
      <button type="button" onClick={save} disabled={busy || !id} className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Set broker'}</button>
    </div>
  )
}
