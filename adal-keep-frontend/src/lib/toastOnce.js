/**
 * The same error message is shown once at a time (asked on 2026-11-23: five
 * "Signed out: you can look, not change" boxes stacked on a profile page —
 * each part of the page asked the PC and got the same answer).
 *
 * toast.error(text) without an id gets the text as its id, so a second one
 * with the same text replaces the first instead of stacking. A call with its
 * own id (a loading toast turned into an error) is unchanged.
 */
import { createElement as h } from 'react'
import toast from 'react-hot-toast'

/**
 * "Signed out: you can look, not change" is never a dead end (asked on 2026-11-24):
 * the PC answers who to sign in as (sign_in_as, kept by services/api.js) and the
 * message gets a button "Sign in as <name>" — one click (her password only if she has one),
 * and back to the same page.
 */
export const SIGNED_OUT = /Signed out: you can look, not change/
export function signInLink(who, here = window.location.pathname + window.location.search) {
  return `/employees?signin=${encodeURIComponent(who.id)}&back=${encodeURIComponent(here)}`
}
const withSignIn = (msg) => (t) => h('span', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
  h('span', null, msg),
  h('button', {
    type: 'button',
    onClick: () => { toast.dismiss(t.id); window.location.assign(signInLink(window.__adalSignInAs)) },
    style: { background: '#0d9488', color: '#fff', borderRadius: 8, padding: '4px 10px', fontWeight: 600, whiteSpace: 'nowrap' },
  }, `Sign in as ${window.__adalSignInAs.name}`))

if (!toast.error.__once) {
  const original = toast.error
  const once = (msg, opts = {}) => {
    if (typeof msg === 'string' && SIGNED_OUT.test(msg) && window.__adalSignInAs?.id) return original(withSignIn(msg), { duration: 12000, ...opts, id: opts?.id || 'signed-out' })
    return original(msg, typeof msg === 'string' && !opts?.id ? { ...opts, id: `err:${msg}` } : opts)
  }
  once.__once = true
  toast.error = once
}
