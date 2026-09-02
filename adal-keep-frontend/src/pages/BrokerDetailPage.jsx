import BrokersAssignPanel from './BrokersAssignPanel'
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Card from '../components/shared/Card'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import Modal from '../components/shared/Modal'

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

  useEffect(() => { load() }, [id])

  const load = async () => {
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
      load()
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

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>
  if (!broker) return null

  const unassignProfile = async (profileId) => {
    try {
      await api.post('/brokers/unassign', { profileId })
      toast.success('ከደላላ ተነጥሏል')
      if (typeof load === 'function') await load()
      else if (typeof loadBroker === 'function') await loadBroker()
      else window.location.reload()
    } catch (e) {
      try {
        await api.patch(`/profiles/${profileId}`, { broker_id: null })
        toast.success('ከደላላ ተነጥሏል')
        if (typeof load === 'function') await load()
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

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1 p-6">
          <h2 className="font-bold text-lg mb-4">የደላላ መረጃ</h2>
          <dl className="space-y-4 text-sm">
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

        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="p-5 border-b border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/40">
            <h2 className="font-bold text-lg">የተመደቡ ፕሮፋይሎች</h2>
          </div>
          {profiles.length === 0 ? (
            <div className="text-center py-14 text-slate-500">ምንም ፕሮፋይል የለም</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 dark:bg-slate-800/50">
                  <tr>
                    <th className="px-5 py-3 text-left">ስም</th>
                    <th className="px-5 py-3 text-left">ስልክ</th>
                    <th className="px-5 py-3 text-right">ተግባር</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map(p => (
                    <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-5 py-3.5 font-medium">{p.full_name}</td>
                      <td className="px-5 py-3.5 text-slate-500">{p.phone_number || '—'}</td>
                      <td className="px-5 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => navigate(`/profiles/${p.id}`)}>
                            ይመልከቱ
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={(e) => { e.stopPropagation(); unassignProfile(p.id) }}
                          >
                            አስወግድ
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

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
    
      <BrokersAssignPanel brokerId={Number(id)} onAssigned={() => load()} />
</div>
  )
}
