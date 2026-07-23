import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import { STATUS_OPTIONS } from '../lib/utils'

const emptyForm = {
  full_name: '',
  phone_number: '',
  national_id: '',
  passport_number: '',
  status: 'pending',
  broker_id: '',
  notes: '',
  room: '',
  table_name: '',
  box_number: '',
}

export default function ProfileFormPage() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const [form, setForm] = useState(emptyForm)
  const [brokers, setBrokers] = useState([])
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true

    async function boot() {
      try {
        const brokersRes = await api.get('/brokers')
        if (!alive) return
        setBrokers(brokersRes.data)

        if (isEdit) {
          const res = await api.get(`/profiles/${id}`)
          if (!alive) return
          const p = res.data
          setForm({
            full_name: p.full_name || '',
            phone_number: p.phone_number || '',
            national_id: p.national_id || '',
            passport_number: p.passport_number || '',
            status: p.status || 'pending',
            broker_id: p.broker_id ?? '',
            notes: p.notes || '',
            room: p.room || '',
            table_name: p.table_name || '',
            box_number: p.box_number || '',
          })
        }
      } catch {
        toast.error(isEdit ? 'Failed to load profile' : 'Failed to load form data')
        if (isEdit) navigate('/profiles')
      } finally {
        if (alive) setLoading(false)
      }
    }

    boot()
    return () => {
      alive = false
    }
  }, [id, isEdit, navigate])

  const setField = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      const payload = {
        ...form,
        broker_id: form.broker_id === '' ? null : Number(form.broker_id),
      }

      if (isEdit) {
        await api.put(`/profiles/${id}`, payload)
        toast.success('Profile updated')
        navigate(`/profiles/${id}`)
      } else {
        const res = await api.post('/profiles', payload)
        toast.success('Profile created')
        navigate(`/profiles/${res.data.id}`)
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spinner label={isEdit ? 'Loading profile…' : 'Loading…'} />

  return (
    <div className="mx-auto max-w-2xl animate-fade-up">
      <PageHeader
        title={isEdit ? 'Edit profile' : 'New profile'}
        subtitle={isEdit ? 'Update client details and filing info' : 'Add a new client to your workspace'}
      />

      <form onSubmit={handleSubmit} className="panel space-y-5 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="full_name">Full name *</label>
            <input id="full_name" required className="field" value={form.full_name} onChange={setField('full_name')} />
          </div>
          <div>
            <label className="label" htmlFor="phone_number">Phone *</label>
            <input id="phone_number" required type="tel" className="field" value={form.phone_number} onChange={setField('phone_number')} />
          </div>
          <div>
            <label className="label" htmlFor="status">Status</label>
            <select id="status" className="field" value={form.status} onChange={setField('status')}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="national_id">National ID</label>
            <input id="national_id" className="field" value={form.national_id} onChange={setField('national_id')} />
          </div>
          <div>
            <label className="label" htmlFor="passport_number">Passport</label>
            <input id="passport_number" className="field" value={form.passport_number} onChange={setField('passport_number')} />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="broker_id">Broker</label>
            <select id="broker_id" className="field" value={form.broker_id} onChange={setField('broker_id')}>
              <option value="">Unassigned</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <p className="label">Filing location</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <input className="field" placeholder="Room" value={form.room} onChange={setField('room')} />
            <input className="field" placeholder="Table" value={form.table_name} onChange={setField('table_name')} />
            <input className="field" placeholder="Box" value={form.box_number} onChange={setField('box_number')} />
          </div>
        </div>

        <div>
          <label className="label" htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            rows={4}
            className="field resize-y"
            placeholder="Anything useful about this client…"
            value={form.notes}
            onChange={setField('notes')}
          />
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-5">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create profile'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => navigate(isEdit ? `/profiles/${id}` : '/profiles')}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
