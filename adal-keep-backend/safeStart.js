/**
 * safeStart.js — a bad update never leaves an agency without Adal Keep.
 *
 * Before an update is installed, the version that works is kept in
 * <install>\.previous-version (its code and pages, never data). server.js
 * counts each start of a version; a start that lasts 2 minutes, or ends on
 * purpose (X, an update), counts as good. When a version installed in the last
 * 2 days fails to start 3 times in a row, the kept version is put back and the
 * launcher starts it; the bad version is not installed again by itself
 * (data/rolled-back.json), and Adal Keep Admin sees it with the PC's health.
 *
 * Only Node's own modules here: this file must work whatever else is broken.
 * A developer's git checkout has no .adal-version.json and is never touched.
 */
import fs from 'fs'
import path from 'path'

export const PREVIOUS = '.previous-version'
export const START_LIMIT = 3
const RECENT_MS = 48 * 3600 * 1000

export function paths(backendDir) {
  const root = path.dirname(backendDir)
  return {
    root,
    marker: path.join(root, '.adal-version.json'),
    prev: path.join(root, PREVIOUS),
    dist: path.join(root, 'adal-keep-frontend', 'dist'),
    state: path.join(backendDir, 'data', 'boot-state.json'),
    rolled: path.join(backendDir, 'data', 'rolled-back.json'),
  }
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)) } catch {} }

/** Counts this start of the installed version. */
export function noteStart(backendDir, { now = Date.now() } = {}) {
  const p = paths(backendDir)
  const marker = readJson(p.marker)
  if (!marker?.sha) return { guarded: false }
  let s = readJson(p.state)
  if (!s || s.sha !== marker.sha) s = { sha: marker.sha, starts: 0 }
  s.starts = (s.starts || 0) + 1
  s.lastStartAt = new Date(now).toISOString()
  writeJson(p.state, s)
  return { guarded: true, sha: marker.sha, starts: s.starts, marker }
}

/** This version started well (ran 2 minutes, or was closed on purpose). */
export function startedWell(backendDir) {
  const p = paths(backendDir)
  const s = readJson(p.state)
  if (!s || !s.starts) return
  writeJson(p.state, { ...s, starts: 0, goodAt: new Date().toISOString() })
}

/** The kept version to go back to, when this one keeps failing to start. */
export function shouldRollBack(backendDir, info, { limit = START_LIMIT, now = Date.now() } = {}) {
  if (!info?.guarded || info.starts < limit) return null
  const p = paths(backendDir)
  const prev = readJson(path.join(p.prev, 'version.json'))
  if (!prev?.sha || prev.sha === info.sha || !fs.existsSync(path.join(p.prev, 'backend'))) return null
  const installedAt = Date.parse(info.marker?.savedAt || '')
  if (!(now - installedAt < RECENT_MS)) return null // an old version that fails now: not the update's fault
  return prev
}

/** Puts the kept version back (code and pages; data is never touched). */
export function rollBack(backendDir, prev, why) {
  const p = paths(backendDir)
  const from = path.join(p.prev, 'backend')
  const failed = []
  for (const name of fs.readdirSync(from)) {
    try { fs.cpSync(path.join(from, name), path.join(backendDir, name), { recursive: true, force: true }) } catch { failed.push(name) }
  }
  const dist = path.join(p.prev, 'dist')
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    try { fs.rmSync(p.dist, { recursive: true, force: true }); fs.cpSync(dist, p.dist, { recursive: true }) } catch { failed.push('dist') }
  }
  const bad = readJson(p.marker) || {}
  writeJson(p.marker, { ...(prev.marker || { sha: prev.sha }), savedAt: new Date().toISOString(), rolledBackFrom: bad.sha || null })
  writeJson(p.rolled, { from: bad.sha || null, to: prev.sha, at: new Date().toISOString(), why, failed })
  writeJson(p.state, { sha: prev.sha, starts: 0 })
  return { from: bad.sha || null, to: prev.sha, failed }
}

/**
 * Keeps the version that works now, before an update replaces it: the same
 * top-level files and folders the update brings (`names`), and the pages.
 */
export function savePrevious(backendDir, names) {
  const p = paths(backendDir)
  const marker = readJson(p.marker)
  if (!marker?.sha) return false
  const tmp = `${p.prev}.new`
  fs.rmSync(tmp, { recursive: true, force: true })
  for (const name of names) {
    const src = path.join(backendDir, name)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, 'backend', name), { recursive: true })
  }
  if (fs.existsSync(path.join(p.dist, 'index.html'))) fs.cpSync(p.dist, path.join(tmp, 'dist'), { recursive: true })
  writeJson(path.join(tmp, 'version.json'), { sha: marker.sha, marker, savedAt: new Date().toISOString() })
  fs.rmSync(p.prev, { recursive: true, force: true })
  fs.renameSync(tmp, p.prev)
  return true
}

/** The version this PC went back from (not installed again by itself). */
export function rolledBack(backendDir) { return readJson(paths(backendDir).rolled) }
