import { useState, useEffect, useRef } from 'react'
import FileTray from '../FileTray'
import { useLocation, useNavigate } from 'react-router-dom'
import api from '../../services/api'

export default function Navbar({ onMenuClick, capturedFiles, setCapturedFiles }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [undoneTaskCount, setUndoneTaskCount] = useState(0)
  const [quickLinks, setQuickLinks] = useState([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingLink, setEditingLink] = useState(null)
  const [formData, setFormData] = useState({ name: '', url: '' })
  const [loading, setLoading] = useState(false)
  const modalRef = useRef(null)

  useEffect(() => {
    const fetchCount = async () => {
      try {
        const res = await api.get('/tasks')
        setUndoneTaskCount(res.data.filter(t => {
          const s = t.status
          return s === 'pending' || s === 'todo' || s === 'in_progress' || s === 'ongoing'
        }).length)
      } catch {}
    }
    fetchCount()
    const interval = setInterval(fetchCount, 10000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const fetchLinks = async () => {
      try {
        const res = await api.get('/quick-links')
        setQuickLinks(res.data)
      } catch {}
    }
    fetchLinks()
  }, [])

  // Close modal on outside click
  useEffect(() => {
    const handler = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        setShowAddModal(false)
        setEditingLink(null)
      }
    }
    if (showAddModal) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAddModal])

  const getPageName = () => {
    const path = location.pathname
    if (path === '/') return 'ዳሽቦርድ'
    if (path === '/profiles') return 'ፕሮፋይሎች'
    if (path === '/brokers') return 'አመቻቾች'
    if (path === '/checklist') return 'ቼክሊስት'
    if (path === '/tasks') return 'ተግባራት'
    if (path === '/settings') return 'ማስተካከያዎች'
    if (path.startsWith('/profiles/')) return 'የፕሮፋይል ዝርዝር'
    if (path.startsWith('/brokers/')) return 'የአመቻች ዝርዝር'
    return 'አጠቃላይ እይታ'
  }

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.url.trim()) return
    setLoading(true)
    try {
      if (editingLink) {
        await api.put(`/quick-links/${editingLink.id}`, formData)
      } else {
        await api.post('/quick-links', formData)
      }
      const res = await api.get('/quick-links')
      setQuickLinks(res.data)
      setShowAddModal(false)
      setEditingLink(null)
      setFormData({ name: '', url: '' })
    } catch {}
    setLoading(false)
  }

  const handleDelete = async (id) => {
    if (!confirm('ይህን ማገናኛ ማጥፋት ይፈልጋሉ?')) return
    try {
      await api.delete(`/quick-links/${id}`)
      setQuickLinks(prev => prev.filter(l => l.id !== id))
    } catch {}
  }

  const startEdit = (link) => {
    setEditingLink(link)
    setFormData({ name: link.name, url: link.url })
    setShowAddModal(true)
  }

  const openAdd = () => {
    setEditingLink(null)
    setFormData({ name: '', url: '' })
    setShowAddModal(true)
  }

  return (
    <>
      <nav className="glass-panel mx-4 mt-4 px-6 py-3 flex items-center justify-between transition-all duration-300 relative z-50" style={{ '--radius-lg': '16px' }}>
        <div className="flex items-center gap-4">
          <button onClick={onMenuClick} className="lg:hidden p-2 text-slate-500 dark:text-slate-400 rounded-lg hover:bg-white/10 transition-all" aria-label="ሜኑ">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="hidden sm:block">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white tracking-tight">{getPageName()}</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-medium">እንኳን ደህና መጡ፤ {undoneTaskCount} የሚጠብቁ ተግባራት አሉዎት</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Quick Links Bar */}
          <div className="hidden md:flex items-center gap-1 mr-2 pr-3 border-r border-white/10">
            {quickLinks.map((link) => (
              <div key={link.id} className="group relative">
                <a
                  href={link.url.startsWith('http') ? link.url : `https://${link.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-white/10 transition-all duration-200"
                  title={link.name}
                >
                  {link.thumbnail_url ? (
                    <img src={link.thumbnail_url} alt="" className="w-4 h-4 rounded-sm opacity-80 group-hover:opacity-100" onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex' }} />
                  ) : null}
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400 group-hover:text-teal-400 transition-colors max-w-[80px] truncate" style={{ display: link.thumbnail_url ? undefined : 'flex' }}>
                    {link.name}
                  </span>
                </a>
                {/* Hover actions */}
                <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:flex items-center gap-0.5 bg-slate-800 border border-white/10 rounded-lg px-1 py-0.5 shadow-xl z-[60]">
                  <button onClick={() => startEdit(link)} className="p-1 text-white/60 hover:text-teal-400 transition-colors" title="አርትዕ">✎</button>
                  <button onClick={() => handleDelete(link.id)} className="p-1 text-white/60 hover:text-red-400 transition-colors" title="ሰርዝ">✕</button>
                </div>
              </div>
            ))}
            {/* Add Button */}
            <button onClick={openAdd} className="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-teal-400 hover:bg-teal-500/10 transition-all duration-200" title="አዲስ ማገናኛ ጨምር">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
          </div>

          {/* Notification Bell with Duplicate Warning */}
          <button 
            onClick={() => navigate('/notifications')} 
            className="relative p-2 rounded-full hover:bg-white/10 transition-all duration-200 group" 
            title="Notifications & Duplicates"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-slate-600 dark:text-slate-400 group-hover:text-white transition-colors">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {undoneTaskCount > 0 && <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white dark:ring-slate-900 animate-pulse" />}
          </button>

          {/* User Avatar */}
          <button onClick={() => navigate('/settings')} className="w-9 h-9 rounded-full bg-gradient-to-br from-teal-500 to-teal-600 flex items-center justify-center text-white font-semibold text-sm shadow-lg shadow-teal-500/25 ring-2 ring-white dark:ring-slate-800 transition-all duration-200 hover:scale-105" title="ማስተካከያዎች">A</button>

          <FileTray capturedFiles={capturedFiles} setCapturedFiles={setCapturedFiles} />
        </div>
      </nav>

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div ref={modalRef} className="glass-panel p-6 w-full max-w-md mx-4 animate-fade-in-up">
            <h3 className="text-lg font-bold mb-4">{editingLink ? 'ማገናኛ አርትዕ' : 'አዲስ ማገናኛ ጨምር'}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold mb-1 text-slate-400">ስም</label>
                <input value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="ለምሳሌ: Google" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-teal-500/50" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1 text-slate-400">URL</label>
                <input value={formData.url} onChange={e => setFormData({...formData, url: e.target.value})} placeholder="https://google.com" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-teal-500/50" onKeyDown={e => e.key === 'Enter' && handleSave()} />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={handleSave} disabled={loading || !formData.name.trim() || !formData.url.trim()} className="flex-1 py-2 bg-teal-500 text-white rounded-lg text-sm font-bold hover:bg-teal-400 disabled:opacity-50 transition-all">
                {loading ? '...' : editingLink ? 'አስቀምጥ' : 'ጨምር'}
              </button>
              <button onClick={() => { setShowAddModal(false); setEditingLink(null) }} className="flex-1 py-2 bg-white/5 text-white/70 rounded-lg text-sm font-bold hover:bg-white/10 transition-all">ሰርዝ</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
