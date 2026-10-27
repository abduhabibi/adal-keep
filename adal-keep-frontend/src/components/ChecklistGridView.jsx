import { useState, useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { usePickFile } from './shared/PickFile'

const ALL_FIELDS = [
  'Government ID', 'Passport', 'CV', 'Contract', 'Medical Report', 'Insurance', 'COC',
  'Police Clearance', 'Visa', 'Saudi-letter', 'Musaned', 'Broker ID', 'Ticket-ongoing',
  'Ticket-deported', 'Labour ID', 'Slip', 'Experience Form', 'Employee ID', 'Client ID'
]

// Profile details that can be columns too.
const daysLeft = (d) => d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86400000) : null
const INFO = {
  phone: ['Phone', p => p.phone_number],
  status: ['Status', p => p.status || 'Pending'],
  broker: ['Broker', p => p.broker_name],
  passport: ['Passport no.', p => p.passport_number],
  labor_id: ['Labor ID', p => p.labor_id],
  dob: ['Date of birth', p => p.date_of_birth],
  religion: ['Religion', p => p.religion],
  marital: ['Marital status', p => p.marital_status],
  stage: ['Musaned stage', p => p.musaned_stage],
  contract: ['Contract no.', p => p.contract_number],
  visa: ['Visa no.', p => p.visa_number],
  employer: ['Employer', p => p.employer_name],
  city: ['City of work', p => p.work_city],
  medical: ['Medical days left', p => { const n = daysLeft(p.medical_valid_until); return n === null ? '' : n < 0 ? 'expired' : String(n) }],
  visa_stage: ['Visa', p => p.visa_stage],
}

const docCol = (name) => ({ key: name, kind: 'doc', label: name })
const infoCol = (k) => ({ key: k, kind: 'info', label: INFO[k][0] })

