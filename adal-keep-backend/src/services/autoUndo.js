/**
 * autoUndo.js — a PC goes back by itself when an update breaks it, and says
 * so to Adal (asked on 2026-11-23).
 *
 * After an update the PC is on probation (PROBATION_MIN, default 30 min,
 * data/update-probation.json). It goes back to the version before — the way
 * back signed into the release (manifest.rollback, services/rollback.js), else
 * the copy safeStart.js kept — when, during probation:
 *   • the self-check fails (90 s after the start): the files are not the
 *     signed ones (manifest.app_files), a core package does not load, the
 *     database does not answer, or the server does not answer;
 *   • it crashed CRASH_LIMIT times (a start that did not end on purpose);
 *   • it hit ERROR_LIMIT crashes/unhandled errors while running.
 * The bad release is written down (data/auto-undo.json) and goes online in the
 * health report (/_diag → autoUndo), so Adal Keep Admin shows "rolled back on
 * <PC>: <reason>". The owner then assigns what happens next — retry, keep on
 * the old version, or push to everyone — in a file signed on Adal's PC
 * (release/assign.json, read at every update check).
 *
 * ADAL_AUTO_UNDO=0 turns the going back off (the report stays).
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { verifyManifest } from './updateChannel.js'

const BACK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DATA = () => process.env.ADAL_UNDO_DIR || path.join(BACK, 'data')
const PROBATION = () => path.join(DATA(), 'update-probation.json')
const REPORTS = () => path.join(DATA(), 'auto-undo.json')
export const PROBATION_MIN = Number(process.env.ADAL_PROBATION_MIN || 30)
export const CRASH_LIMIT = 3
export const ERROR_LIMIT = Number(process.env.ADAL_UNDO_ERRORS || 30)
export const on = () => process.env.ADAL_AUTO_UNDO !== '0'

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)) } catch {} }
const short = (s) => String(s || '').slice(0, 7)

/** Called right after an update is installed (before the restart). */
export function beginProbation({ to, from, now = Date.now() }) {
  if (!to?.sha) return null
  const p = { sha: to.sha, short: to.short || short(to.sha), from: from?.sha || null, fromShort: from?.short || short(from?.sha), at: new Date(now).toISOString(), until: new Date(now + PROBATION_MIN * 60000).toISOString(), boots: 0, cleanExits: 0, errors: 0 }
  writeJson(PROBATION(), p)
  return p
}

export const probation = () => readJson(PROBATION())
export const endProbation = () => { try { fs.rmSync(PROBATION(), { force: true }) } catch {} }
const live = (p, sha, now = Date.now()) => !!p && p.sha === sha && Date.parse(p.until) > now

/** Every report: [{ pc, sha, short, from, to, reason, at, status }] (newest last). */
export const reports = () => { const r = readJson(REPORTS(), []); return Array.isArray(r) ? r : [] }
/** A bad release noted (and kept off this PC until Adal assigns otherwise). */
export function report({ sha, shortSha, from, to, reason, done = true, now = Date.now() }) {
  const list = reports()
  const row = { pc: os.hostname(), sha, short: shortSha || short(sha), from: from || null, to: to || null, reason: String(reason).slice(0, 300), at: new Date(now).toISOString(), status: done ? 'rolled-back' : 'could-not-roll-back' }
  list.push(row)
  writeJson(REPORTS(), list.slice(-20))
  console.error(`↩️ rolled back on ${row.pc}: ${row.reason}`)
  return row
}
/** The release this PC went back from and still keeps away from (or null). */
export const blocked = (sha) => [...reports()].reverse().find(r => r.sha === sha && (r.status === 'rolled-back' || r.status === 'kept')) || null
/** For the health report: the last few, short. */
export const forReport = () => reports().slice(-5).map(r => ({ pc: r.pc, sha: r.short, from: short(r.from), to: short(r.to), reason: r.reason, at: r.at, status: r.status }))

/**
 * The self-check of a just-updated version. checks: { files, packages, db, http }
 * (each async → '' when fine, else what is wrong). Returns the reasons (empty: fine).
 */
export async function selfCheck(checks) {
  const out = []
  for (const [name, fn] of Object.entries(checks)) {
    try { const why = await fn(); if (why) out.push(`${name}: ${why}`) } catch (e) { out.push(`${name}: ${e.message}`) }
  }
  return out
}

/** The installed files that are not the signed ones (app_files: { "adal-keep-backend/x.js": sha256 }). */
export function filesDiffer(appFiles, projectRoot, backendDir) {
  const bad = []
  for (const [rel, want] of Object.entries(appFiles || {})) {
    const file = rel.startsWith('adal-keep-backend/') ? path.join(backendDir, rel.slice(18)) : path.join(projectRoot, rel)
    // A program the server runs that was in use is left as it was (installFromRelease): not a broken update.
    if (/\.exe$/i.test(rel)) continue
    try { if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== want) bad.push(rel) } catch { bad.push(rel) }
  }
  return bad
}

