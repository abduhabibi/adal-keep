import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import FullBodyCropper from './FullBodyCropper'

/**
 * What the Paste button found, shown before anything is saved (asked on 2026-11-26):
 *   Photo            the frame for a head photo (3:4) — see it, frame it, Save or Cancel
 *   Full Body Photo  the full body frame (1:3), as when it is uploaded
 *   anything else    the picture or PDF as it is, Save (as a picture or a PDF) or Cancel
 * onSave(files, format) — nothing is saved before it. The crop keeps the picture's own pixels (FullBodyCropper).
 */
const HEAD = { ratio: 3 / 4, outW: 900, outH: 1200, title: 'Frame the photo', guides: false, keepLabel: 'Keep the photo as it is' }

export default function PastePreview({ field, files, onSave, onCancel }) {
  const one = files.length === 1 ? files[0] : null
  const picture = one && /^image\//.test(one.type)
  if (picture && field.name === 'Photo') return <FullBodyCropper file={one} {...HEAD} onCancel={onCancel} onDone={(f) => onSave([f], 'image')} />
  if (picture && field.name === 'Full Body Photo') return <FullBodyCropper file={one} onCancel={onCancel} onDone={(f) => onSave([f], 'image')} />
  return <Plain field={field} files={files} onSave={onSave} onCancel={onCancel} />
}

function Plain({ field, files, onSave, onCancel }) {
  const urls = useMemo(() => files.map(f => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach(u => URL.revokeObjectURL(u)), [urls])
  const one = files.length === 1 ? files[0] : null
  const pdf = one?.type === 'application/pdf'
  // One click: the format it already is.
  const main = () => one ? onSave(files, pdf ? 'pdf' : 'image') : onSave(files, null)
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter') { e.preventDefault(); main() } }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })
  return createPortal(
    <div data-testid="paste-preview" className="fixed inset-0 z-[100000] flex items-center justify-center bg-slate-950/80 p-4" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="flex max-h-[94vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900">
        <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h3 className="font-bold text-slate-900 dark:text-white">Paste into {field.name}</h3>
          <p className="text-xs text-slate-500">{one ? one.name : `${files.length} files`} — nothing is saved until you press Save.</p>
        </div>
        <div className="grid min-h-0 flex-1 gap-3 overflow-auto bg-slate-100 p-3 dark:bg-slate-950" style={{ gridTemplateColumns: one ? '1fr' : 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          {files.map((f, i) => /^image\//.test(f.type)
            ? <img key={i} src={urls[i]} alt="" className={`${one ? 'max-h-[70vh]' : 'h-40'} mx-auto w-auto max-w-full rounded-lg bg-white object-contain shadow`} />
            : f.type === 'application/pdf'
              ? <iframe key={i} src={`${urls[i]}#toolbar=0&view=FitH`} title={f.name} className={`${one ? 'h-[70vh]' : 'h-40'} w-full rounded-lg bg-white`} />
              : <div key={i} className="rounded-lg bg-white p-4 text-sm">{f.name}</div>)}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
          <button type="button" onClick={onCancel} className="mr-auto rounded-lg px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
          {one && <button type="button" onClick={() => onSave(files, pdf ? 'image' : 'pdf')} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold dark:border-slate-600">{pdf ? 'Save as a picture' : 'Save as a PDF'}</button>}
          <button type="button" data-testid="paste-save" onClick={main} className="rounded-lg bg-teal-600 px-5 py-2 text-sm font-bold text-white hover:bg-teal-700">{one ? 'Save' : `Save all ${files.length}`}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
