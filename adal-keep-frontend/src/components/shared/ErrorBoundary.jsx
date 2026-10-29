import { Component } from 'react'

/**
 * One part that breaks never blanks the whole screen: it shows what went
 * wrong and a "Try again", and the rest of the page keeps working.
 * `resetKey` (e.g. the page's address) clears it when it changes.
 */
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) {
    console.error('[Adal Keep] a part of the page broke:', error, info?.componentStack)
    try { (window.__adalErrors ||= []).push({ at: new Date().toISOString(), method: 'render', path: this.props.name || location.pathname, error: String(error?.message || error) }) } catch {}
  }
  componentDidUpdate(prev) { if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className={`rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 text-sm ${this.props.small ? '' : 'm-4'}`}>
        <p className="font-semibold text-amber-900 dark:text-amber-200">⚠️ {this.props.name ? `“${this.props.name}” could not be shown` : 'This page could not be shown'}</p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300 break-words">{String(this.state.error?.message || this.state.error)}</p>
        <button type="button" onClick={() => this.setState({ error: null })}
          className="mt-2 rounded-lg bg-amber-600 text-white px-3 py-1.5 text-xs font-semibold">↻ Try again</button>
      </div>
    )
  }
}
