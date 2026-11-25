import { Component, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from './shared/Icon'
import { ethiopianDate, greeting } from '../lib/ethiopic'
import { getLang } from '../lib/i18n'
import './morningHeader.css'

/**
 * The dashboard's header: the greeting with the person's name, the date in both
 * calendars, the agency and one Tasks button. Nothing is asked of the PC for it.
 */
const LOCALE = { en: 'en-GB', am: 'en-GB', ar: 'ar-EG' }
const gregorian = (d) => d.toLocaleDateString(LOCALE[getLang()] || 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
const ethiopian = (d) => { const e = ethiopianDate(d); return `${e.weekday}፣ ${e.monthName} ${e.day} ቀን ${e.year} ዓ.ም.` }

function Header({ name, company, place }) {
  const [now, setNow] = useState(() => new Date())
  // Looked at again (the window in front): the greeting and the day may have changed. No timer.
  useEffect(() => {
    const on = () => { if (!document.hidden) setNow(new Date()) }
    document.addEventListener('visibilitychange', on)
    window.addEventListener('focus', on)
    return () => { document.removeEventListener('visibilitychange', on); window.removeEventListener('focus', on) }
  }, [])
  return (
    <section className="ak-morning">
      <div className="ak-morning-top">
        <img src="/adal-logo.png" alt="" width="56" height="56" className="ak-morning-logo" draggable={false} />
        <div className="min-w-0">
          <p className="ak-eyebrow truncate" translate="no">{company ? `Adal ${company}` : 'Adal Keep'}</p>
          <h1 className="ak-hero-title ak-morning-title"><span>{greeting(now)}</span>{name ? <span translate="no">, {name}</span> : null}</h1>
          <p className="ak-morning-date" translate="no"><span>{gregorian(now)}</span><span aria-hidden="true" className="ak-morning-dot" /><span lang="am">{ethiopian(now)}</span></p>
        </div>
      </div>
      <div className="ak-morning-go">
        <Link to="/tasks" className="ak-pill-btn">ተግባሮች</Link>
        {place && (
          <Link to={place.path} className="ak-morning-back">
            <Icon name="continue" size={18} />
            <span className="min-w-0 truncate"><span>ካቆሙበት ይቀጥሉ</span>{place.name ? <span translate="no"> · {place.name}</span> : null}</span>
          </Link>
        )}
      </div>
    </section>
  )
}

/** Anything wrong in it: the plain greeting and the button, never a blank dashboard. */
export default class MorningHeader extends Component {
  state = { bad: false }
  static getDerivedStateFromError() { return { bad: true } }
  componentDidCatch(e) { console.warn('[dashboard header]', e) }
  render() {
    if (!this.state.bad) return <Header {...this.props} />
    return <section className="ak-hero"><h1 className="ak-hero-title">{greeting()}</h1><Link to="/tasks" className="ak-pill-btn">ተግባሮች</Link></section>
  }
}
