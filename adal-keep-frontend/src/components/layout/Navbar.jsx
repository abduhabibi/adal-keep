import { useState, useEffect, useRef } from 'react'
import FileTray from '../FileTray'
import { useLocation, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import toast from 'react-hot-toast'
import { beep } from '../AttentionBar'

export default function Navbar({ onMenuClick, capturedFiles, setCapturedFiles }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [undoneTaskCount, setUndoneTaskCount] = useState(0)
  // A new notification (a task) rings, like the calls above the page.
  const lastCount = useRef(null)
  useEffect(() => { if (lastCount.current !== null && undoneTaskCount > lastCount.current) beep(); lastCount.current = undoneTaskCount }, [undoneTaskCount])
  const [quickLinks, setQuickLinks] = useState([])
  const [showAddModal, setShowAddModal] = useState(false)
  const [editingLink, setEditingLink] = useState(null)
  const [formData, setFormData] = useState({ name: '', url: '' })
  const [loading, setLoading] = useState(false)
  const modalRef = useRef(null)

  useEffect(() => {
    const fetchCount = async () => {
      try {
        // Just the number (the whole list with every task's text was fetched
        // every 10 s); a phone's offline copy has only the list.
        const c = await api.get('/tasks/count').catch(() => null)
        if (typeof c?.data?.undone === 'number') return setUndoneTaskCount(c.data.undone)
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
    if (path.startsWith('/chat')) return 'ቻት'
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
      <nav className="ak-top px-4 sm:px-6 h-14 flex items-center justify-between relative z-50">
        <div className="flex items-center gap-4">
          <button onClick={onMenuClick} className="md:hidden p-2 text-slate-500 dark:text-slate-400 rounded-lg hover:bg-white/10 transition-all" aria-label="ሜኑ">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div className="hidden sm:block">
            <div className="flex items-baseline gap-2 text-sm">
              <span className="font-bold text-slate-900 dark:text-white">{getPageName()}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Quick Links Bar */}
          <div className="hidden md:flex items-center gap-1 mr-2 pr-3 border-r border-slate-200 dark:border-white/10">
            {quickLinks.map((link) => (
              <div key={link.id} className="group relative">
                <a
                  href={link.url.startsWith('http') ? link.url : `https://${link.url}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ak-icon-btn"
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
            <button onClick={openAdd} className="ak-icon-btn" title="አዲስ ማገናኛ ጨምር">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            {/* The girls an employer chose (the Selected step on Profiles). */}
            <button type="button" onClick={() => navigate('/profiles?chosen=1')} title="See the selected profiles (chosen by an employer)"
              className="ak-icon-btn">✓ የተመረጡ</button>
            <BackupButton />
          </div>

          <InboxButton />

          {/* Notification Bell with Duplicate Warning */}
          <button 
            onClick={() => navigate('/notifications')} 
            className="ak-icon-btn relative group" 
            title="Notifications & Duplicates"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            {undoneTaskCount > 0 && <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full ring-2 ring-white dark:ring-slate-900 animate-pulse" />}
          </button>

          {/* User Avatar */}
          <button onClick={() => navigate('/settings')} className="w-8 h-8 rounded-full overflow-hidden shadow ring-1 ring-black/10 dark:ring-white/20 transition-transform duration-200 hover:scale-105" title="ማስተካከያዎች"><img src="/adal-logo.png" alt="Adal" className="h-full w-full object-cover" draggable={false} /></button>

          <FileTray capturedFiles={capturedFiles} setCapturedFiles={setCapturedFiles} />
        </div>
      </nav>

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div ref={modalRef} className="panel p-6 w-full max-w-md mx-4 animate-fade-in-up">
            <h3 className="text-lg font-bold mb-4">{editingLink ? 'ማገናኛ አርትዕ' : 'አዲስ ማገናኛ ጨምር'}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold mb-1 text-slate-400">ስም</label>
                <input value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="ለምሳሌ: Google" className="field" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1 text-slate-400">URL</label>
                <input value={formData.url} onChange={e => setFormData({...formData, url: e.target.value})} placeholder="https://google.com" className="field" onKeyDown={e => e.key === 'Enter' && handleSave()} />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={handleSave} disabled={loading || !formData.name.trim() || !formData.url.trim()} className="flex-1 py-2 bg-teal-600 text-white rounded-lg text-sm font-bold disabled:opacity-50">
                {loading ? '...' : editingLink ? 'አስቀምጥ' : 'ጨምር'}
              </button>
              <button onClick={() => { setShowAddModal(false); setEditingLink(null) }} className="flex-1 py-2 bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-white/70 rounded-lg text-sm font-bold hover:bg-slate-200 dark:hover:bg-white/10">ሰርዝ</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** Red "Inbox" while chat messages wait unread (Adal, the other agencies, groups). */
/** Backs up to Telegram now (the main PC), with its progress in one notice. */
function BackupButton() {
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(null)
  const watch = useRef(null)
  useEffect(() => () => clearInterval(watch.current), [])
  const follow = () => {
    clearInterval(watch.current)
    const id = 'backup-now'
    watch.current = setInterval(async () => {
      try {
        const { data } = await api.get('/backup')
        const p = data.progress || {}
        if (p.running) {
          const docs = p.files_todo ? ` · ${p.files_done || 0} of ${p.files_todo} new documents` : ''
          setPct(p.percent ?? null)
          toast.loading(`💾 Backing up${p.percent != null ? ` ${p.percent}%` : ''} — ${p.step === 'database' ? 'the database' : p.step === 'index' ? 'finishing' : 'documents'}${docs}`, { id })
          return
        }
        clearInterval(watch.current); setBusy(false); setPct(null)
        if (p.error) toast.error(`Backup stopped: ${p.error}`, { id, duration: 8000 })
        else toast.success(`💾 Backed up · ${data.files_sent ?? '?'} of ${data.files_total ?? '?'} documents online`, { id, duration: 6000 })
      } catch { clearInterval(watch.current); setBusy(false) }
    }, 2000)
  }
  const run = async () => {
    if (busy) return
    setBusy(true)
    try {
      const { data } = await api.post('/backup/run')
      // The main PC is off or far: the request waits and goes by itself.
      if (data.queued && !data.busy) { setBusy(false); toast(data.message || 'The backup starts as soon as the main PC answers.', { id: 'backup-now', icon: '☁️', duration: 8000 }); return }
      toast.loading(data.busy ? '💾 A backup is already running…' : '💾 Backup started…', { id: 'backup-now' })
      follow()
    } catch (e) {
      setBusy(false)
      toast.error(e.response?.data?.error || 'The backup did not start', { id: 'backup-now', duration: 7000 })
    }
  }
  return (
    <button onClick={run} disabled={busy} title="Back up now: to Telegram, or to the online storage when Telegram does not answer (it also runs by itself)"
      className={`ak-icon-btn ${busy ? '!text-teal-600 bg-teal-500/10' : ''}`}>
      <span className={busy ? 'animate-pulse' : ''}>💾</span> {busy ? `ምትኬ በመያዝ ላይ${pct != null ? ` ${pct}%` : '…'}` : 'ምትኬ'}
    </button>
  )
}

function InboxButton() {
  const navigate = useNavigate()
  const location = useLocation()
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () => api.get('/chat/conversations')
      .then(r => { if (alive) setN((r.data || []).reduce((t, c) => t + Number(c.unread || 0), 0)) })
      .catch(() => {})
    load()
    const t = setInterval(load, 20000)
    return () => { alive = false; clearInterval(t) }
  }, [location.pathname])
  if (!n || location.pathname.startsWith('/chat')) return null
  return (
    <button onClick={() => navigate('/chat')} title={`${n} unread message${n === 1 ? '' : 's'}`}
      className="flex items-center gap-1.5 rounded-full bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 text-xs font-bold shadow-sm">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></svg>
      የገቢ መልእክት <span className="rounded-full bg-white text-red-600 px-1.5 leading-4">{n > 99 ? '99+' : n}</span>
    </button>
  )
}
