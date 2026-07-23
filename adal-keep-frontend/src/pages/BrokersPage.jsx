import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'
import Button from '../components/shared/Button'
import Modal from '../components/shared/Modal'

export default function BrokersPage() {
  const navigate = useNavigate()
  const [profiles, setProfiles] = useState([])
  const [brokers, setBrokers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  
  // Add Broker Modal State
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [newBroker, setNewBroker] = useState({ name: '', contact1: '', address: '' })
  const [isSaving, setIsSaving] = useState(false)

  // Edit Broker State
  const [editingBroker, setEditingBroker] = useState(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [profilesRes, brokersRes] = await Promise.all([
        api.get('/profiles'),
        api.get('/brokers')
      ])
      setProfiles(profilesRes.data)
      setBrokers(brokersRes.data)
    } catch (err) {
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const handleAddBroker = async (e) => {
    e.preventDefault()
    if (!newBroker.name.trim()) {
      toast.error('Broker name is required')
      return
    }
    setIsSaving(true)
    try {
      await api.post('/brokers', newBroker)
      toast.success('Broker added successfully')
      setIsModalOpen(false)
      setNewBroker({ name: '', contact1: '', address: '' })
      loadData()
    } catch (err) {
      toast.error('Failed to add broker')
    } finally {
      setIsSaving(false)
    }
  }

  const handleEditBroker = async (e) => {
    e.preventDefault()
    if (!editingBroker.name.trim()) {
      toast.error('Broker name is required')
      return
    }
    setIsSaving(true)
    try {
      await api.put(`/brokers/${editingBroker.id}`, editingBroker)
      toast.success('Broker updated successfully')
      setEditingBroker(null)
      loadData()
    } catch (err) {
      toast.error('Failed to update broker')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteBroker = async (brokerId, brokerName) => {
    if (!confirm(`Delete broker "${brokerName}" and unassign all profiles?`)) return
    try {
      const profilesToUnassign = profiles.filter(p => p.broker_id === brokerId)
      for (const profile of profilesToUnassign) {
        await api.put(`/profiles/${profile.id}`, { broker_id: null })
      }
      await api.delete(`/brokers/${brokerId}`)
      toast.success('Broker deleted and profiles unassigned')
      loadData()
    } catch (err) {
      toast.error('Failed to delete broker')
    }
  }

  // --- Drag and Drop Handlers ---
  const handleDragStart = (e, profileId) => {
    e.dataTransfer.setData('profileId', profileId)
    e.dataTransfer.effectAllowed = 'move'
    e.target.style.opacity = '0.5'
  }

  const handleDragEnd = (e) => {
    e.target.style.opacity = '1'
  }

  const handleDragOver = (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDropOnBroker = async (e, brokerId) => {
    e.preventDefault()
    const profileId = e.dataTransfer.getData('profileId')
    if (!profileId) return
    try {
      await api.put(`/profiles/${profileId}`, { broker_id: brokerId })
      toast.success('Profile assigned successfully')
      loadData()
    } catch (err) {
      toast.error('Failed to assign profile')
    }
  }

  const handleDropOnUnassigned = async (e) => {
    e.preventDefault()
    const profileId = e.dataTransfer.getData('profileId')
    if (!profileId) return
    try {
      await api.put(`/profiles/${profileId}`, { broker_id: null })
      toast.success('Profile unassigned')
      loadData()
    } catch (err) {
      toast.error('Failed to unassign profile')
    }
  }

  const unassignedProfiles = profiles.filter(
    p => !p.broker_id && p.full_name.toLowerCase().includes(search.toLowerCase())
  )
  
  const filteredBrokers = brokers.filter(
    b => b.name.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  return (
    <div className="animate-fade-up h-[calc(100vh-8rem)] flex flex-col">
      <PageHeader 
        title="Broker Management" 
        subtitle="Drag and drop profiles to assign or unassign brokers"
        action={
          <div className="flex gap-3">
            <div className="w-64">
              <Input 
                placeholder="Search brokers or profiles..." 
                value={search} 
                onChange={(e) => setSearch(e.target.value)} 
              />
            </div>
            <Button onClick={() => setIsModalOpen(true)}>
              + Add Broker
            </Button>
          </div>
        } 
      />

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-6 overflow-hidden">
        {/* LEFT PANE: Unassigned Profiles */}
        <div 
          className="panel flex flex-col overflow-hidden border-2 border-dashed border-slate-300 transition-colors hover:border-teal-400 hover:bg-teal-50/20"
          onDragOver={handleDragOver}
          onDrop={handleDropOnUnassigned}
        >
          <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex justify-between items-center">
            <h2 className="font-display font-bold text-slate-800 flex items-center gap-2">
              <span>📥</span> Unassigned Profiles
            </h2>
            <span className="chip bg-slate-200 text-slate-700">{unassignedProfiles.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
            {unassignedProfiles.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-sm">
                {search ? 'No matching profiles' : 'All profiles are assigned!'}
              </div>
            ) : (
              unassignedProfiles.map(profile => (
                <div
                  key={profile.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, profile.id)}
                  onDragEnd={handleDragEnd}
                  className="p-3 bg-white border border-slate-200 rounded-lg shadow-sm cursor-grab active:cursor-grabbing hover:border-teal-400 hover:shadow-md transition-all group"
                >
                  <div className="font-semibold text-slate-800">{profile.full_name}</div>
                  <div className="text-xs text-slate-500 mt-1 flex justify-between items-center">
                    <span>{profile.phone_number || 'No phone'}</span>
                    <span className="text-teal-600 font-medium opacity-0 group-hover:opacity-100 transition-opacity">Drag to assign →</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* RIGHT PANE: Brokers */}
        <div className="panel flex flex-col overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50/80 flex justify-between items-center">
            <h2 className="font-display font-bold text-slate-800 flex items-center gap-2">
              <span>🤝</span> Brokers
            </h2>
            <span className="chip bg-teal-100 text-teal-700">{filteredBrokers.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {filteredBrokers.length === 0 ? (
              <div className="text-center py-12 text-slate-400 text-sm">
                {search ? 'No matching brokers' : 'No brokers created yet.'}
              </div>
            ) : (
              filteredBrokers.map(broker => {
                const brokerProfiles = profiles.filter(
                  p => p.broker_id === broker.id && p.full_name.toLowerCase().includes(search.toLowerCase())
                )
                return (
                  <div
                    key={broker.id}
                    onDragOver={handleDragOver}
                    onDrop={(e) => handleDropOnBroker(e, broker.id)}
                    className="border-2 border-dashed border-slate-300 rounded-xl p-4 transition-all hover:border-teal-400 hover:bg-teal-50/30"
                  >
                    {/* Header with Title and Action Bar */}
                    <div className="flex justify-between items-start mb-3 gap-2">
                      <div className="min-w-0 flex-1">
                        <h3 
                          className="font-bold text-teal-700 hover:text-teal-800 text-lg cursor-pointer hover:underline transition-colors truncate"
                          onClick={(e) => {
                            e.stopPropagation() // Prevents triggering the drop zone
                            navigate(`/brokers/${broker.id}`)
                          }}
                          title="Click to view broker details and assigned profiles"
                        >
                          {broker.name}
                        </h3>
                        <p className="text-xs text-slate-500 truncate">{broker.contact1 || 'No contact info'}</p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="chip bg-slate-100 text-slate-600 font-medium text-xs px-2.5 py-1 rounded-full">
                          {brokerProfiles.length} profiles
                        </span>
                        <div className="flex items-center gap-1 border-l border-slate-200 pl-2">
                          <button 
                            type="button"
                            className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-md transition-colors"
                            onClick={() => setEditingBroker(broker)}
                            title="Edit broker"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 10H5v-6.828l8.586-8.586z" />
                            </svg>
                          </button>
                          <button 
                            type="button"
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            onClick={() => handleDeleteBroker(broker.id, broker.name)}
                            title="Delete broker"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.133 21H7.867a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="min-h-[80px] bg-white/60 rounded-lg p-3 space-y-2 transition-colors">
                      {brokerProfiles.length === 0 ? (
                        <div className="flex h-16 items-center justify-center text-xs text-slate-400 italic border border-dashed border-slate-300 rounded-lg">
                          Drop profiles here to assign
                        </div>
                      ) : (
                        brokerProfiles.map(profile => (
                          <div
                            key={profile.id}
                            draggable
                            onDragStart={(e) => handleDragStart(e, profile.id)}
                            onDragEnd={handleDragEnd}
                            className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm cursor-grab active:cursor-grabbing hover:border-red-300 hover:bg-red-50 transition-all flex justify-between items-center group"
                          >
                            <div>
                              <span className="text-sm font-semibold text-slate-700">{profile.full_name}</span>
                              <div className="text-[10px] text-slate-400">{profile.phone_number}</div>
                            </div>
                            <span className="text-[10px] text-red-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                              Drag to unassign
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>

      {/* Add Broker Modal */}
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Add New Broker" size="sm">
        <form onSubmit={handleAddBroker} className="space-y-4">
          <Input 
            label="Broker Name *" 
            value={newBroker.name} 
            onChange={(e) => setNewBroker({...newBroker, name: e.target.value})} 
            placeholder="e.g., Ahmed Ali"
            required
          />
          <Input 
            label="Contact Number" 
            value={newBroker.contact1} 
            onChange={(e) => setNewBroker({...newBroker, contact1: e.target.value})} 
            placeholder="e.g., +251 911 223344"
          />
          <Input 
            label="Address" 
            value={newBroker.address} 
            onChange={(e) => setNewBroker({...newBroker, address: e.target.value})} 
            placeholder="e.g., Addis Ababa"
          />
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="secondary" onClick={() => setIsModalOpen(false)}>Cancel</Button>
            <Button type="submit" isLoading={isSaving}>Save Broker</Button>
          </div>
        </form>
      </Modal>

      {/* Edit Broker Modal */}
      <Modal isOpen={editingBroker !== null} onClose={() => setEditingBroker(null)} title="Edit Broker" size="sm">
        <form onSubmit={handleEditBroker} className="space-y-4">
          <Input 
            label="Broker Name *" 
            value={editingBroker?.name || ''} 
            onChange={(e) => setEditingBroker({...editingBroker, name: e.target.value})} 
            placeholder="e.g., Ahmed Ali"
            required
          />
          <Input 
            label="Contact Number" 
            value={editingBroker?.contact1 || ''} 
            onChange={(e) => setEditingBroker({...editingBroker, contact1: e.target.value})} 
            placeholder="e.g., +251 911 223344"
          />
          <Input 
            label="Address" 
            value={editingBroker?.address || ''} 
            onChange={(e) => setEditingBroker({...editingBroker, address: e.target.value})} 
            placeholder="e.g., Addis Ababa"
          />
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="secondary" onClick={() => setEditingBroker(null)}>Cancel</Button>
            <Button type="submit" isLoading={isSaving}>Update Broker</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}