function defaultColumns() {
  let docs = ALL_FIELDS
  try { const saved = JSON.parse(localStorage.getItem('adal_visible_fields') || 'null'); if (Array.isArray(saved)) docs = saved } catch {}
  return [infoCol('phone'), infoCol('status'), ...docs.map(docCol)]
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

export default function ChecklistGridView({ checklist, onClose }) {
  const navigate = useNavigate()
  const [profileData, setProfileData] = useState({})
  const [loading, setLoading] = useState(true)
  const [manage, setManage] = useState(false)
  const [columns, setColumns] = useState(() => checklist.columns?.length ? checklist.columns : defaultColumns())
  const [cells, setCells] = useState(() => {
    const m = {}
    for (const c of checklist.cells || []) m[`${c.profile_id}|${c.column}`] = c.value
    return m
  })
  const [newCol, setNewCol] = useState({ label: '', type: 'tick' })
  const target = useRef(null)   // { profileId, fieldId } the next picked file goes to
  const pick = usePickFile({ onFiles: (files) => target.current && handleUpload(target.current.profileId, target.current.fieldId, files[0]) })

  useEffect(() => { loadData() }, [checklist])

  const loadData = async () => {
    setLoading(true)
    try {
      const results = await Promise.all(checklist.profiles.map((p) =>
        api.get(`/profiles/${p.id}/fields`).then((res) => ({ profile: p, fields: res.data }))))
      const dataMap = {}
      results.forEach(({ profile, fields }) => { dataMap[profile.id] = { profile, fields } })
      setProfileData(dataMap)
    } catch {
      toast.error('Failed to load checklist data')
    } finally {
      setLoading(false)
    }
  }

  // Every document field the profiles have (Appointment Slip, Medical Report …).
  const docNames = useMemo(() => {
    const names = new Set(ALL_FIELDS)
    for (const d of Object.values(profileData)) for (const f of d.fields || []) if (f.name) names.add(f.name)
    return [...names]
  }, [profileData])

  const saveColumns = async (next) => {
    setColumns(next)
    try { await api.put(`/checklists/${checklist.id}/columns`, { columns: next }) }
    catch { toast.error('The columns were not saved') }
  }
  const has = (kind, key) => columns.some(c => c.kind === kind && c.key === key)
  const toggle = (col) => saveColumns(has(col.kind, col.key) ? columns.filter(c => !(c.kind === col.kind && c.key === col.key)) : [...columns, col])
  const move = (i, d) => {
    const j = i + d
    if (j < 0 || j >= columns.length) return
    const next = [...columns];[next[i], next[j]] = [next[j], next[i]]
    saveColumns(next)
  }
  const addOwn = (e) => {
    e.preventDefault()
    const label = newCol.label.trim()
    if (!label) return
    if (columns.some(c => c.kind === 'own' && c.key.toLowerCase() === label.toLowerCase())) return toast.error('There is a column with that name')
    saveColumns([...columns, { key: label, kind: 'own', label, type: newCol.type }])
    setNewCol({ label: '', type: newCol.type })
  }

  const setCell = async (profileId, column, value) => {
    setCells(c => ({ ...c, [`${profileId}|${column}`]: value }))
    try { await api.put(`/checklists/${checklist.id}/cells`, { profile_id: profileId, column, value }) }
    catch { toast.error('Not saved') }
  }

  const handleUpload = async (profileId, fieldId, file) => {
    if (!fieldId) return toast.error('This profile has no such document field')
    try {
      const formData = new FormData()
      formData.append('file', file)
      await api.post(`/profiles/${profileId}/fields/${fieldId}/upload`, formData, { headers: { 'Content-Type': 'multipart/form-data' } })
      toast.success('Uploaded successfully')
      const res = await api.get(`/profiles/${profileId}/fields`)
      setProfileData((prev) => ({ ...prev, [profileId]: { ...prev[profileId], fields: res.data } }))
    } catch {
      toast.error('Upload failed')
    }
  }

  const handleDeleteChecklist = async () => {
    if (!confirm(`Delete checklist "${checklist.name}" permanently? (Profiles will not be deleted)`)) return
    try {
      await api.delete(`/checklists/${checklist.id}`)
      toast.success('Checklist deleted')
      onClose()
      navigate('/checklist')
    } catch {
      toast.error('Failed to delete checklist')
    }
  }

  // What a cell says, as text (CSV and print).
  const textOf = (profile, col) => {
    if (col.kind === 'info') return String(INFO[col.key]?.[1](profile) ?? '')
    if (col.kind === 'own') { const v = cells[`${profile.id}|${col.key}`] || ''; return col.type === 'tick' ? (v ? '✓' : '') : v }
    const f = profileData[profile.id]?.fields?.find(x => x.name === col.key)
    return f?.files?.length ? '✓' : ''
  }

  const handleDownloadCSV = () => {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const rows = checklist.profiles.map(p => [q(p.full_name), ...columns.map(c => q(c.kind === 'doc' || c.type === 'tick' ? (textOf(p, c) ? 'YES' : 'NO') : textOf(p, c)))].join(','))
    const csv = [['Full Name', ...columns.map(c => c.label)].map(q).join(','), ...rows].join('\n')
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${checklist.name.replace(/\s+/g, '_')}_Checklist.csv`
    document.body.appendChild(link); link.click(); link.remove()
    URL.revokeObjectURL(url)
    toast.success('CSV downloaded')
  }

  /**
   * Print: a clean page with only the table, filling the whole sheet —
   * landscape when there are many columns, the letters as big as fit.
   */
  const handlePrint = () => {
    const n = columns.length
    const landscape = n > 7
    const font = Math.max(6.5, Math.min(12, (landscape ? 150 : 105) / (n + 3)))
    const head = `<tr><th class="no">#</th><th class="name">Name</th>${columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>`
    const body = checklist.profiles.map((p, i) => `<tr><td class="no">${i + 1}</td><td class="name">${esc(p.full_name)}</td>${columns.map(c => {
      const t = textOf(p, c)
      const mark = c.kind === 'doc' || c.type === 'tick'
      return `<td class="${mark ? 'mark' : ''}">${mark ? (t ? '✓' : '<span class="box"></span>') : esc(t)}</td>`
    }).join('')}</tr>`).join('')
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(checklist.name)} — Checklist</title><style>
      @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 7mm; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; background: #fff; color: #000; font-family: "Noto Sans Ethiopic", Arial, sans-serif; }
      .bar { display: flex; justify-content: space-between; align-items: baseline; margin: 0 0 3mm; }
      h1 { font-size: ${Math.round(font * 1.6)}pt; margin: 0; } .meta { font-size: ${font}pt; color: #444; }
      table { width: 100%; border-collapse: collapse; table-layout: auto; font-size: ${font.toFixed(1)}pt; }
      thead { display: table-header-group; } tr { page-break-inside: avoid; }
      th, td { border: 1px solid #222; padding: ${(font / 3).toFixed(1)}pt ${(font / 2.5).toFixed(1)}pt; text-align: center; vertical-align: middle; }
      th { background: #e9e9e9; font-weight: 700; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      td.name, th.name { text-align: left; font-weight: 600; white-space: nowrap; }
      td.no, th.no { width: 1%; color: #555; }
      td.mark { font-size: ${(font * 1.3).toFixed(1)}pt; font-weight: 700; }
      .box { display: inline-block; width: ${font}pt; height: ${font}pt; border: 1px solid #555; }
      @media screen { body { padding: 16px; } .tip { font: 13px Arial; color: #555; margin-bottom: 10px; } }
      @media print { .tip { display: none; } }
    </style></head><body>
      <div class="tip">This is the clean page for printing. The print window opens by itself; close this tab when you are done.</div>
      <div class="bar"><h1>${esc(checklist.name)}</h1><span class="meta">${checklist.profiles.length} profiles · ${new Date().toLocaleDateString()}</span></div>
      <table><thead>${head}</thead><tbody>${body}</tbody></table>
      <script>window.onload = () => setTimeout(() => window.print(), 300)</script>
    </body></html>`
    const w = window.open('', '_blank')
    if (w) { w.document.open(); w.document.write(html); w.document.close(); return }
    // Pop-ups blocked: print the same page from a hidden frame.
    const f = document.createElement('iframe')
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'
    document.body.appendChild(f)
    f.contentDocument.open(); f.contentDocument.write(html.replace(/<script>[\s\S]*?<\/script>/, '')); f.contentDocument.close()
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 2000) }, 400)
  }

  if (loading) {
    return <div className="fixed inset-0 z-50 bg-white dark:bg-slate-950 flex items-center justify-center text-slate-500">Loading grid data...</div>
  }

  const btn = 'px-3 py-2 text-sm font-medium rounded-lg border whitespace-nowrap'
  return (
    <div className="fixed inset-0 z-50 bg-white dark:bg-slate-950 flex flex-col">
      <div className="border-b border-slate-200 dark:border-slate-800 flex flex-wrap gap-2 items-center justify-between px-4 sm:px-6 py-3 bg-slate-50 dark:bg-slate-900 shrink-0">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-bold text-slate-900 dark:text-white truncate">{checklist.name}</h2>
          <p className="text-xs text-slate-500">{checklist.profiles.length} profiles · {columns.length} columns</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button type="button" onClick={() => setManage(true)} className={`${btn} text-white bg-teal-600 border-teal-600 hover:bg-teal-700`}>＋ Columns</button>
          <button type="button" onClick={handlePrint} className={`${btn} text-blue-700 bg-blue-50 border-blue-200 hover:bg-blue-100`}>🖨 Print</button>
          <button type="button" onClick={handleDownloadCSV} className={`${btn} text-emerald-700 bg-emerald-50 border-emerald-200 hover:bg-emerald-100`}>CSV</button>
          <button type="button" onClick={handleDeleteChecklist} className={`${btn} text-red-700 bg-red-50 border-red-200 hover:bg-red-100`}>Delete</button>
          <button type="button" onClick={onClose} className={`${btn} text-slate-700 bg-white border-slate-300 hover:bg-slate-50`}>Close</button>
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar">
        <table className="border-collapse w-full text-xs">
          <thead className="bg-slate-100 dark:bg-slate-800 sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 bg-slate-100 dark:bg-slate-800 border-b border-r border-slate-300 dark:border-slate-700 p-3 text-left min-w-[150px]">Profile</th>
              {columns.map((c) => (
                <th key={`${c.kind}:${c.key}`} className={`border-b border-r border-slate-300 dark:border-slate-700 p-1.5 text-center font-semibold ${c.kind === 'own' ? 'text-teal-700 dark:text-teal-300' : 'text-slate-600 dark:text-slate-300'}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {checklist.profiles.map((profile) => {
              const data = profileData[profile.id]
              if (!data) return null
              return (
                <tr key={profile.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className="sticky left-0 z-10 bg-white dark:bg-slate-950 border-b border-r border-slate-200 dark:border-slate-800 p-2 font-medium text-slate-900 dark:text-white">
                    {profile.full_name}
                    {profile.broker_name && <div className="text-[10px] text-slate-400 font-normal">{profile.broker_name}</div>}
                  </td>
                  {columns.map((c) => {
                    const k = `${c.kind}:${c.key}`
                    const cell = 'border-b border-r border-slate-200 dark:border-slate-800 p-1 text-center align-middle'
                    if (c.kind === 'info') return <td key={k} className={`${cell} text-slate-600 dark:text-slate-300 px-2`}>{textOf(profile, c) || '—'}</td>
                    if (c.kind === 'own') {
                      const v = cells[`${profile.id}|${c.key}`] || ''
                      return (
                        <td key={k} className={cell}>
                          {c.type === 'tick'
                            ? <input type="checkbox" checked={!!v} onChange={(e) => setCell(profile.id, c.key, e.target.checked ? '1' : '')} className="w-5 h-5 accent-teal-600 cursor-pointer" />
                            : <input defaultValue={v} onBlur={(e) => { if (e.target.value !== v) setCell(profile.id, c.key, e.target.value) }}
                                className="w-28 rounded border border-slate-200 dark:border-slate-700 bg-transparent px-1.5 py-1 text-xs" />}
                        </td>
                      )
                    }
                    const fieldObj = data.fields.find((f) => f.name === c.key)
                    const file = fieldObj?.files?.[0]
                    return (
                      <td key={k} className={cell} onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleUpload(profile.id, fieldObj?.id, f) }}>
                        {file ? (
                          file.mimetype?.startsWith('image/')
                            ? <img src={`/api/files/${file.id}/thumbnail`} className="w-12 h-12 object-cover rounded mx-auto border border-slate-200" alt="" />
                            : <div className="w-12 h-12 bg-slate-100 dark:bg-slate-800 rounded mx-auto flex items-center justify-center text-slate-400">📄</div>
                        ) : fieldObj ? (
                          <button type="button" onClick={() => { target.current = { profileId: profile.id, fieldId: fieldObj.id }; pick.open() }}
                            className="flex flex-col items-center justify-center w-12 h-12 mx-auto border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg cursor-pointer hover:border-teal-400 hover:bg-teal-50">
                            <span className="text-slate-300 text-lg">+</span>
                          </button>
                        ) : <span className="text-slate-300">—</span>}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pick.element}

      {manage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-3" onClick={(e) => { if (e.target === e.currentTarget) setManage(false) }}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
              <h3 className="font-bold text-slate-800 dark:text-white">Columns of “{checklist.name}”</h3>
              <button type="button" onClick={() => setManage(false)} className="text-slate-400 text-lg">✕</button>
            </div>
            <div className="p-4 overflow-y-auto grid gap-5 md:grid-cols-2">
              <div className="space-y-4">
                <section>
                  <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">➕ Your own column</h4>
                  <form onSubmit={addOwn} className="flex flex-wrap gap-2">
                    <input value={newCol.label} onChange={(e) => setNewCol({ ...newCol, label: e.target.value })} placeholder="Name, e.g. Paid, Called, Note"
                      className="flex-1 min-w-[150px] rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-3 py-2 text-sm" />
                    <select value={newCol.type} onChange={(e) => setNewCol({ ...newCol, type: e.target.value })}
                      className="rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-2 text-sm">
                      <option value="tick">✓ tick</option>
                      <option value="text">✎ text</option>
                    </select>
                    <button className="rounded-lg bg-teal-600 text-white px-3 py-2 text-sm font-semibold">Add</button>
                  </form>
                </section>
                <section>
                  <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">👤 Profile details</h4>
                  <div className="grid grid-cols-2 gap-1">
                    {Object.keys(INFO).map(k => (
                      <label key={k} className="flex items-center gap-2 p-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-sm">
                        <input type="checkbox" checked={has('info', k)} onChange={() => toggle(infoCol(k))} className="w-4 h-4 accent-teal-600" />
                        <span className="truncate">{INFO[k][0]}</span>
                      </label>
                    ))}
                  </div>
                </section>
                <section>
                  <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">📄 Documents</h4>
                  <div className="grid grid-cols-2 gap-1">
                    {docNames.map(n => (
                      <label key={n} className="flex items-center gap-2 p-1.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-sm">
                        <input type="checkbox" checked={has('doc', n)} onChange={() => toggle(docCol(n))} className="w-4 h-4 accent-teal-600" />
                        <span className="truncate">{n}</span>
                      </label>
                    ))}
                  </div>
                </section>
              </div>
              <section>
                <h4 className="text-xs font-bold uppercase text-slate-500 mb-2">↕ Order (as printed)</h4>
                <ol className="space-y-1">
                  {columns.map((c, i) => (
                    <li key={`${c.kind}:${c.key}`} className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-sm">
                      <span className="text-xs">{c.kind === 'doc' ? '📄' : c.kind === 'info' ? '👤' : c.type === 'tick' ? '✓' : '✎'}</span>
                      <span className="flex-1 truncate">{c.label}</span>
                      <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="px-1.5 text-slate-500 disabled:opacity-30">↑</button>
                      <button type="button" onClick={() => move(i, 1)} disabled={i === columns.length - 1} className="px-1.5 text-slate-500 disabled:opacity-30">↓</button>
                      <button type="button" onClick={() => saveColumns(columns.filter((_, j) => j !== i))} className="px-1.5 text-red-500">✕</button>
                    </li>
                  ))}
                  {!columns.length && <li className="text-sm text-slate-400">No columns — tick some on the left.</li>}
                </ol>
              </section>
            </div>
            <div className="p-3 bg-slate-50 dark:bg-slate-800 border-t border-slate-100 dark:border-slate-700 flex justify-between">
              <button type="button" onClick={() => saveColumns(defaultColumns())} className="text-sm text-red-600 font-medium">Reset</button>
              <button type="button" onClick={() => setManage(false)} className="px-4 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
