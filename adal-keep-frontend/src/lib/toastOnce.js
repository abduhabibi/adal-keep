/**
 * The same error message is shown once at a time (asked on 2026-11-23: five
 * "Signed out: you can look, not change" boxes stacked on a profile page —
 * each part of the page asked the PC and got the same answer).
 *
 * toast.error(text) without an id gets the text as its id, so a second one
 * with the same text replaces the first instead of stacking. A call with its
 * own id (a loading toast turned into an error) is unchanged.
 */
import toast from 'react-hot-toast'

if (!toast.error.__once) {
  const original = toast.error
  const once = (msg, opts = {}) => original(msg, typeof msg === 'string' && !opts?.id ? { ...opts, id: `err:${msg}` } : opts)
  once.__once = true
  toast.error = once
}
