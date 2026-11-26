import GlassSelect from '../components/shared/GlassSelect'
import { useState, useEffect } from 'react'
import { cachedGet } from '../lib/deviceCache'
import { profilesList } from '../lib/profilesCache'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import PageHeader from '../components/shared/PageHeader'
import Spinner from '../components/shared/Spinner'
import Input from '../components/shared/Input'
import Button from '../components/shared/Button'
import Modal from '../components/shared/Modal'
import EmployeePassword from '../components/EmployeePassword'
import { onPhone } from '../lib/phoneMode'
import StaffRoles from '../components/StaffRoles'
import { usePerms } from '../lib/staffPerms'

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
        <GlassSelect
          value={cc}
          onChange={(e) => onChange({ cc: e.target.value, num })}
          className="w-24 px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/40"
        >
          {COUNTRY_CODES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </GlassSelect>
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

function getDeviceSerial() {
  let id = localStorage.getItem('adal_device_serial')
  if (!id) {
    id =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    localStorage.setItem('adal_device_serial', id)
  }
  return id
}

const emptyEmp = {
  name: '',
  username: '',
  work_cc: '+251',
  work_num: '',
  role_id: '',
  password: '',
}

export default function EmployeesPage() {
  const navigate = useNavigate()
  const { setCurrentUser, activeEmployee, setActiveEmployee } = useAuth()

  const [employees, setEmployees] = useState([])
  // Staff roles (Roles panel; each employee's role): only someone who manages staff changes them.
  const [roles, setRoles] = useState([])
  const [permLabels, setPermLabels] = useState({})
  const canManage = usePerms().manage_staff
  const [pw, setPw] = useState(null)              // { emp, mode: 'ask' | 'admin' | 'self' }
  const [showStaff, setShowStaff] = useState(false) // signed in: the staff list instead of her workspace
  // On a phone: no sign-in of its own — it works as whoever is signed in on its PC.
  const phone = onPhone()
  const [pcPerson, setPcPerson] = useState(null)
  useEffect(() => { if (phone) api.get('/staff-roles/me', { adalNoCache: true }).then(r => setPcPerson(r.data?.employee ? { ...r.data.employee, role: r.data.role?.name } : false)).catch(() => {}) }, [phone])
  const loadRoles = () => api.get('/staff-roles').then(r => { setRoles(r.data?.roles || []); setPermLabels(r.data?.perms || {}) }).catch(() => {})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [gateLoading, setGateLoading] = useState(false)

  const [active, setActive] = useState(null)
  const [myBrokers, setMyBrokers] = useState([])
  const [myProfiles, setMyProfiles] = useState([])
  const [wsLoading, setWsLoading] = useState(false)

  const [empModal, setEmpModal] = useState(false)
  const [editingEmp, setEditingEmp] = useState(null)
  const [empForm, setEmpForm] = useState(emptyEmp)
  const [empSaving, setEmpSaving] = useState(false)

  const [brokerModal, setBrokerModal] = useState(false)
  const [editingBroker, setEditingBroker] = useState(null)
  const [brokerForm, setBrokerForm] = useState({ name: '', contact1: '', address: '' })
  const [brokerSaving, setBrokerSaving] = useState(false)

  const loadEmployees = async () => {
    setLoading(true)
    try {
      const res = await api.get('/employees')
      setEmployees(Array.isArray(res.data) ? res.data : [])
    } catch {
      toast.error('ሰራተኞችን መጫን አልተቻለም')
    } finally {
      setLoading(false)
    }
  }

  // An employee's workspace, fast (asked on 2026-11-16: the brokers did not
  // show, and it was slow): the brokers list is small and shows as soon as it
  // comes; the profiles come from the list every page shares (lib/profilesCache:
  // the copy kept on this device shows at once, the fresh one behind it) —
  // the brokers never wait for thousands of profiles.
  const loadWorkspace = async (emp) => {
    if (!emp) return
    setWsLoading(true)
    try {
      const keys = [
        (emp.name || emp.full_name || ''),
        (emp.username || ''),
        emp.id != null ? String(emp.id) : '',
      ].map(s => String(s).trim().toLowerCase()).filter(Boolean)
      const matchCreator = (row) => {
        const c = String(row.created_by || '').trim().toLowerCase()
        if (!c) return false
        return keys.some(k => c === k || c.includes(k) || k.includes(c))
      }
      const brokers = cachedGet('/brokers', { onSaved: (b) => { if (Array.isArray(b)) { setMyBrokers(b.filter(matchCreator)); setWsLoading(false) } } })
        .then(b => { setMyBrokers((Array.isArray(b) ? b : []).filter(matchCreator)); setWsLoading(false) })
      const profiles = profilesList({ onSaved: (p) => { if (Array.isArray(p)) setMyProfiles(p.filter(matchCreator)) } })
        .then(p => setMyProfiles((Array.isArray(p) ? p : []).filter(matchCreator)))
      await Promise.all([brokers, profiles])
    } catch (err) {
      console.error('loadWorkspace', err)
      toast.error('መረጃ መጫን አልተቻለም')
      setMyBrokers([])
      setMyProfiles([])
    } finally {
      setWsLoading(false)
    }
  }

  // Restore session when returning from Profiles / any page
  useEffect(() => {
    loadEmployees()
    loadRoles()
    if (phone) return
    if (activeEmployee?.id) {
      setActive(activeEmployee)
      loadWorkspace(activeEmployee)
      if (activeEmployee.staff_token) return   // (no key yet: asked for it below)
    }
    ;(async () => {
      try {
        const res = await api.post('/employees/device-resume', {
          deviceSerial: getDeviceSerial(),
        })
        if (res.data?.user && (!activeEmployee?.id || res.data.user.id === activeEmployee.id)) {
          const u = res.data.user
          setCurrentUser(u)
          setActiveEmployee(u)
          setActive(u)
          loadWorkspace(u)
        }
      } catch {}
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** One click — bind this PC, no password */
  const openGate = async (emp, password) => {
    if (phone) return toast('On the phone you work as the person signed in on the PC', { icon: 'ℹ️' })
    setGateLoading(true)
    try {
      const res = await api.post('/employees/device-login', {
        employeeId: emp.id,
        deviceSerial: getDeviceSerial(),
        ...(password ? { password } : {}),
      })
      setPw(null)
      setShowStaff(false)
      const u = { ...emp, ...(res.data?.user || {}) }
      setCurrentUser(u)
      setActiveEmployee(u)
      setActive(u)
      toast.success(`እንኳን ደህና መጡ፣ ${emp.name}`)
      loadWorkspace(u)
    } catch (err) {
      // Signing in asks for her password (the one the admin gave her).
      if (err.response?.data?.needs_password) {
        if (password) toast.error('Wrong password')
        setPw({ emp, mode: 'ask' })
        return
      }
      toast.error(err.response?.data?.error || 'መግባት አልተቻለም')
    } finally {
      setGateLoading(false)
    }
  }

  const assignProfileToBroker = async (profileId, brokerId) => {
    try {
      await api.put(`/profiles/${profileId}`, { broker_id: brokerId })
      toast.success('ፕሮፋይል ተመድቧል')
      if (active) loadWorkspace(active)
    } catch (err) {
      toast.error(err.response?.data?.error || 'መመደብ አልተቻለም')
    }
  }

  const exitWorkspace = async () => {
    try {
      await api.post('/employees/device-logout', { deviceSerial: getDeviceSerial() })
    } catch {}
    try {
      await api.post('/auth/logout')
    } catch {}
    setActiveEmployee(null)
    setCurrentUser(null)
    setActive(null)
    setShowStaff(false)
    setMyBrokers([])
    setMyProfiles([])
  }


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
      work_cc: '+251',
      work_num: (emp.phone_work || '').replace(/\D/g, '').slice(-9),
      role_id: emp.role_id ?? '',
    })
    setEmpModal(true)
  }

  const saveEmployee = async (e) => {
    e.preventDefault()
    if (!empForm.name.trim()) return toast.error('ስም ያስፈልጋል')
    if (!empForm.username.trim() || /\s/.test(empForm.username)) {
      return toast.error('መለያ ስም ያለ ክፍተት')
    }
    setEmpSaving(true)
    try {
      const payload = {
        name: empForm.name.trim(),
        username: empForm.username.trim(),
        phone_work: empForm.work_num
          ? `${empForm.work_cc}${digitsOnly(empForm.work_num)}`
          : '',
      }
      if (editingEmp) {
        await api.put(`/employees/${editingEmp.id}`, payload)
        if (empForm.role_id && Number(empForm.role_id) !== editingEmp.role_id) {
          await api.put(`/employees/${editingEmp.id}/role`, { role_id: Number(empForm.role_id) })
          loadRoles()
        }
        toast.success('ሰራተኛ ተዘምኗል')
      } else {
        if (empForm.password.length < 4) { setEmpSaving(false); return toast.error('Give them a password (4 characters or more) to share with them') }
        await api.post('/employees', { ...payload, password: empForm.password, ...(empForm.role_id ? { role_id: Number(empForm.role_id) } : {}) })
        loadRoles()
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
      address: b.address || '',
    })
    setBrokerModal(true)
  }

  const saveBroker = async (e) => {
    e.preventDefault()
    if (!brokerForm.name.trim()) return toast.error('የደላላ ስም ያስፈልጋል')
    setBrokerSaving(true)
    try {
      const payload = {
        ...brokerForm,
        created_by:
          (active && (active.name || active.full_name || active.username || '')).toString().trim() ||
          'unknown',
      }
      if (editingBroker) {
        await api.put(`/brokers/${editingBroker.id}`, payload)
        toast.success('ደላላ ተዘምኗል')
      } else {
        await api.post('/brokers', payload)
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
    if (!confirm(`"${b.name}" ይሰረዝ?\n\nፕሮፋይሎቹ አይጠፉም።`)) return
    try {
      const linked = myProfiles.filter((p) => p.broker_id === b.id)
      for (const p of linked) {
        await api.put(`/profiles/${p.id}`, { broker_id: null })
      }
      await api.delete(`/brokers/${b.id}`)
      toast.success('ደላላ ተሰርዟል')
      if (active) loadWorkspace(active)
    } catch {
      toast.error('መሰረዝ አልተቻለም')
    }
  }

  const filtered = employees.filter(
    (e) =>
      (e.name || '').toLowerCase().includes(search.toLowerCase()) ||
      (e.username || '').toLowerCase().includes(search.toLowerCase())
  )

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner back />
      </div>
    )
  }

  const passwordBox = pw && (
    <EmployeePassword emp={pw.emp} mode={pw.mode} onClose={() => { setPw(null); loadEmployees() }} onSignIn={(p) => openGate(pw.emp, p)} />
  )

  // ===== WORKSPACE =====
  if (active && !showStaff) {
    return (
      <div className="animate-fade-up space-y-8">
        <PageHeader
          title={`${active.name}`}
          subtitle={`የስራ ቦታ · ደላሎች እና ፕሮፋይሎች${active.role_name ? ` · ${active.role_name}` : ''}`}
          action={
            <div className="flex flex-wrap gap-2">
              <Button data-tour="new-broker" onClick={openCreateBroker}>+ ደላላ አክል</Button>
              {canManage && <Button variant="secondary" onClick={() => setShowStaff(true)}>Staff & roles</Button>}
              {!phone && <Button variant="secondary" onClick={() => setPw({ emp: active, mode: 'self' })}>Change my password</Button>}
              <Button variant="secondary" onClick={exitWorkspace} disabled={gateLoading}>
                ውጣ
              </Button>
            </div>
          }
        />

        {wsLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner back />
          </div>
        ) : (
          <>
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold flex items-center gap-2">ደላሎች
                  <span className="text-xs font-medium bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">
                    {myBrokers.length}
                  </span>
                </h2>
              </div>
              {myBrokers.length === 0 ? (
                <div className="text-center py-12 text-slate-400 border border-dashed rounded-2xl">
                  ደላላ የለም · + ደላላ አክል ይጫኑ
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {myBrokers.map((b) => {
                    const count = myProfiles.filter((p) => p.broker_id === b.id).length
                    return (
                      <div
                        key={b.id}
                        className="panel p-4 border border-slate-200 dark:border-slate-700 rounded-2xl group relative transition-colors"
                        onDragOver={(e) => {
                          e.preventDefault()
                          e.currentTarget.classList.add('border-teal-500', 'bg-teal-50/50')
                        }}
                        onDragLeave={(e) => {
                          e.currentTarget.classList.remove('border-teal-500', 'bg-teal-50/50')
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          e.currentTarget.classList.remove('border-teal-500', 'bg-teal-50/50')
                          const profileId = e.dataTransfer.getData('profileId')
                          if (profileId) assignProfileToBroker(Number(profileId), b.id)
                        }}
                      >
                        <div
                          className="cursor-pointer pr-16"
                          onClick={() => navigate(`/brokers/${b.id}`)}
                        >
                          <h3 className="font-bold text-teal-700 dark:text-teal-400 hover:underline truncate">
                            {b.name}
                          </h3>
                          <p className="text-sm text-slate-500 mt-1 truncate">
                            {b.contact1 || 'ስልክ የለም'}
                          </p>
                          <p className="text-xs text-slate-400 mt-2">{count} ፕሮፋይል</p>
                        </div>
                        <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={() => openEditBroker(b)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-teal-600 hover:bg-teal-50"
                            title="አርም"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteBroker(b)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
                            title="ሰርዝ"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-lg font-bold mb-4 flex items-center gap-2">ፕሮፋይሎች
                <span className="text-xs font-medium bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full">
                  {myProfiles.length}
                </span>
              </h2>
              {myProfiles.length === 0 ? (
                <div className="text-center py-12 text-slate-400 border border-dashed rounded-2xl">
                  ይህ ሰራተኛ ገና ፕሮፋይል አልፈጠረም
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {myProfiles.map((p) => (
                    <div
                      key={p.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('profileId', String(p.id))
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onClick={() => navigate(`/profiles/${p.id}`)}
                      className="p-4 border border-slate-200 dark:border-slate-700 rounded-xl cursor-grab active:cursor-grabbing hover:border-teal-400 transition-colors"
                    >
                      <div className="font-medium">{p.full_name}</div>
                      <div className="text-xs text-slate-500 mt-1">
                        {p.phone_number || 'ስልክ የለም'}
                      </div>
                      {p.broker_id && (
                        <div className="text-[10px] text-teal-600 mt-1">ተመድቧል</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}

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
              onChange={(e) => setBrokerForm({ ...brokerForm, name: e.target.value })}
              required
            />
            <Input
              label="ስልክ ቁጥር"
              value={brokerForm.contact1}
              onChange={(e) => setBrokerForm({ ...brokerForm, contact1: e.target.value })}
            />
            <Input
              label="አድራሻ"
              value={brokerForm.address}
              onChange={(e) => setBrokerForm({ ...brokerForm, address: e.target.value })}
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="secondary" onClick={() => setBrokerModal(false)}>
                ሰርዝ
              </Button>
              <Button type="submit" isLoading={brokerSaving}>
                {editingBroker ? 'አስቀምጥ' : 'ፍጠር'}
              </Button>
            </div>
          </form>
        </Modal>
        {passwordBox}
      </div>
    )
  }

  // ===== LIST =====
  return (
    <div className="animate-fade-up space-y-6">
      <PageHeader
        title="ሰራተኞች"
        subtitle={phone
          ? (pcPerson ? `This phone works as ${pcPerson.name} (${pcPerson.role}), signed in on the PC` : pcPerson === false ? 'No one is signed in on the PC: this phone can look, not change' : '')
          : active ? `Signed in as ${active.name}` : 'Signed out: you can look, not change. Click your card and type your password to sign in.'}
        action={
          <div className="flex gap-3 items-center">
            {active && <Button variant="secondary" onClick={() => setShowStaff(false)}>← My workspace</Button>}
            <div className="w-52">
              <Input
                placeholder="ፈልግ..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {canManage && <Button data-tour="new-employee" onClick={openCreateEmp}>+ ሰራተኛ አክል</Button>}
          </div>
        }
      />

      {filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          {search ? 'ምንም አልተገኘም' : 'ገና ሰራተኛ የለም'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((emp) => (
            <div
              key={emp.id}
              className="panel p-5 border border-slate-200 dark:border-slate-700 rounded-2xl hover:border-teal-400/70 transition-all group relative"
            >
              <div
                className="cursor-pointer pr-14"
                onClick={() => !gateLoading && openGate(emp)}
              >
                <h3 className="font-bold text-lg text-slate-800 dark:text-white group-hover:text-teal-600 transition-colors">
                  {emp.name}
                </h3>
                <p className="text-sm text-slate-500 mt-0.5">@{emp.username}
                  {emp.role_name && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">{emp.role_name}</span>}
                </p>
                <div className="mt-3 text-sm text-slate-600 dark:text-slate-300">
                  📞 {emp.phone_work || '—'}
                </div>
                {/* Her username + PIN for another computer's Adal Companion (main PC only). */}
                {canManage && (
                  <button type="button" onClick={(e) => { e.stopPropagation(); setPw({ emp, mode: 'admin' }) }}
                    className={`mt-2 text-xs font-medium hover:underline ${emp.has_password ? 'text-teal-700 dark:text-teal-400' : 'text-amber-700 dark:text-amber-400'}`}>
                    🔑 {emp.has_password ? 'Password' : 'No password yet — set one'}
                  </button>
                )}
                <div className="mt-4 text-xs text-teal-600 opacity-0 group-hover:opacity-100 transition-opacity">
                  ለመግባት ጠቅ ያድርጉ →
                </div>
              </div>
              {canManage && <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    openEditEmp(emp)
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-teal-600 hover:bg-teal-50"
                  title="አርም"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteEmployee(emp)
                  }}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
                  title="ሰርዝ"
                >
                  ✕
                </button>
              </div>}
            </div>
          ))}
        </div>
      )}

      {canManage && roles.length > 0 && <StaffRoles roles={roles} labels={permLabels} onChanged={() => Promise.all([loadRoles(), loadEmployees()])} />}

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
            onChange={(e) => setEmpForm({ ...empForm, name: e.target.value })}
            required
          />
          <Input
            label="መለያ ስም *"
            value={empForm.username}
            onChange={(e) =>
              setEmpForm({ ...empForm, username: e.target.value.replace(/\s/g, '') })
            }
            required
          />
          <PhoneField
            label="የስራ ስልክ"
            cc={empForm.work_cc}
            num={empForm.work_num}
            onChange={(p) => setEmpForm({ ...empForm, work_cc: p.cc, work_num: p.num })}
          />
          {!editingEmp && (
            <Input
              label="Password * (share it with them; they can change it)"
              value={empForm.password}
              onChange={(e) => setEmpForm({ ...empForm, password: e.target.value })}
              autoComplete="off"
              required
            />
          )}
          {roles.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1.5">Role</label>
              <GlassSelect
                value={empForm.role_id || roles.find(r => r.preset === 'admin')?.id || ''}
                onChange={(e) => setEmpForm({ ...empForm, role_id: e.target.value })}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
              >
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </GlassSelect>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-3">
            <Button type="button" variant="secondary" onClick={() => setEmpModal(false)}>
              ሰርዝ
            </Button>
            <Button type="submit" isLoading={empSaving}>
              {editingEmp ? 'አስቀምጥ' : 'ፍጠር'}
            </Button>
          </div>
        </form>
      </Modal>
      {passwordBox}
    </div>
  )
}
