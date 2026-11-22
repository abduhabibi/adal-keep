/**
 * usbKeeper.js — the Adal Keep USB, looked after from the PC it is plugged into (2026-11-22).
 *
 * The USB (exFAT, volume label "ADAL KEEP") is found by its label. One of three states:
 *   current          nothing to do
 *   needs-prepare    the package lock changed since the last PREPARE (deps/source.sha is not the
 *                    release's lock_hash): only PREPARE on a PC with internet fixes it, so we say so
 *   old-installers   the programs / phone app on the USB are older than this PC's release
 * "old-installers" is fixed by copying from THIS PC's own update cache (the signed release kept in
 * services/lanRelease.js: the office first, Supabase second) and the phone app it holds.
 *
 * Rules (Windows once demanded a reformat after an unsafe unplug):
 *  - never formats, never touches 47040.pub or deps/adal-check.ps1 (nor anything outside the list below)
 *  - every file is written as <name>.adal-tmp, checked by SHA-256, then renamed over the old one
 *  - the answer always carries the reminder to Eject before unplugging
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import * as L from './lanRelease.js'

export const LABEL = 'ADAL KEEP'
export const EJECT_REMINDER = 'Eject the USB in Windows ("Safely remove") before you unplug it.'
// Never written, whatever happens.
const PROTECTED = new Set(['47040.pub', 'deps/adal-check.ps1'])
const SYNC = 'deps/usb-sync.json'
const PHONE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'phone-app')
const APK_DEST = '5 - Phone app/Adal Keep.apk'
const PROGRAMS_DIR = 'deps/programs'

const sha256 = (f) => new Promise((res, rej) => {
  const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej)
})
const readText = (f) => { try { return fs.readFileSync(f, 'utf8').trim() } catch { return '' } }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const norm = (rel) => path.posix.normalize(String(rel).replace(/\\/g, '/'))
export const isProtected = (rel) => PROTECTED.has(norm(rel).toLowerCase()) || PROTECTED.has(norm(rel))

/** Plugged-in drives called "ADAL KEEP": [{ root, label }]. `lister` can be replaced (tests). */
export async function findDrives(lister = systemDrives) {
  return (await lister()).filter(d => String(d.label || '').trim().toUpperCase() === LABEL && d.root)
}

async function systemDrives() {
  if (process.platform === 'win32') {
    const ps = 'Get-Volume | Where-Object { $_.DriveLetter } | ForEach-Object { "$($_.DriveLetter)|$($_.FileSystemLabel)" }'
    const out = await new Promise(res => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (e, o) => res(e ? '' : String(o))))
    return out.split(/\r?\n/).map(l => l.trim().split('|')).filter(a => a.length >= 2 && /^[A-Za-z]$/.test(a[0]))
      .map(([letter, ...rest]) => ({ root: `${letter.toUpperCase()}:\\`, label: rest.join('|') }))
  }
  const found = []
  for (const base of [path.join('/media', os.userInfo().username), '/media', path.join('/run/media', os.userInfo().username)]) {
    try { for (const n of fs.readdirSync(base)) found.push({ root: path.join(base, n), label: n }) } catch {}
  }
  return found
}

