import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'

export default function BrokersPage() {
  const navigate = useNavigate()
  const [brokers, setBrokers] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [brokersRes, profilesRes] = await Promise.all([
        api.get('/brokers'),
        api.get('/profiles')
      ])
      setBrokers(brokersRes.data || [])
      setProfiles(profilesRes.data || [])
    } catch (err) {
      toast.error('ደላሎችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }

  const filtered = brokers.filter(b =>
    (b.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (b.contact1 || '').includes(search)
  )

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="ደላሎች"
        subtitle="ሁሉም ደላሎች · ለዝርዝር ጠቅ ያድርጉ"
        action={
          <div className="w-64">
            <Input
              placeholder="ደላላ ይፈልጉ..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        }
      />

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          {search ? 'ምንም ደላላ አልተገኘም' : 'እስካሁን ደላላ የለም · ከሰራተኞች ገጽ ይፍጠሩ'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(broker => {
            const count = profiles.filter(p => p.broker_id === broker.id).length
            return (
              <button
                key={broker.id}
                onClick={() => navigate(`/brokers/${broker.id}`)}
                className="text-left panel p-5 border border-slate-200 dark:border-slate-700 rounded-2xl hover:border-teal-400 hover:shadow-md transition-all group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-bold text-slate-800 dark:text-white text-lg truncate group-hover:text-teal-600 transition-colors">
                      {broker.name}
                    </h3>
                    <p className="text-sm text-slate-500 mt-1 truncate">
                      {broker.contact1 || 'ስልክ የለም'}
                    </p>
                    {broker.address && (
                      <p className="text-xs text-slate-400 mt-0.5 truncate">{broker.address}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs font-medium bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400 px-2.5 py-1 rounded-full">
                    {count} ፕሮፋይል
                  </span>
                </div>
                <div className="mt-4 text-xs text-teal-600 dark:text-teal-400 opacity-0 group-hover:opacity-100 transition-opacity">
                  ዝርዝር ለማየት ጠቅ ያድርጉ →
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
