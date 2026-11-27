import BrokersAssignPanel from './BrokersAssignPanel'
import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Card from '../components/shared/Card'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import Modal from '../components/shared/Modal'
import BrokerProfileList from '../components/BrokerProfileList'
import { profilesList, lastProfiles } from '../lib/profilesCache'
import { saved } from '../lib/deviceCache'
import { fastSwitch, brokerSeen, keepBroker, keepBrokers, girlsOf } from '../lib/fastSwitch'

/* BrokersAssignPanel: drop zone */
export default function BrokerDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [broker, setBroker] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState({ name: '', contact1: '', address: '' })
  const [saving, setSaving] = useState(false)

  const now = useRef(id)
  now.current = id   // (a quick switch: an answer for the broker before is not shown)
  useEffect(() => { load() }, [id])

  // At once from what this window has (lib/fastSwitch.js), then quietly the fresh broker and list.
  const fill = (b) => { setBroker(b); setForm({ name: b.name || '', contact1: b.contact1 || '', address: b.address || '' }) }
  const quick = async ({ fresh = false } = {}) => {
    const mineNow = () => now.current === id
    const all = lastProfiles()
    const mine = all ? girlsOf(all, id) : null
    let b = brokerSeen(id)
    if (!b) { try { const list = await saved('/brokers'); keepBrokers(list); b = brokerSeen(id) } catch {} }
    if (!b && mine?.[0]?.broker_name) b = { id: Number(id), name: mine[0].broker_name }
    if (!mineNow()) return
    const shown = !!(b && mine)
    if (shown) { fill(b); setProfiles(mine); setLoading(false) } else setLoading(true)
    try {
      const [bRes, list] = await Promise.all([api.get(`/brokers/${id}`), profilesList({ fresh })])
      keepBroker(bRes.data)
      if (!mineNow()) return
      fill(bRes.data)
      setProfiles(girlsOf(list, id))
    } catch {
      if (!shown && mineNow()) { toast.error('መረጃ መጫን አልተቻለም'); navigate('/brokers') }
    } finally { if (mineNow()) setLoading(false) }
  }

  const load = async (o) => {
    if (fastSwitch()) return quick(o)
    setLoading(true)
    try {
      const [bRes, pRes] = await Promise.all([
        api.get(`/brokers/${id}`),
        api.get(`/profiles?broker_id=${id}`)
      ])
      setBroker(bRes.data)
      setProfiles(pRes.data || [])
      setForm({
        name: bRes.data.name || '',
        contact1: bRes.data.contact1 || '',
        address: bRes.data.address || ''
      })
    } catch {
      toast.error('መረጃ መጫን አልተቻለም')
      navigate('/brokers')
    } finally {
      setLoading(false)
    }
  }

  const save = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return toast.error('ስም ያስፈልጋል')
    setSaving(true)
    try {
      await api.put(`/brokers/${id}`, form)
      toast.success('ተዘምኗል')
      setEditOpen(false)
      load({ fresh: true })
    } catch {
      toast.error('ማዘመን አልተቻለም')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!confirm(`"${broker.name}" ይሰረዝ?\n\nፕሮፋይሎቹ አይጠፉም።`)) return
    try {
      for (const p of profiles) {
        await api.put(`/profiles/${p.id}`, { broker_id: null })
      }
      await api.delete(`/brokers/${id}`)
      toast.success('ተሰርዟል (ፕሮፋይሎች ተጠብቀዋል)')
      navigate('/brokers')
    } catch {
      toast.error('መሰረዝ አልተቻለም')
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner back /></div>
  if (!broker) return null

  const unassignProfile = async (profileId) => {
    try {
      await api.post('/brokers/unassign', { profileId })
      toast.success('ከደላላ ተነጥሏል')
      if (typeof load === 'function') await load({ fresh: true })
      else if (typeof loadBroker === 'function') await loadBroker()
      else window.location.reload()
    } catch (e) {
      try {
        await api.patch(`/profiles/${profileId}`, { broker_id: null })
        toast.success('ከደላላ ተነጥሏል')
        if (typeof load === 'function') await load({ fresh: true })
        else window.location.reload()
      } catch {
        toast.error('ማስወገድ አልተቻለም')
      }
    }
  }


  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title={broker.name}
        subtitle={`${profiles.length} የተመደቡ ፕሮፋይሎች`}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/brokers')}>← ተመለስ</Button>
            <Button onClick={() => setEditOpen(true)}>አርም</Button>
            <Button variant="danger" onClick={remove}>ሰርዝ</Button>
          </div>
        }
      />

      <Card className="p-5">
        <h2 className="font-bold text-lg mb-3">የደላላ መረጃ</h2>
        <dl className="flex flex-wrap gap-x-10 gap-y-3 text-sm">
          <div>
            <dt className="text-slate-500 mb-1">ስልክ</dt>
            <dd className="font-medium">{broker.contact1 || 'የለም'}</dd>
          </div>
          <div>
            <dt className="text-slate-500 mb-1">አድራሻ</dt>
            <dd className="font-medium">{broker.address || 'የለም'}</dd>
          </div>
        </dl>
      </Card>

      {/* One list of this broker's profiles: search, filters and sort */}
      <Card className="p-0 overflow-hidden">
        <div className="px-5 pt-5">
          <h2 className="font-bold text-lg">የተመደቡ ፕሮፋይሎች</h2>
        </div>
        <BrokerProfileList profiles={profiles} onUnassign={unassignProfile} />
      </Card>

      {/* Edit Modal */}
      <Modal isOpen={editOpen} onClose={() => setEditOpen(false)} title="ደላላ አርም" size="sm">
        <form onSubmit={save} className="space-y-4">
          <Input label="ስም *" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })} required />
          <Input label="ስልክ" value={form.contact1}
            onChange={e => setForm({ ...form, contact1: e.target.value })} />
          <Input label="አድራሻ" value={form.address}
            onChange={e => setForm({ ...form, address: e.target.value })} />
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setEditOpen(false)}>ሰርዝ</Button>
            <Button type="submit" isLoading={saving}>አስቀምጥ</Button>
          </div>
        </form>
      </Modal>
    
      <BrokersAssignPanel brokerId={Number(id)} onAssigned={() => load({ fresh: true })} />
</div>
  )
}