/** What the USB needs, against the release this PC keeps. Reads only. */
export function inspect(root, release = L.current()) {
  const m = release?.manifest || null
  const lock = readText(path.join(root, 'deps/source.sha'))
  const sync = readJson(path.join(root, SYNC))
  const phone = readJson(path.join(PHONE_DIR, 'version.json'))
  const missing = []
  if (!m) return { state: 'current', root, reasons: [], note: 'This PC keeps no release yet: nothing to compare with.', items: [] }
  const items = []
  for (const p of m.programs || []) {
    const have = sync?.programs?.[p.name] === p.sha256 && fs.existsSync(path.join(root, PROGRAMS_DIR, p.name))
    items.push({ kind: 'program', name: p.name, sha256: p.sha256, dest: `${PROGRAMS_DIR}/${p.name}`, ok: have })
  }
  const apkOk = !phone || (Number(sync?.apk?.versionCode) >= Number(phone.versionCode) && fs.existsSync(path.join(root, APK_DEST)))
  if (phone) items.push({ kind: 'apk', name: 'Adal Keep.apk', versionCode: Number(phone.versionCode), dest: APK_DEST, ok: apkOk })
  for (const i of items) if (!i.ok) missing.push(i.name)
  let state = 'current'
  const reasons = []
  if (m.lock_hash && lock !== m.lock_hash) {
    state = 'needs-prepare'
    reasons.push('The server packages changed since the last PREPARE. Run "1 - PREPARE (once, needs internet).bat" from the USB on a Windows PC with internet.')
  } else if (missing.length) {
    state = 'old-installers'
    reasons.push(`Older than this PC's release: ${missing.join(', ')}`)
  }
  return { state, root, reasons, items, release: m.short || String(m.sha).slice(0, 7), canFix: missing.length > 0 }
}

/** Writes one file safely: temp file next to it, SHA-256 checked, then renamed over the old one. */
export async function safeWrite(root, rel, from, expectedSha) {
  rel = norm(rel)
  if (!rel || rel.startsWith('..') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || isProtected(rel)) throw new Error(`not allowed to write ${rel}`)
  const dest = path.join(root, rel)
  const tmp = `${dest}.adal-tmp`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.copyFileSync(from, tmp)
    const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (expectedSha && (await sha256(tmp)) !== expectedSha) throw new Error(`${rel}: the copy does not match (not replaced)`)
    fs.renameSync(tmp, dest)
  } catch (e) { try { fs.rmSync(tmp, { force: true }) } catch {}; throw e }
  return dest
}

/**
 * Brings the USB up to the release this PC keeps. Needs-prepare is not fixed here (it needs internet and
 * Windows PREPARE). The cache: the office, then Supabase (L.fetchPiece). Returns what was done.
 */
export async function fix(root, { release = L.current(), fetchPiece = L.fetchPiece, label } = {}) {
  if (label !== undefined && String(label).trim().toUpperCase() !== LABEL) throw new Error('This drive is not called ADAL KEEP: nothing written.')
  const before = inspect(root, release)
  const m = release?.manifest
  const done = [], failed = []
  if (m) {
    for (const it of before.items.filter(i => !i.ok)) {
      try {
        if (it.kind === 'program') {
          const piece = (m.programs || []).find(p => p.name === it.name)
          const cached = await fetchPiece(m, piece, null)
          await safeWrite(root, it.dest, cached, piece.sha256)
        } else {
          const apk = path.join(PHONE_DIR, 'AdalKeep.apk')
          if (!fs.existsSync(apk)) throw new Error('this PC has no phone app')
          await safeWrite(root, it.dest, apk, await sha256(apk))
        }
        done.push(it.name)
      } catch (e) { failed.push({ name: it.name, error: e.message }) }
    }
    // The note of what the USB holds is written last, only for what really got there.
    const prev = readJson(path.join(root, SYNC)) || {}
    const note = { ...prev, release: m.sha, at: new Date().toISOString(), programs: { ...(prev.programs || {}) } }
    for (const it of before.items) {
      if (it.ok || done.includes(it.name)) {
        if (it.kind === 'program') note.programs[it.name] = it.sha256
        else note.apk = { versionCode: it.versionCode }
      }
    }
    const tmpNote = path.join(os.tmpdir(), `adal-usb-sync-${process.pid}.json`)
    fs.writeFileSync(tmpNote, JSON.stringify(note, null, 1))
    try { await safeWrite(root, SYNC, tmpNote) } finally { fs.rmSync(tmpNote, { force: true }) }
  }
  const after = inspect(root, release)
  return { done, failed, state: after.state, reasons: after.reasons, eject: EJECT_REMINDER }
}

/** Everything the page shows: every ADAL KEEP drive with its state. */
export async function status(lister) {
  const drives = []
  for (const d of await findDrives(lister)) drives.push({ ...d, ...inspect(d.root) })
  return { drives, eject: EJECT_REMINDER }
}
