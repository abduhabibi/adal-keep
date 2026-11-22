/**
 * whatsNew.js — the short "What's new" of a release (asked on 2026-11-22).
 *
 * publish-update.mjs takes 3–5 plain-English bullets (--note "…", repeated)
 * into the signed manifest (`notes`). When a PC installs a release with notes,
 * they are kept here; the app shows them once, in a small card, until someone
 * on this PC closes it. A fresh install shows nothing (only an update does).
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
const FILE = () => process.env.ADAL_WHATS_NEW_FILE || path.join(DATA, 'whats-new.json')
export const MAX_NOTES = 5, MAX_NOTE = 160

/** The bullets as published: trimmed, none empty, at most 5 of at most 160 characters. Throws on bad ones. */
export function cleanNotes(list) {
  const notes = (list || []).map(s => String(s).replace(/\s+/g, ' ').replace(/^[-*•]\s*/, '').trim()).filter(Boolean)
  if (notes.length > MAX_NOTES) throw new Error(`What's new: at most ${MAX_NOTES} bullets (${notes.length} given)`)
  const long = notes.find(n => n.length > MAX_NOTE)
  if (long) throw new Error(`What's new: keep each bullet under ${MAX_NOTE} characters ("${long.slice(0, 40)}…")`)
  return notes
}

/** A release with notes was installed here: shown once from the next start. */
export function rememberInstalled(manifest) {
  const notes = Array.isArray(manifest?.notes) ? manifest.notes.map(String).filter(Boolean).slice(0, MAX_NOTES) : []
  try {
    if (!notes.length) { fs.rmSync(FILE(), { force: true }); return false }
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    fs.writeFileSync(FILE(), JSON.stringify({ sha: manifest.sha, short: manifest.short || String(manifest.sha).slice(0, 7), notes, rollback: !!manifest.rollback_of, at: new Date().toISOString(), seen: false }))
    return true
  } catch { return false }
}

/** The card to show now ({ sha, short, notes, rollback } or null): only for the version this PC runs, until closed. */
export function pending(installedSha) {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    if (j.seen || !j.notes?.length || !installedSha || j.sha !== installedSha) return null
    return { sha: j.sha, short: j.short, notes: j.notes, rollback: !!j.rollback, at: j.at }
  } catch { return null }
}

/** Closed: not shown again on this PC. */
export function dismiss(sha) {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'))
    if (sha && j.sha !== sha) return false
    fs.writeFileSync(FILE(), JSON.stringify({ ...j, seen: true, seenAt: new Date().toISOString() }))
    return true
  } catch { return false }
}
