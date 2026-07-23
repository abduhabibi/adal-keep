import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useFileCapture } from '../context/FileCaptureContext'

const ALL_FIELDS = [
  'Government ID', 'Passport', 'CV', 'Contract', 'Medical Report', 'Insurance', 'COC', 'Visa', 
  'Saudi-letter', 'Musaned', 'Broker ID', 'Ticket-ongoing', 'Ticket-deported', 'Police Clearance', 
  'Labour ID', 'Slip', 'Experience Form', 'Employee ID', 'Client ID'
]

export default function ChecklistGridView({ checklist, onClose }) {
  const navigate = useNavigate()
  const [profileData, setProfileData] = useState({})
  const [loading, setLoading] = useState(true)
  const [isColumnModalOpen, setIsColumnModalOpen] = useState(false)
  
  const [visibleFields, setVisibleFields] = useState(() => {
    const saved = localStorage.getItem('adal_visible_fields')
    return saved ? JSON.parse(saved) : ALL_FIELDS
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
      const promises = checklist.profiles.map(p => 
        api.get(`/profiles/${p.id}/fields`).then(res => ({ profile: p, fields: res.data }))
      )
      const results = await Promise.all(promises)
      const dataMap = {}
      results.forEach(({ profile, fields }) => {
        dataMap[profile.id] = { profile, fields }
      })
      setProfileData(dataMap)
    } catch (err) {
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
      setProfileData(prev => ({
        ...prev,
        [profileId]: { ...prev[profileId], fields: res.data }
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

  // --- NEW: Download CSV Logic ---
  const handleDownloadCSV = () => {
    // 1. Define Headers (Name, Phone, Status, Broker + Visible Fields)
    const headers = ['Full Name', 'Phone', 'Status', 'Broker', ...visibleFields]
    
    // 2. Build Rows
    const rows = checklist.profiles.map(p => {
      const data = profileData[p.id]
      const row = [
        `"${p.full_name}"`,
        `"${p.phone_number || ''}"`,
        `"${p.status || 'Pending'}"`,
        `"${p.broker_name || 'Unassigned'}"`
      ]
      
      // Add status for each visible field
      visibleFields.forEach(field => {
        const fieldObj = data?.fields?.find(f => f.name === field)
        const hasFile = fieldObj?.files?.length > 0
        row.push(hasFile ? '"✅ Uploaded"' : '"❌ Missing"')
      })
      
      return row.join(',')
    })

    // 3. Create and trigger download
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
    toast.success('CSV downloaded successfully')
  }

  // --- NEW: Print Logic ---
  const handlePrint = () => {
    window.print()
  }

  const toggleField = (field) => {
    if (visibleFields.includes(field)) {
      setVisibleFields(visibleFields.filter(f => f !== field))
    } else {
      setVisibleFields([...visibleFields, field])
    }
  }

  const resetColumns = () => {
    setVisibleFields(ALL_FIELDS)
    toast.success('All columns restored')
  }

  if (loading) return <div className="flex h-full items-center justify-center text-slate-500">Loading grid data...</div>

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col print:static print:z-auto">
      {/* Print Styles */}
      <style>{`
        @media print {
          .print\\:hidden { display: none !important; }
          .print\\:w-full { width: 100% !important; }
          .print\\:text-xs { font-size: 10pt !important; }
          body { background: white !important; }
          table { width: 100% !important; border-collapse: collapse !important; }
          th, td { border: 1px solid #cbd5e1 !important; padding: 6px !important; }
          th { background-color: #f1f5f9 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      {/* Header */}
      <div className="h-16 border-b border-slate-200 flex items-center justify-between px-6 bg-slate-50 shrink-0 print:hidden">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900">{checklist.name}</h2>
          <p className="text-xs text-slate-500">Maximized View • {visibleFields.length} of {ALL_FIELDS.length} columns visible</p>
        </div>
        <div className="flex gap-2">
          {/* NEW: Print & Download Buttons */}
          <button 
            onClick={handleDownloadCSV} 
            className="px-4 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Download CSV
          </button>
          <button 
            onClick={handlePrint} 
            className="px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
            Print Grid
          </button>

          {/* Existing Buttons */}
          <button 
            onClick={() => setIsColumnModalOpen(true)} 
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" /></svg>
            Manage Columns
          </button>
          <button 
            onClick={handleDeleteChecklist} 
            className="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.133 21H7.867a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            Delete Checklist
          </button>
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
            ✕ Close
          </button>
        </div>
      </div>

      {/* Scrollable Grid */}
      <div className="flex-1 overflow-auto custom-scrollbar print:overflow-visible">
        <table className="border-collapse w-full text-xs print:text-xs">
          <thead className="bg-slate-100 sticky top-0 z-10 print:static">
            <tr>
              <th className="sticky left-0 z-20 bg-slate-100 border-b border-r border-slate-300 p-3 text-left min-w-[200px] print:static">Profile Name</th>
              <th className="border-b border-r border-slate-300 p-3 min-w-[120px]">Phone</th>
              <th className="border-b border-r border-slate-300 p-3 min-w-[100px]">Status</th>
              {visibleFields.map(field => (
                <th key={field} className="border-b border-r border-slate-300 p-2 min-w-[100px] text-center font-semibold text-slate-600 bg-slate-50">
                  {field}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {checklist.profiles.map(profile => {
              const data = profileData[profile.id]
              if (!data) return null
              
              return (
                <tr key={profile.id} className="hover:bg-slate-50">
                  <td className="sticky left-0 z-10 bg-white border-b border-r border-slate-200 p-3 font-medium text-slate-900 print:static">
                    {profile.full_name}
                    {profile.broker_name && <div className="text-[10px] text-slate-400 font-normal">{profile.broker_name}</div>}
                  </td>
                  <td className="border-b border-r border-slate-200 p-3 text-slate-600">{profile.phone_number || '—'}</td>
                  <td className="border-b border-r border-slate-200 p-3">
                    <span className={`px-2 py-1 rounded-full text-[10px] font-bold ${
                      profile.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : 
                      profile.status === 'in_progress' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'
                    }`}>
                      {profile.status || 'Pending'}
                    </span>
                  </td>
                  
                  {visibleFields.map(fieldName => {
                    const fieldObj = data.fields.find(f => f.name === fieldName)
                    const file = fieldObj?.files?.[0]
                    
                    return (
                      <td 
                        key={fieldName} 
                        className="border-b border-r border-slate-200 p-1 text-center align-middle"
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleDrop(e, profile.id, fieldObj?.id)}
                      >
                        {file ? (
                          <div className="group relative">
                            {file.mimetype?.startsWith('image/') ? (
                              <img src={`/api/files/${file.id}/thumbnail`} className="w-12 h-12 object-cover rounded mx-auto border border-slate-200" alt="" />
                            ) : (
                              <div className="w-12 h-12 bg-slate-100 rounded mx-auto flex items-center justify-center text-slate-400">
                                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                              </div>
                            )}
                          </div>
                        ) : (
                          <label className="flex flex-col items-center justify-center w-12 h-12 mx-auto border-2 border-dashed border-slate-200 rounded-lg cursor-pointer hover:border-teal-400 hover:bg-teal-50 transition-colors group print:border-solid print:border-slate-300 print:bg-white">
                            <svg className="w-5 h-5 text-slate-300 group-hover:text-teal-500 print:hidden" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                            <span className="text-[10px] text-slate-400 print:block hidden">Missing</span>
                            <input 
                              type="file" 
                              className="hidden print:hidden" 
                              accept="image/*,application/pdf"
                              onChange={(e) => {
                                if (e.target.files[0]) handleUpload(profile.id, fieldObj?.id, e.target.files[0])
                              }} 
                            />
                          </label>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Column Manager Modal (Unchanged) */}
      {isColumnModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4 print:hidden">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex justify-between items-center">
              <h3 className="font-bold text-slate-800">Manage Columns</h3>
              <button onClick={() => setIsColumnModalOpen(false)} className="text-slate-400 hover:text-slate-600"></button>
            </div>
            <div className="p-4 max-h-[60vh] overflow-y-auto custom-scrollbar">
              <p className="text-xs text-slate-500 mb-3">Uncheck fields to hide them. Changes are saved permanently.</p>
              <div className="grid grid-cols-2 gap-2">
                {ALL_FIELDS.map(field => (
                  <label key={field} className="flex items-center gap-2 p-2 rounded hover:bg-slate-50 cursor-pointer text-sm">
                    <input 
                      type="checkbox" 
                      checked={visibleFields.includes(field)}
                      onChange={() => toggleField(field)}
                      className="w-4 h-4 text-teal-600 rounded border-slate-300 focus:ring-teal-500"
                    />
                    <span className="text-slate-700 truncate">{field}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-between">
              <button onClick={resetColumns} className="text-sm text-red-600 hover:text-red-700 font-medium">
                Reset to Default (19)
              </button>
              <button onClick={() => setIsColumnModalOpen(false)} className="px-4 py-2 text-sm font-medium bg-teal-600 text-white rounded-lg hover:bg-teal-700">
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}