import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'
import Button from '../components/shared/Button'
import ChecklistGridView from '../components/ChecklistGridView'

export default function ChecklistPage() {
  const [allProfiles, setAllProfiles] = useState([])
  const [checklists, setChecklists] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [newChecklistName, setNewChecklistName] = useState('')
  const [viewChecklist, setViewChecklist] = useState(null)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [profilesRes, checklistsRes] = await Promise.all([
        api.get('/profiles'),
        api.get('/checklists')
      ])
      setAllProfiles(profilesRes.data)
      setChecklists(checklistsRes.data)
    } catch {
      toast.error('Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  // --- Drag and Drop ---
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

  const handleDropOnChecklist = async (e, checklistId) => {
    e.preventDefault()
    const profileId = e.dataTransfer.getData('profileId')
    if (!profileId) return

    try {
      await api.post(`/checklists/${checklistId}/profiles`, { profile_id: profileId })
      toast.success('Profile added to checklist')
      loadData()
    } catch {
      toast.error('Failed to add profile')
    }
  }

  // --- Actions ---
  const handleCreateChecklist = async (e) => {
    e.preventDefault()
    if (!newChecklistName.trim()) return
    try {
      await api.post('/checklists', { name: newChecklistName })
      toast.success('Checklist created')
      setNewChecklistName('')
      loadData()
    } catch {
      toast.error('Failed to create checklist')
    }
  }

  const handleDeleteChecklist = async (id, name) => {
    if (!confirm(`Delete checklist "${name}"? This will not delete the profiles.`)) return
    try {
      await api.delete(`/checklists/${id}`)
      toast.success('Checklist deleted')
      loadData()
    } catch {
      toast.error('Failed to delete checklist')
    }
  }

  const handleRemoveProfileFromChecklist = async (checklistId, profileId) => {
    try {
      await api.delete(`/checklists/${checklistId}/profiles/${profileId}`)
      toast.success('Profile removed from checklist')
      loadData()
    } catch {
      toast.error('Failed to remove profile')
    }
  }

  // --- Filtering ---
  const filteredProfiles = allProfiles.filter(p => 
    p.full_name.toLowerCase().includes(search.toLowerCase()) || 
    p.phone_number?.includes(search)
  )

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  return (
    <div className="animate-fade-up h-[calc(100vh-8rem)] flex flex-col">
      <PageHeader 
        title="Checklist Composer" 
        subtitle="Drag profiles into checklists to group them for printing or export."
      />

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 overflow-hidden">
        
        {/* LEFT PANE: All Profiles (Draggable) */}
        <div className="panel flex flex-col overflow-hidden lg:col-span-1">
          <div className="p-4 border-b border-slate-200 bg-slate-50/80">
            <h2 className="font-display font-bold text-slate-800 mb-3">📥 All Profiles</h2>
            <Input 
              placeholder="Search profiles..." 
              value={search} 
              onChange={(e) => setSearch(e.target.value)} 
            />
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            {filteredProfiles.map(profile => (
              <div
                key={profile.id}
                draggable
                onDragStart={(e) => handleDragStart(e, profile.id)}
                onDragEnd={handleDragEnd}
                className="p-3 bg-white border border-slate-200 rounded-lg shadow-sm cursor-grab active:cursor-grabbing hover:border-teal-400 hover:shadow-md transition-all group"
              >
                <div className="font-semibold text-slate-800 text-sm">{profile.full_name}</div>
                <div className="text-xs text-slate-500 mt-1">{profile.phone_number || 'No phone'}</div>
              </div>
            ))}
            {filteredProfiles.length === 0 && (
              <div className="text-center py-8 text-slate-400 text-sm">No profiles found.</div>
            )}
          </div>
        </div>

        {/* RIGHT PANE: Checklists (Drop Zones) */}
        <div className="panel flex flex-col overflow-hidden lg:col-span-2">
          <div className="p-4 border-b border-slate-200 bg-slate-50/80">
            <h2 className="font-display font-bold text-slate-800 mb-3">📋 My Checklists</h2>
            <form onSubmit={handleCreateChecklist} className="flex gap-2">
              <Input 
                placeholder="New checklist name (e.g., July Batch)..." 
                value={newChecklistName} 
                onChange={(e) => setNewChecklistName(e.target.value)} 
              />
              <Button type="submit" disabled={!newChecklistName.trim()}>Create</Button>
            </form>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {checklists.map(checklist => (
              <div
                key={checklist.id}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDropOnChecklist(e, checklist.id)}
                className="border-2 border-dashed border-slate-300 rounded-xl p-4 transition-all hover:border-teal-400 hover:bg-teal-50/30 relative bg-white"
              >
                {/* Header */}
                <div className="flex justify-between items-start mb-3">
                  <h3 className="font-bold text-slate-800 text-lg">{checklist.name}</h3>
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => setViewChecklist(checklist)}>
                      🔲 Maximize & Edit
                    </Button>
                    <button 
                      onClick={() => handleDeleteChecklist(checklist.id, checklist.name)}
                      className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors"
                      title="Delete Checklist"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.133 21H7.867a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Drop Zone / Profile List */}
                <div className="min-h-[100px] bg-slate-50/50 rounded-lg p-3 space-y-2 transition-colors">
                  {checklist.profiles.length === 0 ? (
                    <div className="flex h-20 items-center justify-center text-sm text-slate-400 italic border border-dashed border-slate-300 rounded-lg bg-white">
                      Drop profiles here to add them
                    </div>
                  ) : (
                    checklist.profiles.map(profile => (
                      <div
                        key={profile.id}
                        className="p-2.5 bg-white border border-slate-200 rounded-lg shadow-sm flex justify-between items-center group hover:border-teal-300 transition-all"
                      >
                        <div>
                          <span className="text-sm font-semibold text-slate-700">{profile.full_name}</span>
                          <div className="text-[10px] text-slate-400">{profile.phone_number}</div>
                        </div>
                        <button
                          onClick={() => handleRemoveProfileFromChecklist(checklist.id, profile.id)}
                          className="text-xs text-red-500 hover:text-red-700 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded hover:bg-red-50"
                          title="Remove from this checklist (Profile is kept)"
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div className="mt-2 text-xs text-slate-400 text-right">
                  {checklist.profiles.length} profile{checklist.profiles.length !== 1 ? 's' : ''}
                </div>
              </div>
            ))}
            {checklists.length === 0 && (
              <div className="text-center py-12 text-slate-400 text-sm">
                No checklists yet. Create one above to start grouping profiles.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Grid Modal Component */}
      {viewChecklist && (
        <ChecklistGridView 
          checklist={viewChecklist} 
          onClose={() => setViewChecklist(null)} 
        />
      )}
    </div>
  )
}