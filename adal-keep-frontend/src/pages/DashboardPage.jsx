import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import api from '../services/api'

export default function DashboardPage() {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [dashRes, tasksRes] = await Promise.all([
          api.get('/dashboard'),
          api.get('/tasks')
        ])
        const tasks = tasksRes.data
        setStats({
          ...dashRes.data,
          tasksTodo: tasks.filter(t => t.status === 'todo').length,
          tasksInProgress: tasks.filter(t => t.status === 'in_progress').length,
          tasksDone: tasks.filter(t => t.status === 'done').length,
          totalTasks: tasks.length
        })
      } catch {}
      finally { setLoading(false) }
    }
    load()
  }, [])

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-white/5 rounded animate-pulse" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-32 bg-white/5 rounded-xl animate-pulse" />)}
        </div>
      </div>
    )
  }

  const cards = [
    { label: 'ፕሮፋይሎች', value: stats?.totalProfiles ?? 0, color: 'from-teal-500 to-teal-600', link: '/profiles' },
    { label: 'ደላሎች', value: stats?.totalBrokers ?? 0, color: 'from-blue-500 to-blue-600', link: '/brokers' },
    { label: 'ተግባሮች (ለመስራት)', value: stats?.tasksTodo ?? 0, color: 'from-yellow-500 to-orange-500', link: '/tasks' },
    { label: 'ተግባሮች (በሂደት)', value: stats?.tasksInProgress ?? 0, color: 'from-purple-500 to-purple-600', link: '/tasks' },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold font-display">ዳሽቦርድ</h1>
        <p className="text-muted text-sm mt-1">የስርዓት አጠቃላይ እይታ</p>
      </div>

      {/* Quick Links */}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card, i) => (
          <Link
            key={i}
            to={card.link}
            className="glass-panel p-5 hover:scale-[1.02] transition-all duration-300 group"
          >
            <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${card.color} flex items-center justify-center text-white font-bold text-lg mb-3 group-hover:shadow-lg transition-shadow`}>
              {card.value}
            </div>
            <p className="text-sm font-medium">{card.label}</p>
          </Link>
        ))}
      </div>

      {/* Recent Profiles */}
      <div className="glass-panel p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">የቅርብ ጊዜ ፕሮፋይሎች</h2>
          <Link to="/profiles" className="text-xs text-teal-400 hover:text-teal-300 transition-colors">ሁሉንም ይመልከቱ →</Link>
        </div>
        {stats?.recent?.length > 0 ? (
          <div className="space-y-2">
            {stats.recent.map(profile => (
              <Link
                key={profile.id}
                to={`/profiles/${profile.id}`}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-white/5 transition-colors group"
              >
                <div>
                  <p className="text-sm font-medium group-hover:text-teal-400 transition-colors">{profile.full_name}</p>
                  <p className="text-xs text-muted">{profile.phone_number}</p>
                </div>
                <div className="flex items-center gap-2">
                  {profile.broker_name && (
                    <span className="text-xs bg-white/5 px-2 py-0.5 rounded">{profile.broker_name}</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    profile.status === 'completed' ? 'bg-green-500/20 text-green-300' :
                    profile.status === 'in_progress' ? 'bg-blue-500/20 text-blue-300' :
                    'bg-yellow-500/20 text-yellow-300'
                  }`}>
                    {profile.status === 'completed' ? 'ተጠናቋል' :
                     profile.status === 'in_progress' ? 'በሂደት' : 'በመጠባበቅ'}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted text-center py-8">ምንም ፕሮፋይል የለም</p>
        )}
      </div>
    </div>
  )
}
