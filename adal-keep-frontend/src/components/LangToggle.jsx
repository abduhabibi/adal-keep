/** አማ | EN: switches the whole app between Amharic and English (as Settings → Language). */
import api from '../services/api'
import { getLang, setLang } from '../lib/i18n'

const whoAmI = () => { try { return JSON.parse(localStorage.getItem('adal_active_employee') || 'null')?.name || '' } catch { return '' } }

export default function LangToggle({ className = '' }) {
  const now = getLang()
  const pick = (id) => {
    if (id === now) return
    // The tips panel follows the language; the switch never waits for the PC.
    Promise.race([api.post('/tutor/lang', { who: whoAmI(), lang: id }).catch(() => {}), new Promise(r => setTimeout(r, 800))])
      .finally(() => setLang(id))
  }
  return (
    <span translate="no" className={`inline-flex shrink-0 overflow-hidden rounded-lg border border-slate-300 text-sm font-semibold dark:border-slate-600 ${className}`}>
      {[['am', 'አማ'], ['en', 'EN']].map(([id, label]) => (
        <button key={id} type="button" onClick={() => pick(id)} aria-pressed={now === id}
          title={id === 'am' ? 'አማርኛ' : 'English'}
          className={`px-2.5 py-1.5 transition ${now === id ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
          {label}
        </button>
      ))}
    </span>
  )
}
