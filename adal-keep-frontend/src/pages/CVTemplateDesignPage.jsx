import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import PageHeader from '../components/shared/PageHeader'
import Button from '../components/shared/Button'
import { DESIGN_LIST, COLOR_PAIRS, designHtml, palette } from '../lib/cvDesigns'

// The passport page's title colour stays the same for every new template
// once chosen (kept on this PC).
const PASSPORT_KEY = 'adal-cv-passport-color'
const readPassportColor = () => { try { return localStorage.getItem(PASSPORT_KEY) || '#0f172a' } catch { return '#0f172a' } }

/** One design rendered with sample data (the real CV engine), first page only when small. */
function Preview({ id, primary, secondary, header, passport, small }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    let gone = false
    const t = setTimeout(async () => {
      try {
        const { html: html_content, css: css_content } = designHtml(id, primary, secondary)
        const r = await api.post('/cv/templates/preview-html', {
          html_content, css_content, header_data_url: header || undefined,
          include_passport: !small, passport_h1: passport.title, passport_h1_color: passport.color,
        }, { responseType: 'text' })
        if (!gone) setHtml(r.data)
      } catch { if (!gone) setHtml('<p style="font:14px Arial;padding:20px">Preview failed</p>') }
    }, small ? 350 : 200)
    return () => { gone = true; clearTimeout(t) }
  }, [id, primary, secondary, header, passport.title, passport.color, small])
  // A4 is 794 px wide on screen.
  const scale = small ? 0.27 : 0.75
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-slate-200 dark:ring-slate-700" style={{ width: 794 * scale, height: (small ? 1123 : 1123 * 2 + 40) * scale }}>
      {html
        ? <iframe title={id} srcDoc={html} style={{ width: 794, height: small ? 1123 : 1123 * 2 + 40, border: 0, transform: `scale(${scale})`, transformOrigin: '0 0', pointerEvents: small ? 'none' : 'auto' }} />
        : <div className="h-full animate-pulse bg-slate-100 dark:bg-slate-800" />}
    </div>
  )
}

