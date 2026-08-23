import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'
import Button from '../components/shared/Button'
import Modal from '../components/shared/Modal'

const COUNTRY_CODES = ['+251', '+966', '+971', '+974', '+965', '+249']
const digitsOnly = (v) => (v || '').replace(/\D/g, '').slice(0, 9)
const formatPhone = (v) => {
  const d = digitsOnly(v)
  if (d.length > 6) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`
  if (d.length > 3) return `${d.slice(0, 3)} ${d.slice(3)}`
  return d
}

function PhoneField({ label, cc, num, onChange }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">{label}</label>
      <div className="flex gap-2">
        <select
          value={cc}
          onChange={(e) => onChange({ cc: e.target.value, num })}
          className="w-24 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        >
          {COUNTRY_CODES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          inputMode="numeric"
          value={formatPhone(num)}
          onChange={(e) => onChange({ cc, num: digitsOnly(e.target.value) })}
          placeholder="9XX XXX XXX"
          className="flex-1 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        />
      </div>
    </div>
  )
}

const emptyEmp = {
  name: '', username: '',
  wa_cc: '+251', wa_num: '',
  work_cc: '+251', work_num: '',
  password: '', password2: ''
}

export default function EmployeesPage() {
  const navigate = useNavigate()
  const { setCurrentUser } = useAuth()

  const [employees, setEmployees] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // Password gate
  const [gateEmployee, setGateEmployee] = useState(null)
  const [gatePassword, setGatePassword] = useState('')
  const [gateLoading, setGateLoading] = useState(false)

  // Active workspace
  const [active, setActive] = useState(null)
  const [myBrokers, setMyBrokers] = useState([])
  const [myProfiles, setMyProfiles] = useState([])
  const [wsLoading, setWsLoading] = useState(false)

  // Employee modal (create / edit)
  const [empModal, setEmpModal] = useState(false)
  const [editingEmp, setEditingEmp] = useState(null)
  const [empForm, setEmpForm] = useState(emptyEmp)
  const [empSaving, setEmpSaving] = useState(false)

  // Broker modal (create / edit)
  const [brokerModal, setBrokerModal] = useState(false)
  const [editingBroker, setEditingBroker] = useState(null)
  const [brokerForm, setBrokerForm] = useState({ name: '', contact1: '', address: '' })
  const [brokerSaving, setBrokerSaving] = useState(false)

  useEffect(() => { loadEmployees() }, [])

  const loadEmployees = async () => {
    setLoading(true)
    try {
      const res = await api.get('/employees')
      setEmployees(res.data || [])
    } catch {
      toast.error('ሰራተኞችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }

  // ---------- PASSWORD GATE ----------
  const openGate = (emp) => {
    setGateEmployee(emp)
    setGatePassword('')
  }

  const submitGate = async (e) => {
    e.preventDefault()
    if (!gatePassword) return toast.error('የይለፍ ቃል ያስገቡ')
    setGateLoading(true)
    try {
      const res = await api.post('/auth/login', {
        username: gateEmployee.username,
        password: gatePassword
      })
      setCurrentUser(res.data)
      setActive(gateEmployee)
      setGateEmployee(null)
      setGatePassword('')
      toast.success(`እንኳን ደህና መጡ፣ ${gateEmployee.name}`)
      loadWorkspace(gateEmployee)
    } catch (err) {
      toast.error(err.response?.data?.error || 'የይለፍ ቃል ትክክል አይደለም')
    } finally {
      setGateLoading(false)
    }
  }

  // ---------- WORKSPACE ----------
  const loadWorkspace = async (emp) => {
    setWsLoading(true)
    try {
      const [bRes, pRes] = await Promise.all([
        api.get('/brokers'),
        api.get('/profiles')
      ])
      const allBrokers = bRes.data || []
      const allProfiles = pRes.data || []
      const name = (emp.name || emp.full_name || '').trim()
      const mine = allProfiles.filter(p => (p.created_by || '').trim() === name)
      setMyProfiles(mine)
      setMyBrokers(allBrokers) // show all for now; later filter by creator
    } catch {
      toast.error('መረጃ መጫን አልተቻለም')
    } finally {
      setWsLoading(false)
    }
  }

  const exitWorkspace = async () => {
    try { await api.post('/auth/logout') } catch {}
    setCurrentUser(null)
    setActive(null)
    setMyBrokers([])
    setMyProfiles([])
  }

  // ---------- EMPLOYEE CRUD ----------
  const openCreateEmp = () => {
    setEditingEmp(null)
    setEmpForm(emptyEmp)
    setEmpModal(true)
  }

  const openEditEmp = (emp) => {
    setEditingEmp(emp)
    setEmpForm({
      name: emp.name || '',
      username: emp.username || '',
      wa_cc: '+251',
      wa_num: (emp.phone_whatsapp || '').replace(/\D/g, '').slice(-9),
      work_cc: '+251',
      work_num: (emp.phone_work || '').replace(/\D/g, '').slice(-9),
      password: '',
      password2: ''
    })
    setEmpModal(true)
  }

  const saveEmployee = async (e) => {
    e.preventDefault()
    if (!empForm.name.trim()) return toast.error('ስም ያስፈልጋል')
    if (!empForm.username.trim() || /\s/.test(empForm.username)) return toast.error('መለያ ስም ያለ ክፍተት')
    if (!editingEmp && empForm.password.length < 4) return toast.error('የይለፍ ቃል ቢያንስ 4 ቁምፊ')
    if (empForm.password && empForm.password !== empForm.password2) return toast.error('የይለፍ ቃሎች አይመሳሰሉም')

    setEmpSaving(true)
    try {
      const payload = {
        name: empForm.name.trim(),
        username: empForm.username.trim(),
        phone_whatsapp: empForm.wa_num ? `${empForm.wa_cc}${digitsOnly(empForm.wa_num)}` : '',
        phone_work: empForm.work_num ? `${empForm.work_cc}${digitsOnly(empForm.work_num)}` : ''
      }
      if (empForm.password) payload.password = empForm.password

      if (editingEmp) {
        await api.put(`/employees/${editingEmp.id}`, payload)
        toast.success('ሰራተኛ ተዘምኗል')
      } else {
        await api.post('/employees', payload)
        toast.success('ሰራተኛ ተፈጥሯል')
      }
      setEmpModal(false)
      loadEmployees()
    } catch (err) {
      toast.error(err.response?.data?.error || 'መቀመጥ አልተቻለም')
    } finally {
      setEmpSaving(false)
    }
  }

  const deleteEmployee = async (emp) => {
    if (!confirm(`"${emp.name}" ይሰረዝ?\n\nፕሮፋይሎቹ አይጠፉም።`)) return
    try {
      await api.delete(`/employees/${emp.id}`)
      toast.success('ተሰርዟል (ፕሮፋይሎች ተጠብቀዋል)')
      if (active?.id === emp.id) exitWorkspace()
      loadEmployees()
    } catch {
      toast.error('መሰረዝ አልተቻለም')
    }
  }

  // ---------- BROKER CRUD ----------
  const openCreateBroker = () => {
    setEditingBroker(null)
    setBrokerForm({ name: '', contact1: '', address: '' })
    setBrokerModal(true)
  }

  const openEditBroker = (b) => {
    setEditingBroker(b)
    setBrokerForm({
      name: b.name || '',
      contact1: b.contact1 || '',
      address: b.address || ''
    })
    setBrokerModal(true)
  }

  const saveBroker = async (e) => {
    e.preventDefault()
    if (!brokerForm.name.trim()) return toast.error('የደላላ ስም ያስፈልጋል')
    setBrokerSaving(true)
    try {
      if (editingBroker) {
        await api.put(`/brokers/${editingBroker.id}`, brokerForm)
        toast.success('ደላላ ተዘምኗል')
      } else {
        await api.post('/brokers', brokerForm)
        toast.success('ደላላ ተፈጥሯል')
      }
      setBrokerModal(false)
      if (active) loadWorkspace(active)
    } catch (err) {
      toast.error(err.response?.data?.error || 'መቀመጥ አልተቻለም')
    } finally {
      setBrokerSaving(false)
    }
  }

  const deleteBroker = async (b) => {
    if (!confirm(`"${b.name}" ይሰረዝ?\n\nፕሮፋይሎቹ አይጠፉም (ከደላላው ብቻ ይላቀቃሉ)።`)) return
    try {
      // Un-assign only
      const linked = myProfiles.filter(p => p.broker_id === b.id)
      for (const p of linked) {
        await api.put(`/profiles/${p.id}`, { broker_id: null })
      }
      await api.delete(`/brokers/${b.id}`)
      toast.success('ደላላ ተሰርዟል (ፕሮፋይሎች ተጠብቀዋል)')
      if (active) loadWorkspace(active)
    } catch {
      toast.error('መሰረዝ አልተቻለም')
    }
  }

  const filtered = employees.filter(e =>
    (e.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (e.username || '').toLowerCase().includes(search.toLowerCase())
  )

  // ===================== RENDER =====================

  if (loading) {
    return <div className="flex h-64 items-center justify-center"><Spinner /></div>
  }

  // ===== WORKSPACE VIEW =====
  if (active) {
    return (
      <div className="animate-fade-up space-y-8">
        <PageHeader
          title={`${active.name}`}
          subtitle="የስራ ቦታ · ደላሎች እና ፕሮፋይሎች"
          action={
            <div className="flex gap-2">
              <Button onClick={openCreateBroker}>+ ደላላ አክል</Button>
              <Button variant="secondary" onClick={exitWorkspace}>ውጣ</Button>
            </div>
          }
        />

        {wsLoading ? (
          <div className="flex h-40 items-center justify-center"><Spinner /></div>
        ) : (
          <>
            {/* Brokers */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold flex items-center gap-2">
                  🤝 ደላሎች
                  <span className="text-xs font-medium bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">{myBrokers.length}</span>
                </h2>
              </div>

              {myBrokers.length === 0 ? (
                <div className="text-center py-12 text-slate-400 border border-dashed rounded-2xl">
                  ደላላ የለም · + ደላላ አክል ይጫኑ
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {myBrokers.map(b => {
                    const count = myProfiles.filter(p => p.broker_id === b.id).length
                    return (
                      <div key={b.id} className="panel p-4 border border-slate-200 dark:border-slate-700 rounded-2xl group relative">
                        <div
                          className="cursor-pointer pr-16"
                          onClick={() => navigate(`/brokers/${b.id}`)}
                        >
                          <h3 className="font-bold text-teal-700 dark:text-teal-400 hover:underline truncate">{b.name}</h3>
                          <p className="text-sm text-slate-500 mt-1 truncate">{b.contact1 || 'ስልክ የለም'}</p>
                          <p className="text-xs text-slate-400 mt-2">{count} ፕሮፋይል</p>
                        </div>
                        <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEditBroker(b)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20"
                            title="አርም"
                          >✎</button>
                          <button
                            onClick={() => deleteBroker(b)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                            title="ሰርዝ"
                          >✕</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            {/* Profiles */}
            <section>
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2">
                📄 ፕሮፋይሎች
                <span className="text-xs font-medium bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">{myProfiles.length}</span>
              </h2>
              {myProfiles.length === 0 ? (
                <div className="text-center py-12 text-slate-400 border border-dashed rounded-2xl">
                  ይህ ሰራተኛ ገና ፕሮፋይል አልፈጠረም
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {myProfiles.map(p => (
                    <div
                      key={p.id}
                      onClick={() => navigate(`/profiles/${p.id}`)}
                      className="p-4 border border-slate-200 dark:border-slate-700 rounded-xl cursor-pointer hover:border-teal-400 transition-colors"
                    >
                      <div className="font-medium">{p.full_name}</div>
                      <div className="text-xs text-slate-500 mt-1">{p.phone_number || 'ስልክ የለም'}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {/* Broker Create/Edit Modal */}
        <Modal
          isOpen={brokerModal}
          onClose={() => setBrokerModal(false)}
          title={editingBroker ? 'ደላላ አርም' : 'አዲስ ደላላ አክል'}
          size="sm"
        >
          <form onSubmit={saveBroker} className="space-y-4">
            <Input
              label="የደላላ ስም *"
              value={brokerForm.name}
              onChange={e => setBrokerForm({ ...brokerForm, name: e.target.value })}
              placeholder="አህመድ አሊ"
              required
            />
            <Input
              label="ስልክ ቁጥር"
              value={brokerForm.contact1}
              onChange={e => setBrokerForm({ ...brokerForm, contact1: e.target.value })}
              placeholder="+251 9..."
            />
            <Input
              label="አድራሻ"
              value={brokerForm.address}
              onChange={e => setBrokerForm({ ...brokerForm, address: e.target.value })}
              placeholder="አዲስ አበባ"
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setBrokerModal(false)}>ሰርዝ</Button>
              <Button type="submit" isLoading={brokerSaving}>
                {editingBroker ? 'አስቀምጥ' : 'ፍጠር'}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    )
  }

  // ===== MAIN LIST VIEW =====
  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="ሰራተኞች"
        subtitle="ካርዱን ጠቅ በማድረግ የይለፍ ቃል ብቻ ያስገቡ"
        action={
          <div className="flex gap-3 items-center">
            <div className="w-52">
              <Input
                placeholder="ፈልግ..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <Button onClick={openCreateEmp}>+ ሰራተኛ አክል</Button>
          </div>
        }
      />

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          {search ? 'ምንም አልተገኘም' : 'ገና ሰራተኛ የለም'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(emp => (
            <div
              key={emp.id}
              className="panel p-5 border border-slate-200 dark:border-slate-700 rounded-2xl hover:border-teal-400/70 transition-all group relative"
            >
              <div className="cursor-pointer pr-14" onClick={() => openGate(emp)}>
                <h3 className="font-bold text-lg text-slate-800 dark:text-white group-hover:text-teal-600 transition-colors">
                  {emp.name}
                </h3>
                <p className="text-sm text-slate-500 mt-0.5">@{emp.username}</p>
                <div className="mt-3 space-y-1 text-sm text-slate-600 dark:text-slate-300">
                  <div>📞 {emp.phone_work || '—'}</div>
                  <div>💬 {emp.phone_whatsapp || '—'}</div>
                </div>
                <div className="mt-4 text-xs text-teal-600 opacity-0 group-hover:opacity-100 transition-opacity">
                  ለመግባት ጠቅ ያድርጉ →
                </div>
              </div>

              <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => { e.stopPropagation(); openEditEmp(emp) }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20"
                  title="አርም"
                >✎</button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteEmployee(emp) }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                  title="ሰርዝ"
                >✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ===== PASSWORD GATE MODAL ===== */}
      <Modal
        isOpen={!!gateEmployee}
        onClose={() => { setGateEmployee(null); setGatePassword('') }}
        title=""
        size="sm"
      >
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-teal-500 to-teal-600 text-white text-2xl font-bold flex items-center justify-center mx-auto mb-3 shadow-lg shadow-teal-500/25">
            {(gateEmployee?.name || '?')[0]}
          </div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-white">{gateEmployee?.name}</h2>
          <p className="text-sm text-slate-500 mt-1">@{gateEmployee?.username}</p>
        </div>

        <form onSubmit={submitGate} className="space-y-4">
          <Input
            label="የይለፍ ቃል"
            type="password"
            value={gatePassword}
            onChange={e => setGatePassword(e.target.value)}
            placeholder="••••••••"
            autoFocus
            required
          />
          <Button type="submit" className="w-full" isLoading={gateLoading}>
            ግባ
          </Button>
          <button
            type="button"
            onClick={() => { setGateEmployee(null); setGatePassword('') }}
            className="w-full text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 py-1"
          >
            ሰርዝ
          </button>
        </form>
      </Modal>

      {/* ===== CREATE / EDIT EMPLOYEE MODAL ===== */}
      <Modal
        isOpen={empModal}
        onClose={() => setEmpModal(false)}
        title={editingEmp ? 'ሰራተኛ አርም' : 'አዲስ ሰራተኛ'}
        size="md"
      >
        <form onSubmit={saveEmployee} className="space-y-4">
          <Input
            label="ሙሉ ስም *"
            value={empForm.name}
            onChange={e => setEmpForm({ ...empForm, name: e.target.value })}
            required
          />
          <Input
            label="መለያ ስም *"
            value={empForm.username}
            onChange={e => setEmpForm({ ...empForm, username: e.target.value.replace(/\s/g, '') })}
            required
          />
          <PhoneField
            label="WhatsApp ስልክ"
            cc={empForm.wa_cc}
            num={empForm.wa_num}
            onChange={p => setEmpForm({ ...empForm, wa_cc: p.cc, wa_num: p.num })}
          />
          <PhoneField
            label="የስራ ስልክ"
            cc={empForm.work_cc}
            num={empForm.work_num}
            onChange={p => setEmpForm({ ...empForm, work_cc: p.cc, work_num: p.num })}
          />
          <Input
            label={editingEmp ? 'አዲስ የይለፍ ቃል (ባዶ ካደረጉ አይቀየርም)' : 'የይለፍ ቃል *'}
            type="password"
            value={empForm.password}
            onChange={e => setEmpForm({ ...empForm, password: e.target.value })}
            required={!editingEmp}
          />
          {( !editingEmp || empForm.password ) && (
            <Input
              label="የይለፍ ቃል ያረጋግጡ"
              type="password"
              value={empForm.password2}
              onChange={e => setEmpForm({ ...empForm, password2: e.target.value })}
              required={!editingEmp || !!empForm.password}
            />
          )}
          <div className="flex justify-end gap-3 pt-3">
            <Button type="button" variant="secondary" onClick={() => setEmpModal(false)}>ሰርዝ</Button>
            <Button type="submit" isLoading={empSaving}>
              {editingEmp ? 'አስቀምጥ' : 'ፍጠር'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
