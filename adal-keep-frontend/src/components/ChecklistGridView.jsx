import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'

const ALL_FIELDS = [
  'Government ID', 'Passport', 'CV', 'Contract', 'Medical Report', 'Insurance', 'COC',
  'Police Clearance', 'Visa', 'Saudi-letter', 'Musaned', 'Broker ID', 'Ticket-ongoing',
  'Ticket-deported', 'Labour ID', 'Slip', 'Experience Form', 'Employee ID', 'Client ID'
]

export default function ChecklistGridView({ checklist, onClose }) {
  const navigate = useNavigate()
  const [profileData, setProfileData] = useState({})
  const [loading, setLoading] = useState(true)
  const [isColumnModalOpen, setIsColumnModalOpen] = useState(false)
  const [visibleFields, setVisibleFields] = useState(() => {
    try {
      const saved = localStorage.getItem('adal_visible_fields')
      return saved ? JSON.parse(saved) : ALL_FIELDS
    } catch {
      return ALL_FIELDS
    }
  })

  useEffect(() => {
    localStorage.setItem('adal_visible_fields', JSON.stringify(visibleFields))
  }, [visibleFields])

  useEffect(() => {
    loadData()
  }, [checklist])

  const loadData = async () => {
    setLoading(true)
    try {
      const promises = checklist.profiles.map((p) =>
        api.get(`/profiles/${p.id}/fields`).then((res) => ({ profile: p, fields: res.data }))
      )
      const results = await Promise.all(promises)
      const dataMap = {}
      results.forEach(({ profile, fields }) => {
        dataMap[profile.id] = { profile, fields }
      })
      setProfileData(dataMap)
    } catch {
      toast.error('Failed to load checklist data')
    } finally {
      setLoading(false)
    }
  }

  const handleUpload = async (profileId, fieldId, file) => {
    try {
      const formData = new FormData()
      formData.append('file', file)
      await api.post(`/profiles/${profileId}/fields/${fieldId}/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      toast.success('Uploaded successfully')
      const res = await api.get(`/profiles/${profileId}/fields`)
      setProfileData((prev) => ({
        ...prev,
        [profileId]: { ...prev[profileId], fields: res.data },
      }))
    } catch {
      toast.error('Upload failed')
    }
  }

  const handleDrop = (e, profileId, fieldId) => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) handleUpload(profileId, fieldId, file)
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

  const handleDownloadCSV = () => {
    const headers = ['Full Name', 'Phone', 'Status', 'Broker', ...visibleFields]
    const rows = checklist.profiles.map((p) => {
      const data = profileData[p.id]
      const row = [
        `"${p.full_name}"`,
        `"${p.phone_number || ''}"`,
        `"${p.status || 'Pending'}"`,
        `"${p.broker_name || ''}"`,
      ]
      visibleFields.forEach((field) => {
        const fieldObj = data?.fields?.find((f) => f.name === field)
        const hasFile = fieldObj?.files?.length > 0
        row.push(hasFile ? '"YES"' : '"NO"')
      })
      return row.join(',')
    })
    const csvContent = [headers.join(','), ...rows].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.setAttribute('href', url)
    link.setAttribute('download', `${checklist.name.replace(/\s+/g, '_')}_Checklist.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    toast.success('CSV downloaded')
  }

  const handlePrint = () => window.print()

  const toggleField = (field) => {
    if (visibleFields.includes(field)) {
      setVisibleFields(visibleFields.filter((f) => f !== field))
    } else {
      setVisibleFields([...visibleFields, field])
    }
  }

  const resetColumns = () => {
    setVisibleFields(ALL_FIELDS)
    toast.success('All columns restored')
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-500">
        Loading grid data...
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media print {
              @page { size: A4 landscape; margin: 4mm; }
              html, body {
                width: 100% !important;
                height: auto !important;
                margin: 0 !important;
                padding: 0 !important;
                overflow: visible !important;
              }
              body * { visibility: hidden !important; }
              .print-table-area, .print-table-area * { visibility: visible !important; }
              .print-table-area {
                position: fixed !important;
                left: 0 !important;
                top: 0 !important;
                right: auto !important;
                margin: 0 !important;
                padding: 2mm !important;
                width: 100% !important;
                max-width: 100% !important;
                transform: none !important;
                overflow: visible !important;
              }
              .print-title {
                visibility: visible !important;
                display: block !important;
                text-align: left !important;
                font-size: 12pt;
                font-weight: bold;
                margin: 0 0 3mm 0 !important;
                padding: 0 !important;
              }
              .print-table-area table {
                width: 100% !important;
                max-width: 100% !important;
                margin: 0 !important;
                border-collapse: collapse !important;
                table-layout: fixed !important;
                font-size: 7pt !important;
              }
              .print-table-area th,
              .print-table-area td {
                border: 1px solid #333 !important;
                padding: 2px 2px !important;
                text-align: center !important;
                vertical-align: middle !important;
                overflow: hidden !important;
                word-wrap: break-word !important;
                white-space: normal !important;
              }
              .print-table-area th {
                background: #e8e8e8 !important;
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
                font-size: 6pt !important;
                line-height: 1.15 !important;
              }
              .print-table-area td.print-name {
                text-align: left !important;
                font-weight: 600 !important;
                width: 18% !important;
              }
              .print-mark { font-size: 10pt !important; line-height: 1 !important; }
              .no-print, .screen-only, .print-table-area input, .print-table-area label {
                display: none !important;
              }
            }
            @media screen {
              .print-title { display: none; }
              .print-mark { display: none; }
            }
          `,
        }}
      />

      <div className="h-16 border-b border-slate-200 flex items-center justify-between px-6 bg-slate-50 shrink-0 no-print">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900">{checklist.name}</h2>
          <p className="text-xs text-slate-500">
            {visibleFields.length} of {ALL_FIELDS.length} columns · print landscape
          </p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={handleDownloadCSV}
            className="px-4 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100"
          >
            CSV
          </button>
          <button
            type="button"
            onClick={handlePrint}
            className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100"
          >
            Print
          </button>
          <button
            type="button"
            onClick={() => setIsColumnModalOpen(true)}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Columns
          </button>
          <button
            type="button"
            onClick={handleDeleteChecklist}
            className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
          >
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar print-table-area">
        <div className="print-title">{checklist.name} — Checklist</div>
        <table className="border-collapse w-full text-xs">
          <thead className="bg-slate-100 sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 bg-slate-100 border-b border-r border-slate-300 p-3 text-left min-w-[140px]">
                Profile
              </th>
              <th className="border-b border-r border-slate-300 p-2 min-w-[90px]">Phone</th>
              <th className="border-b border-r border-slate-300 p-2 min-w-[70px]">Status</th>
              {visibleFields.map((field) => (
                <th
                  key={field}
                  className="border-b border-r border-slate-300 p-1 text-center font-semibold text-slate-600 bg-slate-50"
                >
                  {field}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {checklist.profiles.map((profile) => {
              const data = profileData[profile.id]
              if (!data) return null
              return (
                <tr key={profile.id} className="hover:bg-slate-50">
                  <td className="sticky left-0 z-10 bg-white border-b border-r border-slate-200 p-2 font-medium text-slate-900 print-name">
                    {profile.full_name}
                    {profile.broker_name && (
                      <div className="text-[10px] text-slate-400 font-normal screen-only">
                        {profile.broker_name}
                      </div>
                    )}
                  </td>
                  <td className="border-b border-r border-slate-200 p-2 text-slate-600">
                    {profile.phone_number || '—'}
                  </td>
                  <td className="border-b border-r border-slate-200 p-2">
                    <span className="screen-only px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100">
                      {profile.status || 'Pending'}
                    </span>
                    <span className="print-mark">{profile.status || 'Pending'}</span>
                  </td>
                  {visibleFields.map((fieldName) => {
                    const fieldObj = data.fields.find((f) => f.name === fieldName)
                    const file = fieldObj?.files?.[0]
                    return (
                      <td
                        key={fieldName}
                        className="border-b border-r border-slate-200 p-1 text-center align-middle"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleDrop(e, profile.id, fieldObj?.id)}
                      >
                        <span className="print-mark">{file ? '✅' : '☐'}</span>
                        <div className="screen-only">
                          {file ? (
                            file.mimetype?.startsWith('image/') ? (
                              <img
                                src={`/api/files/${file.id}/thumbnail`}
                                className="w-12 h-12 object-cover rounded mx-auto border border-slate-200"
                                alt=""
                              />
                            ) : (
                              <div className="w-12 h-12 bg-slate-100 rounded mx-auto flex items-center justify-center text-slate-400">
                                📄
                              </div>
                            )
                          ) : (
                            <label className="flex flex-col items-center justify-center w-12 h-12 mx-auto border-2 border-dashed border-slate-200 rounded-lg cursor-pointer hover:border-teal-400 hover:bg-teal-50 no-print">
                              <span className="text-slate-300 text-lg">+</span>
                              <input
                                type="file"
                                className="hidden"
                                accept="image/*,application/pdf"
                                onChange={(e) => {
                                  if (e.target.files[0]) {
                                    handleUpload(profile.id, fieldObj?.id, e.target.files[0])
                                  }
                                }}
                              />
                            </label>
                          )}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {isColumnModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4 no-print">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="font-bold text-slate-800">Manage Columns</h3>
              <button type="button" onClick={() => setIsColumnModalOpen(false)} className="text-slate-400">
                ✕
              </button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                {ALL_FIELDS.map((field) => (
                  <label
                    key={field}
                    className="flex items-center gap-2 p-2 rounded hover:bg-slate-50 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={visibleFields.includes(field)}
                      onChange={() => toggleField(field)}
                      className="w-4 h-4 text-teal-600 rounded border-slate-300"
                    />
                    <span className="text-slate-700 truncate">{field}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-between">
              <button type="button" onClick={resetColumns} className="text-sm text-red-600 font-medium">
                Reset
              </button>
              <button
                type="button"
                onClick={() => setIsColumnModalOpen(false)}
                className="px-4 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
