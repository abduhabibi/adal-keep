import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadNotifications()
    const interval = setInterval(loadNotifications, 30000)
    return () => clearInterval(interval)
  }, [])

  const loadNotifications = async () => {
    try {
      const res = await api.get('/notifications')
      setNotifications(res.data)
    } catch (err) {
      console.error('Failed to load notifications:', err)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.delete(`/notifications/${id}`)
      setNotifications(notifications.filter(n => n.id !== id))
      toast.success('ማሳወቂያ ተሰርዟል')
    } catch (err) {
      toast.error('ማሳወቂያ መሰረዝ አልተቻለም')
    }
  }

  const handleClearAll = async () => {
    if (!confirm('ሁሉም ማሳወቂያዎች ይሰረዙ?')) return
    try {
      await api.delete('/notifications/all')
      setNotifications([])
      toast.success('ሁሉም ማሳወቂያዎች ተጽድተዋል')
    } catch (err) {
      toast.error('ማሳወቂያዎችን ማጽዳት አልተቻለም')
    }
  }

  const getIcon = (type) => {
    switch (type) {
      case 'trial_warning': return '⏰'
      case 'trial_expired': return '⚠️'
      case 'ai_task': return '🤖'
      case 'employee_created': return '👤'
      case 'captha_detected': return '🔒'
      default: return '📢'
    }
  }

  const getUrgency = (type) => {
    if (type === 'trial_expired' || type === 'captha_detected') return 'high'
    if (type === 'trial_warning') return 'medium'
    return 'low'
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  return (
    <div className="animate-fade-up h-[calc(100vh-8rem)] flex flex-col">
      <PageHeader
        title="ማሳወቂያዎች"
        subtitle="AI ማሻሻያዎች፣ የስርዓት ማንቂያዎች እና የሰራተኛ መልእክቶች"
        action={
          notifications.length > 0 && (
            <button
              onClick={handleClearAll}
              className="px-4 py-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
            >
              ሁሉንም አጽዳ
            </button>
          )
        }
      />

      <div className="flex-1 overflow-y-auto p-6">
        {notifications.length === 0 ? (
          <div className="text-center py-12 text-slate-400 dark:text-slate-500">
            <div className="text-5xl mb-4">🔔</div>
            <p>ምንም ማሳወቂያ የለም</p>
          </div>
        ) : (
          <div className="space-y-3">
            {notifications.map(notif => {
              const urgency = getUrgency(notif.type)
              return (
                <div
                  key={notif.id}
                  className={`panel p-4 border rounded-xl transition-all ${
                    urgency === 'high' ? 'border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10' :
                    urgency === 'medium' ? 'border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10' :
                    'border-slate-200 dark:border-slate-700'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1">
                      <div className="text-2xl">{getIcon(notif.type)}</div>
                      <div className="flex-1">
                        <h3 className="font-semibold text-slate-800 dark:text-white">{notif.title}</h3>
                        <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">{notif.body}</p>
                        <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">
                          {new Date(notif.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDelete(notif.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors shrink-0"
                      title="ሰርዝ"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
