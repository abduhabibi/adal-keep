import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Card from '../components/shared/Card'
import Button from '../components/shared/Button'

export default function BrokerDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [broker, setBroker] = useState(null)
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
  }, [id])

  const loadData = async () => {
    setLoading(true)
    try {
      const [brokerRes, profilesRes] = await Promise.all([
        api.get(`/brokers/${id}`),
        api.get(`/profiles?broker_id=${id}`)
      ])
      setBroker(brokerRes.data)
      setProfiles(profilesRes.data)
    } catch {
      toast.error('Failed to load broker details')
      navigate('/brokers')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`Delete broker "${broker.name}" and unassign all ${profiles.length} profiles?`)) return
    try {
      // Unassign all profiles first
      for (const p of profiles) {
        await api.put(`/profiles/${p.id}`, { broker_id: null })
      }
      // Then delete the broker
      await api.delete(`/brokers/${id}`)
      toast.success('Broker deleted and profiles unassigned')
      navigate('/brokers')
    } catch {
      toast.error('Failed to delete broker')
    }
      }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>
  if (!broker) return null

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader 
        title={broker.name} 
        subtitle={`${profiles.length} assigned profiles`}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => navigate('/brokers')}>Back to Brokers</Button>
            <Button variant="danger" onClick={handleDelete}>Delete Broker</Button>
          </div>
        } 
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Broker Info Card */}
        <Card className="lg:col-span-1 p-6">
          <h2 className="font-display text-lg font-bold text-slate-900 mb-4">Broker Information</h2>
          <dl className="space-y-4 text-sm">
            <div>
              <dt className="text-slate-500 mb-1">Primary Contact</dt>
              <dd className="font-medium text-slate-900">{broker.contact1 || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 mb-1">Secondary Contact</dt>
              <dd className="font-medium text-slate-900">{broker.contact2 || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 mb-1">Address</dt>
              <dd className="font-medium text-slate-900">{broker.address || 'N/A'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 mb-1">Notes</dt>
              <dd className="font-medium text-slate-900 whitespace-pre-wrap">{broker.notes || 'No notes added.'}</dd>
            </div>
          </dl>
        </Card>

        {/* Assigned Profiles List */}
        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="p-6 border-b border-slate-200 bg-slate-50/50">
            <h2 className="font-display text-lg font-bold text-slate-900">Assigned Profiles</h2>
          </div>
          
          {profiles.length === 0 ? (
            <div className="text-center py-12 text-slate-500">
              No profiles are currently assigned to this broker.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 uppercase bg-slate-50 border-b">
                  <tr>
                    <th className="px-6 py-3">Full Name</th>
                    <th className="px-6 py-3">Phone</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map(p => (
                    <tr key={p.id} className="border-b hover:bg-slate-50 transition-colors">
                      <td className="px-6 py-4 font-medium text-slate-900">{p.full_name}</td>
                      <td className="px-6 py-4 text-slate-600">{p.phone_number || '—'}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          p.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 
                          p.status === 'in_progress' ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'
                        }`}>
                          {p.status || 'Pending'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Button variant="ghost" size="sm" onClick={() => navigate(`/profiles/${p.id}`)}>
                          View Profile
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}