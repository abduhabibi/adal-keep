import { useEffect, useState, useRef } from 'react'
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
  
  // Drag state for visual feedback
  const [dragOverChecklistId, setDragOverChecklistId] = useState(null)
  const dragCounters = useRef({})

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
      toast.error('መረጃችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }

  const handleDragStart = (e, profileId) => {
    e.dataTransfer.setData('profileId', String(profileId))
    e.dataTransfer.effectAllowed = 'move'
    // Visual feedback for the item being dragged
    if (e.target) e.target.style.opacity = '0.5'
  }

  const handleDragEnd = (e) => {
    if (e.target) e.target.style.opacity = '1'
  }

  const handleDragEnter = (e, checklistId) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounters.current[checklistId] = (dragCounters.current[checklistId] || 0) + 1
    setDragOverChecklistId(checklistId)
  }

  const handleDragLeave = (e, checklistId) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounters.current[checklistId] = (dragCounters.current[checklistId] || 0) - 1
    if (dragCounters.current[checklistId] <= 0) {
      dragCounters.current[checklistId] = 0
      setDragOverChecklistId(null)
    }
  }

  const handleDragOver = (e) => {
    // CRITICAL: Must preventDefault to allow drop
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDropOnChecklist = async (e, checklistId) => {
    e.preventDefault()
    e.stopPropagation()
    
    // Reset drag state
    dragCounters.current[checklistId] = 0
    setDragOverChecklistId(null)

    const profileId = e.dataTransfer.getData('profileId')
    if (!profileId) return

    try {
      await api.post(`/checklists/${checklistId}/profiles`, { profile_id: profileId })
      toast.success('ፕሮፋይሉ ወደ ቼክስቱ ተጨምሯል')
      loadData()
    } catch {
      toast.error('ፕሮፋይሉን ማከል አልተቻለም')
    }
  }

  const handleCreateChecklist = async (e) => {
    e.preventDefault()
    if (!newChecklistName.trim()) return
    try {
      await api.post('/checklists', { name: newChecklistName })
      toast.success('ቼክስት ተጥል')
      setNewChecklistName('')
      loadData()
    } catch {
      toast.error('ቼክሊስት መፍር አልተቻለም')
    }
  }

  const handleDeleteChecklist = async (id, name) => {
    if (!confirm(`ቼክስት "${name}" ይሰረዝ? ይህ ፕሮፋይሎቹን አያጠፋም`)) return
    try {
      await api.delete(`/checklists/${id}`)
      toast.success('ቼክስቱ ተሰርዟል')
      loadData()
    } catch {
      toast.error('ቼክስቱን ጥፋት አልተቻለም')
    }
  }

  const handleRemoveProfileFromChecklist = async (checklistId, profileId) => {
    try {
      await api.delete(`/checklists/${checklistId}/profiles/${profileId}`)
      toast.success('ፕሮይሉ ቼክስቱ ወግዷል')
      loadData()
    } catch {
      toast.error('ፕሮፋይሉን ማንሳት አልተቻለም')
    }
  }

  const filteredProfiles = allProfiles.filter(p => 
    p.full_name.toLowerCase().includes(search.toLowerCase()) || 
    p.phone_number?.includes(search)
  )

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  return (
    <div className="animate-fade-up h-[calc(100vh-8rem)] flex flex-col">
      <PageHeader 
        title="የቼክሊስት አቀናባሪ" 
        subtitle="ፕሮፋይሎችን ወደ ክሊስቶች ይጎትቱ"
      />

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6 overflow-hidden">
        
        {/* LEFT PANE: All Profiles */}
        <div className="panel flex flex-col overflow-hidden lg:col-span-1">
          <div className="p-4 border-b border-slate-200/60 dark:border-slate-800/60">
            <h2 className="font-display font-bold text-slate-800 dark:text-white mb-3 flex items-center gap-2">
              <span className="text-lg">📥</span> ሁሉም ፕሮፋይሎች
            </h2>
            <Input 
              placeholder="ፕሮፋይሎችን ይፈል..." 
              value={search} 
              onChange={(e) => setSearch(e.target.value)} 
            />
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
            {filteredProfiles.map(profile => (
              <div
                key={profile.id}
                draggable="true"
                onDragStart={(e) => handleDragStart(e, profile.id)}
                onDragEnd={handleDragEnd}
                className="p-3 bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm border border-slate-200/60 dark:border-slate-700/60 rounded-xl shadow-sm cursor-grab active:cursor-grabbing hover:border-teal-400/50 dark:hover:border-teal-400/30 hover:shadow-md transition-all group"
              >
                <div className="font-semibold text-slate-800 dark:text-white text-sm">{profile.full_name}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{profile.phone_number || 'ስልክ የለም'}</div>
              </div>
            ))}
            {filteredProfiles.length === 0 && (
              <div className="text-center py-8 text-slate-400 dark:text-slate-500 text-sm">ምንም ፕሮፋይል አልተገኘም።</div>
            )}
          </div>
        </div>

        {/* RIGHT PANE: Checklists */}
        <div className="panel flex flex-col overflow-hidden lg:col-span-2">
          <div className="p-4 border-b border-slate-200/60 dark:border-slate-800/60">
            <h2 className="font-display font-bold text-slate-800 dark:text-white mb-3 flex items-center gap-2">
              <span className="text-lg">📋</span> የኔ ቼክስቶች
            </h2>
            <form onSubmit={handleCreateChecklist} className="flex gap-2">
              <Input 
                placeholder="አዲስ የቼክሊስት ስም..." 
                value={newChecklistName} 
                onChange={(e) => setNewChecklistName(e.target.value)} 
              />
              <Button type="submit" disabled={!newChecklistName.trim()}>
                ፍጠር
              </Button>
            </form>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {checklists.map(checklist => {
              const isOver = dragOverChecklistId === checklist.id
              return (
                <div
                  key={checklist.id}
                  onDragEnter={(e) => handleDragEnter(e, checklist.id)}
                  onDragLeave={(e) => handleDragLeave(e, checklist.id)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDropOnChecklist(e, checklist.id)}
                  className={`panel p-4 transition-all duration-200 border-2 rounded-xl ${
                    isOver 
                      ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-900/20 scale-[1.01] shadow-lg' 
                      : 'border-transparent hover:border-slate-200 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="font-bold text-slate-800 dark:text-white text-lg">
                      {checklist.name}
                    </h3>
                    <div className="flex gap-2">
                      <Button 
                        variant="secondary" 
                        size="sm" 
                        onClick={() => setViewChecklist(checklist)}
                        className="text-xs"
                      >
                        🔲 አጉላ
                      </Button>
                      <button 
                        onClick={() => handleDeleteChecklist(checklist.id, checklist.name)}
                        className="p-2 text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50/50 dark:hover:bg-red-500/10 rounded-lg transition-colors"
                        title="ቼክስቱን ርዝ"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.133 21H7.867a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div className={`min-h-[100px] rounded-lg p-3 space-y-2 transition-colors ${
                    isOver ? 'bg-teal-100/50 dark:bg-teal-900/30' : 'bg-white/30 dark:bg-slate-800/30'
                  }`}>
                    {checklist.profiles.length === 0 ? (
                      <div className="flex h-20 items-center justify-center text-sm text-slate-400 dark:text-slate-500 italic border border-dashed border-slate-300/60 dark:border-slate-700/60 rounded-lg bg-white/20 dark:bg-slate-800/20">
                        ለማከል ፕሮይሎችን እዚህ ያስቀምጡ
                      </div>
                    ) : (
                      checklist.profiles.map(profile => (
                        <div
                          key={profile.id}
                          className="p-2.5 bg-white/70 dark:bg-slate-800/70 backdrop-blur-sm border border-slate-200/60 dark:border-slate-700/60 rounded-lg shadow-sm flex justify-between items-center group hover:border-teal-400/50 dark:hover:border-teal-400/30 transition-all"
                        >
                          <div>
                            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                              {profile.full_name}
                            </span>
                            <div className="text-[10px] text-slate-400 dark:text-slate-500">
                              {profile.phone_number || 'ስልክ የለም'}
                            </div>
                          </div>
                          <button
                            onClick={() => handleRemoveProfileFromChecklist(checklist.id, profile.id)}
                            className="text-xs text-red-500 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-1 rounded-lg hover:bg-red-50/50 dark:hover:bg-red-500/10"
                            title="ከዚህ ቼክስት አስግድ"
                          >
                            አስወግድ
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="mt-2 text-xs text-slate-400 dark:text-slate-500 text-right">
                    {checklist.profiles.length} ፕሮፋይሎች
                  </div>
                </div>
              )
            })}
            {checklists.length === 0 && (
              <div className="text-center py-12 text-slate-400 dark:text-slate-500 text-sm">
                እስካሁን ምንም ቼክሊስት የለም።
              </div>
            )}
          </div>
        </div>
      </div>

      {viewChecklist && (
        <ChecklistGridView 
          checklist={viewChecklist} 
          onClose={() => setViewChecklist(null)} 
        />
      )}
    </div>
  )
}
