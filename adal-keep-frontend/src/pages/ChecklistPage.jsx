import { useEffect, useState, useRef } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import LangToggle from '../components/LangToggle'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'
import Button from '../components/shared/Button'
import ChecklistGridView from '../components/ChecklistGridView'
import { profilesDropped } from '../lib/profileDrag'
import { onDataChange } from '../lib/changes'

export default function ChecklistPage() {
  const [allProfiles, setAllProfiles] = useState([])
  const [checklists, setChecklists] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [newChecklistName, setNewChecklistName] = useState('') // the search over the checklists
  const [naming, setNaming] = useState(null)                    // a new checklist's name, while typed
  const [kept, setKept] = useState(() => { try { return JSON.parse(localStorage.getItem('adal-checklists-kept') || '{}') } catch { return {} } })
  const [viewChecklist, setViewChecklist] = useState(null)
  
  // Drag state for visual feedback
  const [dragOverChecklistId, setDragOverChecklistId] = useState(null)
  const dragCounters = useRef({})

  useEffect(() => {
    loadData()
    return onDataChange(['checklists', 'checklist_profiles', 'checklist_cells', 'profiles'], () => loadData(true))
  }, [])

  const loadData = async (quiet) => {
    if (quiet !== true) setLoading(true)
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
    e.dataTransfer.setData('application/x-adal-profiles', JSON.stringify([profileId]))
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

    const ids = profilesDropped(e)
    if (!ids.length) return

    try {
      await api.post(`/checklists/${checklistId}/profiles`, { profile_ids: ids })
      toast.success('ፕሮፋይሉ ወደ ቼክስቱ ተጨምሯል')
      loadData()
    } catch {
      toast.error('ፕሮፋይሉን ማከል አልተቻለም')
    }
  }

  const handleCreateChecklist = async (e) => {
    e.preventDefault()
    const name = (naming || '').trim()
    if (!name) return
    try {
      await api.post('/checklists', { name })
      toast.success('ቼክስት ተጥል')
      setNaming(null)
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

  // Over two months old: asked about, never deleted by itself. "Keep" asks again two months later.
  const TWO_MONTHS = 61 * 864e5
  const old = (c) => Date.now() - new Date(String(c.created_at || '').replace(' ', 'T') + (/Z|[+-]dd:?dd$/.test(c.created_at || '') ? '' : 'Z')).getTime() > TWO_MONTHS
    && !(kept[c.id] && Date.now() - kept[c.id] < TWO_MONTHS)
  const keep = (id) => {
    const next = { ...kept, [id]: Date.now() }
    setKept(next)
    try { localStorage.setItem('adal-checklists-kept', JSON.stringify(next)) } catch {}
  }
  const oldOnes = checklists.filter(old)
  const q = newChecklistName.trim().toLowerCase()
  const shown = !q ? checklists : checklists.filter(c => c.name.toLowerCase().includes(q) || c.profiles.some(p => p.full_name?.toLowerCase().includes(q) || p.phone_number?.includes(q)))

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  return (
    <div className="animate-fade-up h-[calc(100dvh-5.5rem)] flex flex-col">
      <div className="flex-1 min-h-0 grid grid-cols-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-rows-1 lg:grid-cols-3 gap-3 lg:gap-4 overflow-hidden">
        
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
                className="p-3 bg-white/70 dark:bg-slate-800/70 border border-slate-200/60 dark:border-slate-700/60 rounded-xl shadow-sm cursor-grab active:cursor-grabbing hover:border-teal-400/50 dark:hover:border-teal-400/30 hover:shadow-md transition-all group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800 dark:text-white text-sm truncate">{profile.full_name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{profile.phone_number || 'ስልክ የለም'}</div>
                  </div>
                  {checklists.length > 0 && (
                    <select aria-label="Put in a checklist" value="" title="Put in a checklist"
                      onChange={async (e) => {
                        const id = Number(e.target.value); if (!id) return
                        try { await api.post(`/checklists/${id}/profiles`, { profile_ids: [profile.id] }); toast.success(`Added to “${checklists.find(c => c.id === id)?.name}”`); loadData(true) } catch { toast.error('ፕሮፋይሉን ማከል አልተቻለም') }
                      }}
                      className="h-8 w-9 shrink-0 cursor-pointer appearance-none rounded-lg border border-teal-300 bg-teal-50 text-center text-base font-bold text-teal-700 dark:border-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                      <option value="">＋</option>
                      {checklists.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                </div>
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
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="font-display font-bold text-slate-800 dark:text-white flex items-center gap-2">
                <span className="text-lg">📋</span> የኔ ቼክስቶች
              </h2>
              <LangToggle />
            </div>
            <div className="flex gap-2">
              <Input
                type="search"
                placeholder="🔍 Search checklists or a name in them…"
                value={newChecklistName}
                onChange={(e) => setNewChecklistName(e.target.value)}
              />
              <Button type="button" data-tour="new-checklist" className="shrink-0 whitespace-nowrap" onClick={() => setNaming(naming == null ? newChecklistName.trim() : null)}>＋ Add</Button>
            </div>
            {naming != null && (
              <form onSubmit={handleCreateChecklist} className="mt-2 flex gap-2">
                <Input autoFocus placeholder="New checklist name…" value={naming} onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setNaming(null) }} />
                <Button type="submit" disabled={!naming.trim()}>Save</Button>
              </form>
            )}
            {oldOnes.length > 0 && (
              <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                ⏳ {oldOnes.length === 1 ? '1 checklist is' : `${oldOnes.length} checklists are`} over 2 months old. Delete {oldOnes.length === 1 ? 'it' : 'them'} if no longer needed — nothing is deleted by itself.
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {shown.map(checklist => {
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
                  {old(checklist) && (
                    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                      <span className="flex-1">⏳ Made over 2 months ago. Delete it?</span>
                      <button type="button" onClick={() => handleDeleteChecklist(checklist.id, checklist.name)} className="rounded-md bg-red-600 px-2.5 py-1 font-semibold text-white hover:bg-red-700">Delete</button>
                      <button type="button" onClick={() => keep(checklist.id)} className="rounded-md border border-amber-400 px-2.5 py-1 font-semibold hover:bg-amber-100 dark:hover:bg-amber-500/20">Keep</button>
                    </div>
                  )}
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
                          className="p-2.5 bg-white/70 dark:bg-slate-800/70 border border-slate-200/60 dark:border-slate-700/60 rounded-lg shadow-sm flex justify-between items-center group hover:border-teal-400/50 dark:hover:border-teal-400/30 transition-all"
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
            {checklists.length > 0 && shown.length === 0 && (
              <div className="text-center py-12 text-slate-400 dark:text-slate-500 text-sm">No checklist matches “{newChecklistName}”.</div>
            )}
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
          onClose={() => { setViewChecklist(null); loadData() }} 
        />
      )}
    </div>
  )
}
