import { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import Input from '../components/shared/Input'
import Spinner from '../components/shared/Spinner'

const TOKEN_HELP = [
  ['Personal', 'FULL_NAME, GIVEN_NAMES, SURNAME, NATIONALITY, SEX, DOB, AGE'],
  ['Identity', 'PASSPORT_NO, PLACE_OF_BIRTH, RELIGION, MARITAL_STATUS, CHILDREN_COUNT'],
  ['Physical', 'WEIGHT, HEIGHT, COMPLEXION, LIVING_TOWN, REGION, ZONE_SUBCITY'],
  ['Family', 'MOTHER_NAME, FATHER_NAME, SPOUSE_NAME'],
  ['Contact', 'PHONE, EDUCATION, ENGLISH, ARABIC'],
  ['Job', 'POST_APPLIED, SALARY, CURRENCY, COUNTRY, CONTRACT_YEARS, REF_NO, DATE_TODAY'],
  ['Skills', 'SKILL_CLEANING, SKILL_IRONING, SKILL_WASHING, SKILL_BABY_SITTING, SKILL_COOKING, COOKING_SKILL'],
  ['Emergency', 'EMERGENCY_NAME, EMERGENCY_PHONE, EMERGENCY_GENDER, EMERGENCY_RELATIONSHIP, LABOR_ID, PERSONAL_NUMBER'],
  ['Previous', 'PREV_COUNTRY, PREV_PERIOD, PREV_POSITION'],
  ['Media', 'PHOTO_URL, FULL_BODY_PHOTO_URL, PASSPORT_URL'],
  ['Injected (do NOT put in your template)', 'HEADER_IMAGE, FOOTER_IMAGE — added automatically at top/bottom of every page'],
]

export default function CVTemplateEditPage() {
  const { id } = useParams()
  const isEdit = Boolean(id)
  const navigate = useNavigate()
  const [loading, setLoading] = useState(isEdit)
  const [saving, setSaving] = useState(false)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [showTokens, setShowTokens] = useState(false)

  const [form, setForm] = useState({
    name: '', agency_name: '', agency_name_ar: '',
    salary: '', currency: 'SAR', country: '', contract_years: 2,
    is_active: true,
    include_passport: false,
    passport_h1: '',
    passport_h1_color: '#000000',
    passport_include_header: true,
    passport_include_footer: true,
    html_content: '', css_content: '',
  })
  const [headerPath, setHeaderPath] = useState(null)
  const [footerPath, setFooterPath] = useState(null)
  const headerRef = useRef(null)
  const footerRef = useRef(null)

  // Load existing template
  useEffect(() => {
    if (!isEdit) return
    setLoading(true)
    api.get(`/cv/templates/${id}`).then(r => {
      const t = r.data
      setForm({
        name: t.name || '',
        agency_name: t.agency_name || '',
        agency_name_ar: t.agency_name_ar || '',
        salary: t.salary ?? '',
        currency: t.currency || 'SAR',
        country: t.country || '',
        contract_years: t.contract_years ?? 2,
        is_active: t.is_active !== false,
        include_passport: !!t.include_passport,
        passport_h1: t.passport_h1 || '',
        passport_h1_color: t.passport_h1_color || '#000000',
        passport_include_header: t.passport_include_header !== false,
        passport_include_footer: t.passport_include_footer !== false,
        html_content: t.html_content || '',
        css_content: t.css_content || '',
      })
      setHeaderPath(t.header_path || null)
      setFooterPath(t.footer_path || null)
    }).catch(() => { toast.error('Load failed'); navigate('/cvs/templates') })
      .finally(() => setLoading(false))
  }, [id, isEdit, navigate])

  const upd = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    if (!form.name.trim()) return toast.error('Name is required')
    if (!form.html_content.trim()) return toast.error('HTML is required')
    setSaving(true)
    try {
      if (isEdit) {
        await api.patch(`/cv/templates/${id}`, {
          name: form.name,
          agency_name: form.agency_name,
          agency_name_ar: form.agency_name_ar,
          salary: form.salary === '' ? null : Number(form.salary),
          currency: form.currency,
          country: form.country,
          contract_years: Number(form.contract_years) || 2,
          is_active: form.is_active,
          include_passport: form.include_passport,
          passport_h1: form.passport_h1,
          passport_h1_color: form.passport_h1_color,
          passport_include_header: form.passport_include_header,
          passport_include_footer: form.passport_include_footer,
        })
        // Also update HTML/CSS via a dedicated endpoint
        await api.put(`/cv/templates/${id}/content`, {
          html_content: form.html_content,
          css_content: form.css_content,
        })
        toast.success('Template updated')
      } else {
        const r = await api.post('/cv/templates', {
          ...form,
          salary: form.salary === '' ? null : Number(form.salary),
          contract_years: Number(form.contract_years) || 2,
        })
        toast.success('Template created')
        navigate(`/cvs/templates/${r.data.id}/edit`)
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  const uploadImage = async (kind, file) => {
    if (!isEdit) {
      toast.error('Save the template first, then upload header/footer')
      return
    }
    if (!file) return
    const fd = new FormData()
    fd.append(kind, file)
    try {
      await api.post(`/cv/templates/${id}/${kind}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      if (kind === 'header') setHeaderPath('x')  // placeholder to trigger re-render
      else setFooterPath('x')
      // Re-fetch path
      const r = await api.get(`/cv/templates/${id}`)
      setHeaderPath(r.data.header_path || null)
      setFooterPath(r.data.footer_path || null)
      toast.success(`${kind} uploaded`)
    } catch (e) { toast.error('Upload failed') }
  }

  const removeImage = async (kind) => {
    if (!confirm(`Remove ${kind}?`)) return
    try {
      await api.delete(`/cv/templates/${id}/${kind}`)
      if (kind === 'header') setHeaderPath(null)
      else setFooterPath(null)
      toast.success('Removed')
    } catch { toast.error('Remove failed') }
  }

  const openPreview = async () => {
    if (!form.html_content.trim()) return toast.error('HTML is empty')
    try {
      const r = await api.post('/cv/templates/preview-html', {
        html_content: form.html_content,
        css_content: form.css_content,
      }, { responseType: 'text' })
      const blob = new Blob([r.data], { type: 'text/html' })
      const url = URL.createObjectURL(blob)
      setPreviewUrl(url)
    } catch (e) {
      toast.error('Preview failed')
    }
  }

  if (loading) return <div className="flex h-64 items-center justify-center"><Spinner /></div>

  const headerUrl = headerPath ? `/api/cv/templates/${id}/header-image?t=${Date.now()}` : null
  const footerUrl = footerPath ? `/api/cv/templates/${id}/footer-image?t=${Date.now()}` : null

  return (
    <div className="animate-fade-up space-y-5 pb-24">
      <PageHeader
        title={isEdit ? `Edit: ${form.name || '—'}` : 'New Template'}
        subtitle="Write the HTML/CSS once, reuse for any candidate"
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => navigate('/cvs/templates')}>← Back</Button>
            <Button variant="secondary" onClick={openPreview}>Preview</Button>
            <Button onClick={save} isLoading={saving}>{isEdit ? 'Save changes' : 'Create template'}</Button>
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* LEFT: metadata */}
        <section className="panel p-5 space-y-3 lg:col-span-1">
          <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">Metadata</h3>

          <Input label="Name *" value={form.name} onChange={e => upd('name', e.target.value.toUpperCase())} placeholder="AL-SHAHD ALMASI" />
          <Input label="Agency name (EN)" value={form.agency_name} onChange={e => upd('agency_name', e.target.value)} />
          <Input label="Agency name (AR)" value={form.agency_name_ar} onChange={e => upd('agency_name_ar', e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <Input label="Salary" type="number" value={form.salary} onChange={e => upd('salary', e.target.value)} />
            <Input label="Currency" value={form.currency} onChange={e => upd('currency', e.target.value.toUpperCase())} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input label="Country" value={form.country} onChange={e => upd('country', e.target.value.toUpperCase())} placeholder="SA" />
            <Input label="Contract (yrs)" type="number" value={form.contract_years} onChange={e => upd('contract_years', e.target.value)} />
          </div>

          <label className="flex items-center gap-2 text-sm pt-2">
            <input type="checkbox" checked={form.is_active} onChange={e => upd('is_active', e.target.checked)} />
            Active
          </label>

          {/* Header image */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Header image</p>
            <div className="relative w-full min-h-[80px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 flex items-center justify-center overflow-hidden">
              {headerUrl ? <img src={headerUrl} className="max-w-full max-h-24 object-contain" alt="header" /> : <span className="text-[10px] text-slate-400">No header</span>}
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => headerRef.current?.click()} disabled={!isEdit}
                className="flex-1 py-1.5 text-xs rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50">
                {headerUrl ? 'Replace' : 'Upload'}
              </button>
              {headerUrl && (
                <button onClick={() => removeImage('header')}
                  className="py-1.5 px-3 text-xs rounded-md bg-red-50 text-red-600 hover:bg-red-100">
                  Remove
                </button>
              )}
            </div>
            <input ref={headerRef} type="file" accept="image/*" className="hidden"
              onChange={e => uploadImage('header', e.target.files?.[0])} />
          </div>

          {/* Footer image */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Footer image</p>
            <div className="relative w-full min-h-[60px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 flex items-center justify-center overflow-hidden">
              {footerUrl ? <img src={footerUrl} className="max-w-full max-h-20 object-contain" alt="footer" /> : <span className="text-[10px] text-slate-400">No footer</span>}
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => footerRef.current?.click()} disabled={!isEdit}
                className="flex-1 py-1.5 text-xs rounded-md bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50">
                {footerUrl ? 'Replace' : 'Upload'}
              </button>
              {footerUrl && (
                <button onClick={() => removeImage('footer')}
                  className="py-1.5 px-3 text-xs rounded-md bg-red-50 text-red-600 hover:bg-red-100">
                  Remove
                </button>
              )}
            </div>
            <input ref={footerRef} type="file" accept="image/*" className="hidden"
              onChange={e => uploadImage('footer', e.target.files?.[0])} />
          </div>

          {/* Passport page 2 config */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-700">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Passport page 2</p>

            <label className="flex items-center gap-2 text-sm mb-2">
              <input type="checkbox" checked={form.include_passport} onChange={e => upd('include_passport', e.target.checked)} />
              Include passport page
            </label>

            {form.include_passport && (
              <div className="pl-6 space-y-2 pt-1">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.passport_include_header} onChange={e => upd('passport_include_header', e.target.checked)} />
                  Include header on page 2
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.passport_include_footer} onChange={e => upd('passport_include_footer', e.target.checked)} />
                  Include footer on page 2
                </label>

                <div className="pt-1">
                  <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">Title (H1) above passport</label>
                  <input
                    type="text"
                    value={form.passport_h1}
                    onChange={e => upd('passport_h1', e.target.value)}
                    placeholder="Leave blank for no title"
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                  {form.passport_h1 && (
                    <div className="flex items-center gap-2 mt-2">
                      <label className="text-xs text-slate-500">Color:</label>
                      <input
                        type="color"
                        value={form.passport_h1_color}
                        onChange={e => upd('passport_h1_color', e.target.value)}
                        className="w-10 h-8 rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
                      />
                      <input
                        type="text"
                        value={form.passport_h1_color}
                        onChange={e => upd('passport_h1_color', e.target.value)}
                        className="w-28 px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono"
                      />
                      <span className="text-xs font-bold" style={{ color: form.passport_h1_color }}>
                        Preview: {form.passport_h1}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {!isEdit && (
            <p className="text-[11px] text-amber-600 mt-2">
              Upload header & footer after saving the template.
            </p>
          )}
        </section>

        {/* RIGHT: HTML + CSS */}
        <section className="panel p-5 space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-bold text-slate-900 dark:text-white">Template code</h3>
            <button onClick={() => setShowTokens(v => !v)} className="text-xs text-teal-600 hover:underline">
              {showTokens ? 'Hide' : 'Show'} tokens
            </button>
          </div>

          {showTokens && (
            <div className="text-[11px] bg-slate-50 dark:bg-slate-900/60 rounded-lg p-3 border border-slate-200 dark:border-slate-700 space-y-1.5 max-h-56 overflow-y-auto">
              {TOKEN_HELP.map(([cat, list]) => (
                <div key={cat}>
                  <b className="text-slate-700 dark:text-slate-200">{cat}:</b>{' '}
                  <span className="text-slate-500 break-all">{list}</span>
                </div>
              ))}
              <p className="text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700 mt-2">
                Wrap each in <code className="bg-slate-200 dark:bg-slate-800 px-1 rounded">{'{{'}</code>{'TOKEN'}<code className="bg-slate-200 dark:bg-slate-800 px-1 rounded">{'}}'}</code>
              </p>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">HTML *</label>
            <textarea
              className="w-full h-72 px-3 py-2 font-mono text-[11px] leading-snug rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:border-teal-500 focus:outline-none resize-y"
              value={form.html_content}
              onChange={e => upd('html_content', e.target.value)}
              placeholder={'<div style="padding:20px;">\n  <h1>{{FULL_NAME}}</h1>\n  <p>Passport: {{PASSPORT_NO}}</p>\n  <img src="{{PHOTO_URL}}" style="width:40mm;">\n</div>'}
              spellCheck={false}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1">CSS (optional)</label>
            <textarea
              className="w-full h-40 px-3 py-2 font-mono text-[11px] leading-snug rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-100 focus:border-teal-500 focus:outline-none resize-y"
              value={form.css_content}
              onChange={e => upd('css_content', e.target.value)}
              placeholder={'table { border-collapse: collapse; width: 100%; }\ntd, th { border: 1px solid #000; padding: 4px; }'}
              spellCheck={false}
            />
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={save} isLoading={saving}>{isEdit ? 'Save changes' : 'Create template'}</Button>
          </div>
        </section>
      </div>

      {/* Preview modal */}
      {previewUrl && (
        <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-4" onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }}>
          <div className="relative bg-white rounded-2xl w-[96vw] max-w-[1500px] h-[94vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b bg-slate-50">
              <span className="text-sm font-medium">Preview (sample data)</span>
              <button onClick={() => { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }}
                className="px-3 py-1 rounded-md bg-slate-200 hover:bg-slate-300 text-xs">Close</button>
            </div>
            <iframe src={previewUrl} className="flex-1 w-full border-0 bg-white" title="Preview" />
          </div>
        </div>
      )}
    </div>
  )
}
