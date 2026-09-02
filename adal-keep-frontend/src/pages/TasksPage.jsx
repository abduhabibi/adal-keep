import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import Spinner from '../components/shared/Spinner'

const COLUMNS = [
  { key: 'pending', label: 'ለመሰራት', color: 'amber' },
  { key: 'in_progress', label: 'በሂደት ላይ', color: 'blue' },
  { key: 'completed', label: 'ተጠናቋል', color: 'emerald' }
]

function normalizeStatus(s) {
  if (!s) return 'pending'
  if (s === 'todo' || s === 'open') return 'pending'
  if (s === 'ongoing') return 'in_progress'
  if (s === 'done') return 'completed'
  return s
}

export default function TasksPage() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [dragId, setDragId] = useState(null)
  const [overCol, setOverCol] = useState(null)

  const load = async () => {
    try {
      const res = await api.get('/tasks')
      setTasks(Array.isArray(res.data) ? res.data : [])
    } catch {
      toast.error('ተግባሮችን መጫን አልተቻለም')
      setTasks([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') load()
    })
    const id = setInterval(load, 15000)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(id)
    }
  }, [])

  const approve = async (id) => {
    setBusyId(id)
    try {
      const res = await api.post(`/ai-tasks/${id}/approve`)
      toast.success(res.data.message || 'ጸድቋል')
      await load()
    } catch (e) {
      toast.error(e.response?.data?.error || 'Approve failed')
    } finally {
      setBusyId(null)
    }
  }

  const reject = async (id) => {
    if (!confirm('ይህ ተግባር ይቀር?')) return
    setBusyId(id)
    try {
      await api.post(`/ai-tasks/${id}/reject`)
      toast.success('ተቀርጧል')
      await load()
    } catch {
      toast.error('Reject failed')
    } finally {
      setBusyId(null)
    }
  }

  const removeAllCompleted = async () => {
    const done = tasks.filter(x => normalizeStatus(x.status) === 'completed')
    if (!done.length) return
    try {
      await Promise.all(done.map(x => api.delete(`/tasks/${x.id}`)))
      toast.success('Completed tasks cleared')
      await load()
    } catch {
      toast.error('Clear failed')
    }
  }

  const deleteTask = async (id) => {
    if (!confirm('ይህ ተግባር ይሰረዝ?')) return
    try {
      await api.delete(`/tasks/${id}`)
      toast.success('ተሰርዟል')
      await load()
    } catch {
      toast.error('Delete failed')
    }
  }

  const move = async (id, status) => {
    // optimistic
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status } : t))
    try {
      await api.patch(`/tasks/${id}`, { status })
    } catch {
      toast.error('Update failed')
      await load()
    }
  }

  const onDragStart = (e, id) => {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(id))
  }

  const onDragOver = (e, colKey) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverCol(colKey)
  }

  const onDrop = async (e, colKey) => {
    e.preventDefault()
    const id = Number(e.dataTransfer.getData('text/plain') || dragId)
    setOverCol(null)
    setDragId(null)
    if (!id) return
    const task = tasks.find(t => t.id === id)
    if (!task || normalizeStatus(task.status) === colKey) return
    await move(id, colKey)
  }

  const byCol = (key) => tasks.filter(t => normalizeStatus(t.status) === key)

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Spinner /></div>
  }

  return (
    <div className="animate-fade-up space-y-6 pb-12">
      <PageHeader
        title="ተግባሮች"
        subtitle="ተግባሮችን ይጎትቱ፣ ያጽድቁ እና ያጠናቁ"
        action={<Button onClick={load} variant="secondary">ዳግም ጫን</Button>}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {COLUMNS.map(col => {
          const list = byCol(col.key)
          const isOver = overCol === col.key
          return (
            <div
              key={col.key}
              onDragOver={(e) => onDragOver(e, col.key)}
              onDragLeave={() => setOverCol(null)}
              onDrop={(e) => onDrop(e, col.key)}
              className={`rounded-2xl border-2 border-dashed min-h-[320px] flex flex-col transition-colors ${
                isOver
                  ? 'border-teal-500 bg-teal-50/50 dark:bg-teal-900/20'
                  : 'border-slate-300 dark:border-slate-600 bg-slate-50/80 dark:bg-slate-900/40'
              }`}
            >
              <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
                <span className={`w-2.5 h-2.5 rounded-full ${
                  col.color === 'amber' ? 'bg-amber-400' :
                  col.color === 'blue' ? 'bg-blue-400' : 'bg-emerald-400'
                }`} />
                <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{col.label}</h3>
                <span className="ml-auto text-xs text-slate-500 flex items-center gap-2">
                  {col.key === 'completed' && list.length > 0 && (
                    <button
                      type="button"
                      className="text-[10px] text-red-600 hover:underline"
                      onClick={(e) => { e.stopPropagation(); removeAllCompleted() }}
                    >
                      Remove all
                    </button>
                  )}
                  {list.length}
                </span>
              </div>

              <div className="flex-1 p-3 space-y-3 overflow-y-auto">
                {list.length === 0 ? (
                  <p className="text-center text-sm text-slate-400 py-10">ተግባር የለም</p>
                ) : (
                  list.map(t => (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => onDragStart(e, t.id)}
                      onDragEnd={() => { setDragId(null); setOverCol(null) }}
                      className={`rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-sm cursor-grab active:cursor-grabbing ${
                        dragId === t.id ? 'opacity-50' : ''
                      }`}
                    >
                      <p className="font-medium text-sm text-slate-900 dark:text-white leading-snug">
                        {t.title}
                      </p>
                      {t.description && (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 whitespace-pre-wrap line-clamp-4">
                          {t.description}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1">
                        {t.type && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                            {t.type}
                          </span>
                        )}
                        {t.priority === 'high' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">high</span>
                        )}
                      </div>

                      {normalizeStatus(t.status) === 'completed' && (
                        <button
                          type="button"
                          className="mt-2 text-xs text-red-600 hover:underline"
                          onClick={(e) => { e.stopPropagation(); deleteTask(t.id) }}
                        >
                          ሰርዝ
                        </button>
                      )}


                      {(t.type === 'ai_create_profile' || t.type === 'ai_pextran_approval' || t.type === 'ai_file_checklist') && 
                       normalizeStatus(t.status) === 'pending' && (
                        <div className="mt-3 flex gap-2">
                          <Button size="sm" onClick={() => approve(t.id)} isLoading={busyId === t.id}>
                            አጽድቅ
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => reject(t.id)} disabled={busyId === t.id}>
                            ውድቅ
                          </Button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
