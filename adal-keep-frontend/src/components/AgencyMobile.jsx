/** Under the pop-up's mobile box: where the shown number comes from, and the agency's saved one — save it, change it, remove it. */
import { Component, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import { mobileOk, sameMobile } from '../lib/popupMobile'

function Line({ shown, saved, onSaved }) {
  const [edit, setEdit] = useState(null)   // null: closed
  const [busy, setBusy] = useState(false)
  const put = async (mobile) => {
    setBusy(true)
    try { const { data } = await api.put('/settings/step-popup/mobile', { mobile }); onSaved(data.mobile); setEdit(null); toast.success(data.mobile ? `The agency's number: ${data.mobile}` : 'The agency\'s number was removed') }
    catch (e) { toast.error(e.response?.data?.error || e.message) }
    setBusy(false)
  }
  const link = 'font-semibold text-teal-700 hover:underline disabled:opacity-50 dark:text-teal-300'
  if (edit !== null) return (
    <span className="mt-2 block rounded-xl border border-slate-200 p-2 font-normal dark:border-slate-700">
      <span className="block text-xs text-slate-600 dark:text-slate-300">The agency's number, for every girl with none (girls who have one keep it)</span>
      <span className="mt-1 flex flex-wrap items-center gap-3">
        <input autoFocus inputMode="tel" aria-label="The agency's number" className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800" value={edit}
          onChange={e => setEdit(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (mobileOk(edit)) put(edit) } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation?.(); setEdit(null) } }} />
        <button type="button" className={link} disabled={busy || !mobileOk(edit)} onClick={() => put(edit)}>Save</button>
        {saved && <button type="button" className={link} disabled={busy} onClick={() => put('')}>Remove</button>}
        <button type="button" className="text-slate-500 hover:underline" onClick={() => setEdit(null)}>Cancel</button>
      </span>
    </span>
  )
  return (
    <span className="mt-1 flex flex-wrap gap-x-3 text-xs font-normal text-slate-500">
      {shown.from === 'agency' && <span>The agency's saved number: press Save to use it for her</span>}
      {saved && shown.from !== 'agency' && !sameMobile(shown.value, saved) && <span>Agency: <span translate="no">{saved}</span></span>}
      {saved ? <button type="button" className={link} onClick={() => setEdit(saved)}>Change the saved number</button>
        : <button type="button" className={link} onClick={() => setEdit(mobileOk(shown.value) ? shown.value : '')}>Save a number for every girl</button>}
    </span>
  )
}

export default class AgencyMobile extends Component {
  state = { bad: false }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { console.warn('[agency mobile]', e) }
  render() { return this.state.bad ? null : <Line {...this.props} /> }
}
