import { useEffect, useState } from 'react'
import ProfileSearchPad from '../components/ProfileSearchPad'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'
import { profilesList } from '../lib/profilesCache'
import { cachedGet } from '../lib/deviceCache'
import Modal from '../components/shared/Modal'
import Button from '../components/shared/Button'

export default function BrokersPage() {
  const navigate = useNavigate()
  const [brokers, setBrokers] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  // + Add broker (here too — on a phone as on a PC).
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', contact1: '', address: '' })
  const [saving, setSaving] = useState(false)
  const addBroker = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('የደላላ ስም ያስፈልጋል')
    setSaving(true)
    try {
      let by = ''
      try { const a = JSON.parse(localStorage.getItem('adal_active_employee') || 'null'); by = a?.name || a?.full_name || a?.username || '' } catch {}
      const { data } = await api.post('/brokers', { ...form, name: form.name.trim(), created_by: by || 'unknown' })
      toast.success(data?.queued ? 'ደላላ ተፈጥሯል — the PC saves it when it is on' : 'ደላላ ተፈጥሯል')
      setAdding(false)
      setForm({ name: '', contact1: '', address: '' })
      if (data?.queued) setBrokers(bs => [...bs, data])
      else loadData()
    } catch (err) {
      toast.error(err.response?.data?.error || 'መቀመጥ አልተቻለም')
    } finally { setSaving(false) }
  }

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      // What was kept on this device shows at once; the fresh lists replace it.
      const [brokersRes, profilesRes] = await Promise.all([
        cachedGet('/brokers', { onSaved: (d) => { setBrokers(d || []); setLoading(false) } }),
        profilesList({ onSaved: (d) => setProfiles(d || []) })
      ])
      setBrokers(brokersRes || [])
      setProfiles(profilesRes || [])
    } catch (err) {
      toast.error('ደላሎችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }

  const filtered = brokers.filter(b =>
    (b.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (b.contact1 || '').includes(search)
  )

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="ደላሎች"
        subtitle="ሁሉም ደላሎች · ለዝርዝር ጠቅ ያድርጉ"
        action={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="min-w-0 flex-1 sm:w-64">
              <Input
                placeholder="ደላላ ይፈልጉ..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button onClick={() => setAdding(true)} className="shrink-0">+ ደላላ አክል</Button>
          </div>
        }
      />

      {/* Outside a broker: search every profile */}
      {/* (on a phone the brokers come first; this search is on bigger screens) */}
      <div className="hidden sm:block"><ProfileSearchPad title="All profiles — search" profiles={profiles} maxHeight="max-h-72" /></div>

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          {search ? 'ምንም ደላላ አልተገኘም' : 'እስካሁን ደላላ የለም · + ደላላ አክል ይጫኑ'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(broker => {
            const count = profiles.filter(p => p.broker_id === broker.id).length
            return (
              <button
                key={broker.id}
                onClick={() => navigate(`/brokers/${broker.id}`)}
                className="text-left panel p-5 border border-slate-200 dark:border-slate-700 rounded-2xl hover:border-teal-400 hover:shadow-md transition-all group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-bold text-slate-800 dark:text-white text-lg truncate group-hover:text-teal-600 transition-colors">
                      {broker.name}
                    </h3>
                    <p className="text-sm text-slate-500 mt-1 truncate">
                      {broker.contact1 || 'ስልክ የለም'}
                    </p>
                    {broker.address && (
                      <p className="text-xs text-slate-400 mt-0.5 truncate">{broker.address}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs font-medium bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 px-2.5 py-1 rounded-full">
                    {count} ፕሮፋይል
                  </span>
                </div>
                <div className="mt-4 text-xs text-teal-600 dark:text-teal-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  ዝርዝር ለማየት ጠቅ ያድርጉ →
                </div>
              </button>
            )
          })}
        </div>
      )}
      <Modal isOpen={adding} onClose={() => setAdding(false)} title="አዲስ ደላላ አክል" size="sm">
        <form onSubmit={addBroker} className="space-y-4">
          <Input label="የደላላ ስም *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
          <Input label="ስልክ ቁጥር" type="tel" inputMode="tel" value={form.contact1} onChange={(e) => setForm({ ...form, contact1: e.target.value })} />
          <Input label="አድራሻ" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setAdding(false)}>ሰርዝ</Button>
            <Button type="submit" isLoading={saving}>ፍጠር</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
