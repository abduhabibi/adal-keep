import { useState, useEffect } from 'react'
import api from '../services/api'
import toast from 'react-hot-toast'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import Select from '../components/shared/Select'

const STATUS_COLUMNS = [
  { id: 'todo', label: 'ለመስራት', color: 'border-yellow-500/40', bg: 'bg-yellow-500/5', badge: 'bg-yellow-500/20 text-yellow-300' },
  { id: 'in_progress', label: 'በሂደት ላይ', color: 'border-blue-500/40', bg: 'bg-blue-500/5', badge: 'bg-blue-500/20 text-blue-300' },
  { id: 'done', label: 'ተጠናቋል', color: 'border-green-500/40', bg: 'bg-green-500/5', badge: 'bg-green-500/20 text-green-300' }
]

const PRIORITIES = [
  { value: 'low', label: 'ዝቅተኛ', dot: 'bg-gray-400' },
  { value: 'medium', label: 'መካከለኛ', dot: 'bg-yellow-400' },
  { value: 'high', label: 'ከፍተኛ', dot: 'bg-red-400' }
]

export default function TasksPage() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [selectedTask, setSelectedTask] = useState(null)
  const [draggedTaskId, setDraggedTaskId] = useState(null)
  const [dragOverColumn, setDragOverColumn] = useState(null)
  const [newTask, setNewTask] = useState({ title: '', description: '', priority: 'medium', due_date: '' })

  const fetchTasks = async () => {
    try {
      const res = await api.get('/tasks')
      setTasks(res.data)
    } catch (err) {
      console.error('Fetch tasks error:', err)
      toast.error('ተግባሮችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchTasks() }, [])

  // --- Drag & Drop ---
  const handleDragStart = (e, taskId) => {
    setDraggedTaskId(taskId)
    e.dataTransfer.effectAllowed = 'move'
    e.target.style.opacity = '0.5'
  }

  const handleDragEnd = (e) => {
    e.target.style.opacity = '1'
    setDraggedTaskId(null)
    setDragOverColumn(null)
  }

  const handleDragOver = (e, columnId) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverColumn(columnId)
  }

  const handleDragLeave = () => setDragOverColumn(null)

  const handleDrop = async (e, newStatus) => {
    e.preventDefault()
    setDragOverColumn(null)
    if (!draggedTaskId) return

    const task = tasks.find(t => t.id === draggedTaskId)
    if (!task || task.status === newStatus) { setDraggedTaskId(null); return }

    setTasks(prev => prev.map(t => t.id === draggedTaskId ? { ...t, status: newStatus } : t))
    setDraggedTaskId(null)

    try {
      await api.put(`/tasks/${draggedTaskId}`, { status: newStatus })
      toast.success('ተግባር ተዘውሯል')
    } catch {
      setTasks(prev => prev.map(t => t.id === draggedTaskId ? { ...t, status: task.status } : t))
      toast.error('ማዘመን አልተቻለም')
    }
  }

  // --- CRUD ---
  const createTask = async () => {
    if (!newTask.title.trim()) return toast.error('ርዕስ ያስፈልጋል')
    try {
      await api.post('/tasks', newTask)
      toast.success('ተግባር ተፈጥሯል')
      setShowCreateModal(false)
      setNewTask({ title: '', description: '', priority: 'medium', due_date: '' })
      fetchTasks()
    } catch (err) {
      console.error('Create task error:', err)
      toast.error('ተግባር መፍጠር አልተቻለም')
    }
  }

  const deleteTask = async (taskId) => {
    if (!confirm('ይህን ተግባር መሰረዝ እርግጠኛ ነዎት?')) return
    try {
      await api.delete(`/tasks/${taskId}`)
      setTasks(prev => prev.filter(t => t.id !== taskId))
      if (selectedTask?.id === taskId) setSelectedTask(null)
      toast.success('ተሰርዟል')
    } catch {
      toast.error('መሰረዝ አልተቻለም')
    }
  }

  const updateTaskField = async (taskId, field, value) => {
    try {
      await api.put(`/tasks/${taskId}`, { [field]: value })
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, [field]: value } : t))
      if (selectedTask?.id === taskId) setSelectedTask(prev => ({ ...prev, [field]: value }))
    } catch {
      toast.error('ማዘመን አልተቻለም')
    }
  }

  const getPriority = (p) => PRIORITIES.find(x => x.value === p) || PRIORITIES[1]

  // --- Loading Skeleton ---
  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <div className="h-8 w-48 bg-white/5 rounded animate-pulse" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <div key={i} className="h-96 bg-white/5 rounded-xl animate-pulse" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold font-display">ተግባሮች</h1>
          <p className="text-sm text-white/50 mt-1">ተግባሮችን ይፍጠሩ፣ ይጎትቱ እና ያስተዳድሩ</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="px-5 py-2.5 bg-teal-500 hover:bg-teal-400 text-white rounded-xl font-semibold text-sm transition-all hover:scale-105 active:scale-95 shadow-lg shadow-teal-500/25 flex items-center gap-2"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          አዲስ ተግባር
        </button>
      </div>

      {/* Kanban Board */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start flex-1 min-h-0">
        {STATUS_COLUMNS.map(col => {
          const colTasks = tasks.filter(t => t.status === col.id)
          const isOver = dragOverColumn === col.id
          return (
            <div
              key={col.id}
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, col.id)}
              className={`rounded-xl border-2 border-dashed p-4 transition-all duration-200 min-h-[300px] ${
                isOver ? `${col.color} ${col.bg} scale-[1.02] shadow-lg` : 'border-white/10 bg-white/[0.02]'
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  {col.label}
                  <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${col.badge}`}>{colTasks.length}</span>
                </h3>
              </div>

              <div className="space-y-2">
                {colTasks.map(task => {
                  const prio = getPriority(task.priority)
                  const isDragging = draggedTaskId === task.id
                  return (
                    <div
                      key={task.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, task.id)}
                      onDragEnd={handleDragEnd}
                      onClick={() => setSelectedTask(task)}
                      className={`glass-panel p-3 cursor-pointer group select-none transition-all duration-200 relative ${
                        isDragging ? 'opacity-40 scale-95 rotate-2' : 'hover:translate-y-[-2px] hover:shadow-md hover:border-teal-500/30'
                      }`}
                    >
                      <div className="flex justify-between items-start gap-2 mb-1.5">
                        <h4 className="text-sm font-medium leading-snug line-clamp-2 flex-1">{task.title}</h4>
                        {/* Task Card Delete Button */}
                        <button
                          onClick={(e) => { e.stopPropagation(); deleteTask(task.id) }}
                          className="opacity-0 group-hover:opacity-100 text-white/40 hover:text-red-400 transition-all p-1 rounded hover:bg-red-500/10 shrink-0"
                          title="ሰርዝ"
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                      {task.description && <p className="text-xs text-white/50 mb-2 line-clamp-2">{task.description}</p>}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-2 h-2 rounded-full ${prio.dot}`} />
                          <span className="text-[11px] text-white/50">{prio.label}</span>
                        </div>
                        {task.due_date && (
                          <span className="text-[11px] text-white/40">
                            {new Date(task.due_date).toLocaleDateString('am-ET', { month: 'short', day: 'numeric' })}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}

                {colTasks.length === 0 && !isOver && (
                  <div className="text-center py-12 border-2 border-dashed border-white/5 rounded-lg">
                    <p className="text-xs text-white/20">ተግባር ወደዚህ ይጎትቱ</p>
                  </div>
                )}
                {isOver && (
                  <div className="border-2 border-dashed border-current rounded-lg p-6 text-center opacity-50">
                    <p className="text-xs font-medium">እዚህ ይልቀቁ</p>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* ==================== CREATE MODAL ==================== */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowCreateModal(false)} />
          <div className="glass-panel w-full max-w-lg relative z-[9999] animate-fade-in-up p-6 space-y-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">አዲስ ተግባር ፍጠር</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-white/40 hover:text-white p-1">✕</button>
            </div>
            <Input label="ርዕስ *" value={newTask.title} onChange={e => setNewTask({ ...newTask, title: e.target.value })} placeholder="የተግባር ርዕስ" autoFocus />
            <div>
              <label className="label">መግለጫ</label>
              <textarea value={newTask.description} onChange={e => setNewTask({ ...newTask, description: e.target.value })} className="field min-h-[80px] resize-y" placeholder="ተጨማሪ ዝርዝር..." />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Select label="ቅድሚያ" value={newTask.priority} onChange={e => setNewTask({ ...newTask, priority: e.target.value })} options={PRIORITIES} />
              <Input label="የማብቂያ ቀን" type="date" value={newTask.due_date} onChange={e => setNewTask({ ...newTask, due_date: e.target.value })} />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={createTask} className="flex-1">ፍጠር</Button>
              <Button variant="secondary" onClick={() => setShowCreateModal(false)} className="flex-1">ሰርዝ</Button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== TASK DETAIL MODAL ==================== */}
      {selectedTask && (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedTask(null)} />
          <div className="glass-panel w-full max-w-2xl relative z-[9999] animate-fade-in-up overflow-hidden">
            {/* Detail Header */}
            <div className="p-6 border-b border-white/10 flex items-start justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <span className={`text-xs px-2.5 py-1 rounded-full font-bold ${
                    selectedTask.status === 'done' ? 'bg-green-500/20 text-green-300' :
                    selectedTask.status === 'in_progress' ? 'bg-blue-500/20 text-blue-300' :
                    'bg-yellow-500/20 text-yellow-300'
                  }`}>
                    {STATUS_COLUMNS.find(c => c.id === selectedTask.status)?.label}
                  </span>
                  {selectedTask.is_ai_created && (
                    <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full font-medium">🤖 AI</span>
                  )}
                </div>
                <h2 className="text-xl font-bold">{selectedTask.title}</h2>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {/* Header Action: Trash Icon Button */}
                <button
                  onClick={() => deleteTask(selectedTask.id)}
                  className="p-2 text-white/40 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all"
                  title="ሰርዝ"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
                <button onClick={() => setSelectedTask(null)} className="p-2 text-white/40 hover:text-white hover:bg-white/10 rounded-lg transition-all">✕</button>
              </div>
            </div>

            {/* Detail Body */}
            <div className="p-6 space-y-5 max-h-[60vh] overflow-y-auto custom-scrollbar">
              {/* Description */}
              <div>
                <label className="label mb-1">መግለጫ</label>
                <textarea
                  value={selectedTask.description || ''}
                  onChange={(e) => updateTaskField(selectedTask.id, 'description', e.target.value)}
                  className="field min-h-[100px] resize-y"
                  placeholder="መግለጫ ያስገቡ..."
                />
              </div>

              {/* Editable Fields Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label mb-1">ሁኔታ</label>
                  <select
                    value={selectedTask.status}
                    onChange={(e) => updateTaskField(selectedTask.id, 'status', e.target.value)}
                    className="field"
                  >
                    {STATUS_COLUMNS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label mb-1">ቅድሚያ</label>
                  <select
                    value={selectedTask.priority}
                    onChange={(e) => updateTaskField(selectedTask.id, 'priority', e.target.value)}
                    className="field"
                  >
                    {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label mb-1">የማብቂያ ቀን</label>
                  <input
                    type="date"
                    value={selectedTask.due_date || ''}
                    onChange={(e) => updateTaskField(selectedTask.id, 'due_date', e.target.value)}
                    className="field"
                  />
                </div>
                <div>
                  <label className="label mb-1">የተፈጠረበት</label>
                  <p className="text-sm text-white/50 py-2">
                    {new Date(selectedTask.created_at).toLocaleDateString('am-ET', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            </div>

            {/* Detail Footer with Explicit Delete Action */}
            <div className="p-4 border-t border-white/10 flex justify-between items-center">
              <button
                onClick={() => deleteTask(selectedTask.id)}
                className="px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 rounded-xl font-medium text-sm transition-all flex items-center gap-2"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                ተግባር ሰርዝ
              </button>
              <Button variant="secondary" onClick={() => setSelectedTask(null)}>ዝጋ</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}