export default function CVTemplateDesignPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [nameAr, setNameAr] = useState('')
  const [primary, setPrimary] = useState(COLOR_PAIRS[0][0])
  const [secondary, setSecondary] = useState(COLOR_PAIRS[0][1])
  const [design, setDesign] = useState('classic')
  const [headerFile, setHeaderFile] = useState(null)
  const [header, setHeader] = useState('')
  const [passportTitle, setPassportTitle] = useState('Passport')
  const [passportColor, setPassportColor] = useState(readPassportColor)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef(null)
  const pal = useMemo(() => palette(primary, secondary), [primary, secondary])
  const passport = { title: passportTitle, color: passportColor }

  useEffect(() => { try { localStorage.setItem(PASSPORT_KEY, passportColor) } catch {} }, [passportColor])

  const pickHeader = (f) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return toast.error('The header must be a picture (PNG or JPG)')
    setHeaderFile(f)
    const r = new FileReader()
    r.onload = () => setHeader(String(r.result))
    r.readAsDataURL(f)
  }

  const save = async () => {
    if (!name.trim()) return toast.error('Type the agency (template) name')
    if (!headerFile) return toast.error('Upload the agency header picture')
    setSaving(true)
    const t = toast.loading('Saving the template…')
    try {
      const { html: html_content, css: css_content } = designHtml(design, primary, secondary)
      const { data } = await api.post('/cv/templates', { name: name.trim(), agency_name: name.trim(), agency_name_ar: nameAr.trim(), html_content, css_content })
      const fd = new FormData()
      fd.append('header', headerFile)
      await api.post(`/cv/templates/${data.id}/header`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      await api.patch(`/cv/templates/${data.id}`, { include_passport: 1, passport_h1: passportTitle, passport_h1_color: passportColor, passport_include_header: 1 })
      toast.success('Template saved — it is ready for CVs', { id: t })
      navigate('/cvs/templates')
    } catch (e) {
      toast.error(e.response?.data?.error || 'Not saved', { id: t })
    } finally { setSaving(false) }
  }

  const swatch = (c) => <span className="inline-block h-4 w-4 rounded-full ring-1 ring-black/10" style={{ background: c }} />

  return (
    <div className="space-y-5">
      <PageHeader title="Create a CV template" subtitle="Your header, two colours, a design — the passport page is always included."
        action={<div className="flex gap-2"><Button variant="secondary" onClick={() => navigate('/cvs/templates')}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : '✓ Save template'}</Button></div>} />

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        {/* Choices */}
        <div className="space-y-4">
          <div className="panel space-y-3 p-4">
            <p className="text-sm font-bold">1. The agency</p>
            <input className="field w-full" placeholder="Agency / template name (e.g. AL-NOOR)" value={name} onChange={e => setName(e.target.value)} />
            <input className="field w-full text-right" dir="rtl" placeholder="الاسم بالعربية (اختياري)" value={nameAr} onChange={e => setNameAr(e.target.value)} />
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => pickHeader(e.target.files?.[0])} />
            <button type="button" onClick={() => fileRef.current?.click()}
              className="flex min-h-[64px] w-full items-center justify-center rounded-lg border-2 border-dashed border-slate-300 p-2 text-sm text-slate-500 hover:border-teal-500 dark:border-slate-600">
              {header ? <img src={header} alt="header" className="max-h-20 max-w-full object-contain" /> : '⬆ Upload the header picture'}
            </button>
          </div>

          <div className="panel space-y-3 p-4">
            <p className="text-sm font-bold">2. Two colours</p>
            <div className="flex gap-3">
              {[['Main', primary, setPrimary], ['Second', secondary, setSecondary]].map(([label, v, set]) => (
                <label key={label} className="flex flex-1 items-center gap-2 rounded-lg border border-slate-200 p-2 text-sm dark:border-slate-700">
                  <input type="color" value={v} onChange={e => set(e.target.value)} className="h-9 w-12 cursor-pointer rounded border-0 bg-transparent" />
                  <span><b>{label}</b><br /><span className="font-mono text-xs text-slate-500">{v}</span></span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {COLOR_PAIRS.map(([a, b]) => (
                <button key={a + b} type="button" title={`${a} + ${b}`} onClick={() => { setPrimary(a); setSecondary(b) }}
                  className={`flex items-center gap-0.5 rounded-full border p-1 ${primary === a && secondary === b ? 'border-teal-500 ring-2 ring-teal-500/30' : 'border-slate-200 dark:border-slate-700'}`}>
                  {swatch(a)}{swatch(b)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-slate-500">Made from them: {swatch(pal.blend)}{swatch(pal.deep)}{swatch(pal.pTint)}{swatch(pal.sTint)}{swatch(pal.soft)}</div>
          </div>

          <div className="panel space-y-3 p-4">
            <p className="text-sm font-bold">3. The passport page</p>
            <div className="flex gap-2">
              <input className="field flex-1" value={passportTitle} onChange={e => setPassportTitle(e.target.value)} placeholder="Title on the passport page" />
              <input type="color" value={passportColor} onChange={e => setPassportColor(e.target.value)} className="h-10 w-12 cursor-pointer rounded border-0 bg-transparent" title="The title's colour — kept for every new template" />
            </div>
            <p className="text-xs text-slate-500">The title colour stays the same for every new template until you change it.</p>
          </div>
        </div>

        {/* Designs */}
        <div className="space-y-4">
          <div className="panel p-4">
            <p className="mb-3 text-sm font-bold">4. Pick a design</p>
            <div className="flex flex-wrap gap-4">
              {DESIGN_LIST.map(([id, label]) => (
                <button key={id} type="button" onClick={() => setDesign(id)}
                  className={`rounded-xl p-1.5 text-left transition ${design === id ? 'bg-teal-50 ring-2 ring-teal-500 dark:bg-teal-900/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                  <Preview id={id} primary={primary} secondary={secondary} header={header} passport={passport} small />
                  <p className="mt-1 text-center text-xs font-semibold">{label}</p>
                </button>
              ))}
            </div>
          </div>
          <div className="panel p-4">
            <p className="mb-3 text-sm font-bold">How it looks (with the passport page)</p>
            <div className="overflow-auto">
              <Preview id={design} primary={primary} secondary={secondary} header={header} passport={passport} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