/** Admin's signed decisions (release/assign.json): only those signed by Adal. */
export function readAssign(env) {
  const m = env?.manifest
  if (m?.kind !== 'assign' || !Array.isArray(m.rules) || !verifyManifest(m, env.signature)) return []
  return m.rules.filter(r => r && /^[0-9a-f]{7,40}$/.test(String(r.sha || '')) && ['retry', 'keep', 'everyone'].includes(r.action))
}

/**
 * What Admin decided for this PC's bad release: 'retry' | 'keep' | 'everyone' | null.
 * A rule names the sha, and the PC (hostname) or the agency, or neither (every PC); only one made after the report.
 */
export function decisionFor(rules, row, { agency = '', pc = os.hostname() } = {}) {
  if (!row) return null
  let best = null
  for (const r of rules) {
    if (!row.sha.startsWith(String(r.sha)) && !String(r.sha).startsWith(row.sha)) continue
    if (r.pc && String(r.pc).toLowerCase() !== String(pc).toLowerCase()) continue
    if (r.agency && r.agency !== agency) continue
    if (!(Date.parse(r.at) > Date.parse(row.at))) continue
    if (!best || Date.parse(r.at) > Date.parse(best.at)) best = r
  }
  return best?.action || null
}

/** A decision carried out: the report gets its new status (retry/everyone: the release may come again). */
export function settle(sha, action) {
  const list = reports()
  let changed = false
  for (const r of list) if (r.sha === sha && (r.status === 'rolled-back' || r.status === 'kept') && r.status !== (action === 'keep' ? 'kept' : 'retry')) { r.status = action === 'keep' ? 'kept' : 'retry'; r.settledAt = new Date().toISOString(); changed = true }
  if (changed) writeJson(REPORTS(), list)
  return changed
}

let undoer = null
let errorsSeen = 0
let undoing = false
/** systemUpdate.js gives the way back: (reason) → { ok, to, error }. */
export const setUndoer = (fn) => { undoer = fn }

async function undo(sha, reason) {
  if (undoing) return
  undoing = true
  const p = probation()
  try {
    if (!on()) { report({ sha, from: p?.from, reason: `${reason} (going back is off on this PC)`, done: false }); endProbation(); return }
    const r = undoer ? await undoer(reason) : { ok: false, error: 'no way back here' }
    report({ sha, shortSha: p?.short, from: sha, to: r.to || p?.from, reason, done: !!r.ok })
    if (!r.ok) console.error(`[auto-undo] could not go back: ${r.error}`)
    endProbation()
  } finally { undoing = false }
}

/**
 * At every start: counts it in the probation; a crash loop goes back; the
 * self-check runs after `checkAfter`; errors are counted until the end of the
 * probation. `installedSha`: what this PC runs now. Returns the probation (or null).
 */
export function watch({ installedSha, checks = {}, checkAfter = 90_000, now = Date.now() } = {}) {
  const p = probation()
  if (!p) return null
  if (!live(p, installedSha, now)) { if (Date.parse(p.until) <= now || p.sha !== installedSha) endProbation(); return null }
  p.boots = (p.boots || 0) + 1
  writeJson(PROBATION(), p)
  process.on('exit', (code) => { if (code === 0) { const q = probation(); if (q?.sha === p.sha) writeJson(PROBATION(), { ...q, cleanExits: (q.cleanExits || 0) + 1 }) } })
  const crashes = p.boots - 1 - (p.cleanExits || 0)
  if (crashes >= CRASH_LIMIT) { undo(p.sha, `${p.short} crashed ${crashes} times after the update`); return p }
  setTimeout(async () => {
    if (!live(probation(), p.sha)) return
    const bad = await selfCheck(checks)
    if (bad.length) undo(p.sha, `${p.short} failed its self-check: ${bad.join('; ')}`)
    else console.log(`✅ ${p.short} passed its self-check after the update`)
  }, checkAfter).unref?.()
  // The end of the probation: the version is good.
  const left = Date.parse(p.until) - now
  setTimeout(() => { const q = probation(); if (q?.sha === p.sha && !undoing) endProbation() }, Math.max(0, left)).unref?.()
  return p
}

/** A crash or unhandled error while on probation (diag.js calls it). */
export function noteFailure(kind) {
  if (kind !== 'crash' && kind !== 'unhandled') return
  const p = probation()
  if (!p || !(Date.parse(p.until) > Date.now()) || undoing) return
  errorsSeen++
  if (errorsSeen >= ERROR_LIMIT) undo(p.sha, `${p.short} had ${errorsSeen} errors in its first ${PROBATION_MIN} minutes`)
}
export const _resetForTests = () => { errorsSeen = 0; undoing = false; undoer = null }
