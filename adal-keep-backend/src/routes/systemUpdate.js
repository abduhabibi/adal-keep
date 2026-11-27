import { Router } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { latestRelease, setUpdateDb, lastEnvelope, verifyManifest } from '../services/updateChannel.js'
import { withTimeout, RUN_LIMIT_MS } from '../services/runLimit.js'
import { rollbackOf, databaseRefusal } from '../services/rollback.js'
import * as WhatsNew from '../services/whatsNew.js'
import { itsTurn, turnAt, programsFor, pcArch } from '../services/rollout.js'
import * as Undo from '../services/autoUndo.js'

const execAsync = promisify(exec)
const router = Router()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = path.join(__dirname, '..', '..')

// ---------------------------------------------------------------------------
// Configuration
//   GITHUB_REPO        owner/repo        (default: abduhabibi/adal-keep)
//   GITHUB_BRANCH      branch to track   (default: main)
//   GITHUB_TOKEN       optional token    (private repos / higher rate limits)
//   ADAL_PROJECT_ROOT  optional override of the install root
// ---------------------------------------------------------------------------
const DEFAULT_REPO = 'abduhabibi/adal-keep'
const DEFAULT_BRANCH = 'main'
const MARKER = '.adal-version.json'
// The Windows programs an update may replace (only these names, only when the PC has them).
export const PROGRAMS = new Set(['AdalKeep.exe', 'adal-companion.exe', 'adal-agent.exe'])
// Never overwrite user data / secrets / deps when installing an update.
const PROTECTED = new Set([
  '.git', '.env', '.env.bak', 'data', 'uploads', 'logs', 'node_modules', MARKER,
  // Licensing / activation state
  '.adal_sub.json', '.subscription_lock', '.adal_chat.json',
  // Live database + WAL sidecars
  'data.sqlite', 'data.sqlite-shm', 'data.sqlite-wal',
  // Portable Node runtime shipped by the installer
  'runtime',
  // Legacy built-frontend folder
  'frontend',
])

function normalizeRepo(value) {
  return String(value || '')
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '')
}

function findProjectRoot() {
  let dir = BACKEND_ROOT
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(BACKEND_ROOT, '..')
}

/**
 * A USB install keeps the server in <root>\backend (not adal-keep-backend):
 *   <root>\backend   server.js, src, node_modules   (run-server.bat runs it)
 *   <root>\runtime   portable Node
 * Updates must land in that folder, or the running server never changes.
 */
function backendDirOf(projectRoot) {
  const packaged = path.join(projectRoot, 'backend')
  if (fs.existsSync(path.join(packaged, 'server.js'))) return packaged
  return path.join(projectRoot, 'adal-keep-backend')
}

function config() {
  const rawBranch = (process.env.GITHUB_BRANCH || DEFAULT_BRANCH).trim()
  return {
    repo: normalizeRepo(process.env.GITHUB_REPO) || DEFAULT_REPO,
    // guard against shell injection via a tampered env var
    branch: /^[A-Za-z0-9._/-]+$/.test(rawBranch) ? rawBranch : DEFAULT_BRANCH,
    token: (process.env.GITHUB_TOKEN || '').trim(),
    projectRoot: (process.env.ADAL_PROJECT_ROOT || '').trim() || findProjectRoot(),
  }
}

/**
 * git arguments that send the GitHub token for private repositories. Passed as
 * a one-off HTTP header, so the token is never written into .git/config.
 */
function gitAuthArgs(token) {
  if (!token) return ''
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return `-c http.extraHeader="Authorization: Basic ${basic}" `
}

/** The environment with this Node's folder first on the PATH (one PATH entry, whatever its spelling). */
export function withOwnNode(env, nodeDir = path.dirname(process.execPath)) {
  const out = { ...env }
  const key = Object.keys(out).find(k => k.toUpperCase() === 'PATH') || 'PATH'
  const rest = out[key] || ''
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k]
  out[key] = rest.split(path.delimiter).includes(nodeDir) ? rest : `${nodeDir}${path.delimiter}${rest}`
  return out
}

async function run(cmd, cwd, timeout = 5 * 60 * 1000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      windowsHide: true,
      cwd,
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout,
      // Packages never download their own browsers: the robots use the installed Brave.
      // Adal Keep's own Node first on the PATH: a package's setup step runs
      // "node install.mjs", and a PC without a Node of its own failed there
      // ("'node' is not recognized") and was left with packages half removed (2026-11-17).
      env: withOwnNode({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', PUPPETEER_SKIP_DOWNLOAD: '1' }),
    })
    return { ok: true, out: `${stdout || ''}${stderr || ''}`.trim() }
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`.trim() }
  }
}

/** Query the GitHub REST API for this repository. */
async function github(pathname) {
  const { repo, token } = config()
  const headers = { 'User-Agent': 'adal-keep-updater', Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`https://api.github.com/repos/${repo}${pathname}`, { headers })
  if (res.status === 404 && !token) {
    throw new Error('GitHub did not find this repository. If it is private, add GITHUB_TOKEN to the app .env file.')
  }
  if (res.status === 401 || (res.status === 403 && token)) {
    throw new Error('GitHub rejected the GITHUB_TOKEN in the app .env file (expired or wrong). Create a new token and replace it.')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 180)}` : ''}`)
  }
  return res.json()
}

/**
 * The release this PC runs, with its order (publish time, commit date): the
 * kept signed release when it is the same sha, else what the marker says.
 */
export function installedRelease(installed, kept) {
  if (!installed?.sha) return null
  if (kept?.sha && kept.sha === installed.sha) return kept
  const marker = readMarker(config().projectRoot) || {}
  return { sha: installed.sha, date: installed.date || (marker.sha === installed.sha ? marker.date : '') || '', published_at: (marker.sha === installed.sha ? marker.published_at : '') || '', seq: marker.sha === installed.sha ? marker.seq : undefined }
}

function readMarker(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, MARKER), 'utf8')) } catch { return null }
}

function writeMarker(root, data) {
  try {
    fs.writeFileSync(path.join(root, MARKER), JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2))
  } catch { /* best-effort */ }
}

/** Detect the currently installed revision (git first, then marker file). */
export async function getInstalled() {
  const { projectRoot } = config()
  const isRepo = fs.existsSync(path.join(projectRoot, '.git'))
  if (isRepo) {
    const rev = await run('git rev-parse HEAD', projectRoot)
    const sha = rev.ok ? rev.out.trim() : ''
    if (sha) {
      const branch = await run('git rev-parse --abbrev-ref HEAD', projectRoot)
      const subject = await run('git log -1 --pretty=%s', projectRoot)
      return {
        sha, short: sha.slice(0, 7),
        branch: branch.ok ? branch.out.trim() : '',
        subject: subject.ok ? subject.out.trim() : '',
        source: 'git', isRepo: true,
      }
    }
  }
  const marker = readMarker(projectRoot)
  if (marker?.sha) {
    return {
      sha: marker.sha, short: String(marker.sha).slice(0, 7),
      branch: marker.branch || '', subject: marker.message || '',
      source: 'marker', isRepo,
    }
  }
  return { sha: '', short: '', branch: '', subject: '', source: 'unknown', isRepo }
}

function describeCommit(commit) {
  return {
    sha: commit.sha,
    short: (commit.sha || '').slice(0, 7),
    message: (commit.commit?.message || '').split('\n')[0].trim(),
    date: commit.commit?.author?.date || commit.commit?.committer?.date || null,
    author: commit.commit?.author?.name || commit.author?.login || '',
    url: commit.html_url,
  }
}

// ---------------------------------------------------------------------------
// GET /api/system/update/check  — compare installed revision with GitHub
// ---------------------------------------------------------------------------
/**
 * Compare this PC with the published version. One update always goes
 * straight to the newest version, however many changes were published since:
 * `changes` lists all of them (newest first) so the person sees what is new.
 */
export async function checkForUpdate() {
  const installedNow = await getInstalled()
  // Installed PCs: only Adal's signed release in Supabase (the GitHub
  // repository is private). GitHub is only for a developer's git checkout.
  if (!installedNow.isRepo) {
    try { return await checkSupabase(installedNow) } catch (e) { throw new Error(`Supabase updates: ${e.message}`) }
  }
  const supabaseError = null
  try {
    const r = await checkGitHub()
    if (supabaseError) r.note = [r.note, `Supabase updates: ${supabaseError}`].filter(Boolean).join(' · ')
    return r
  } catch (e) {
    throw new Error(supabaseError ? `Supabase: ${supabaseError} · GitHub: ${e.message}` : e.message)
  }
}

async function checkSupabase(installed) {
  // Supabase only (2026-11-23, the owner: no update pieces between the office's PCs).
  // Signed by Adal; never one older than this PC's.
  const L = await import('../services/lanRelease.js')
  const mine = installedRelease(installed, L.current()?.manifest)
  mineNow = mine
  const known = L.orderKnown(mine)
  let m = null, cloudError = null, notForMe = false
  try {
    m = await latestRelease('release')
    // Up to date already (installed before this PC kept its release): kept now to hand on.
    if (installed.sha === m.sha && L.current()?.manifest?.sha !== m.sha && lastEnvelope?.manifest?.sha === m.sha) L.recordInstalled(lastEnvelope, config().projectRoot).catch(() => {})
  } catch (e) {
    m = null
    // Adal is trying this release on other PCs first: this PC's turn comes later.
    if (e?.audience) notForMe = true
    else cloudError = e
  }
  if (!m && notForMe) {
    return {
      waitUntil: null, hasUpdate: false, upToDate: true, installed,
      latest: { sha: installed.sha, short: installed.short, message: installed.message, date: installed.date },
      changes: [], count: 0, source: 'supabase', manifest: null,
      note: 'A newer release is being tried on other PCs first; this PC gets it later.',
    }
  }
  if (!m) throw cloudError || new Error('no release published yet')
  // Unknown order (an old marker with only a sha): Supabase's release is trusted, as before.
  const upToDate = !!installed.sha && (installed.sha === m.sha || (known && !L.isNewer(m, mine)))
  // Staged (services/rollout.js): the test agency first, then ~10% of agencies, then
  // everyone — a bad version reaches one agency, not all of them. Admin can stop it.
  let waitUntil = null, stopped = false
  if (!upToDate && (m.rollout || (m.everyone_at && Date.parse(m.everyone_at) > Date.now()))) {
    let me = null
    try { me = await withTimeout((await import('../services/chatCloud.js')).cloudAgencyId(dbOf()), 5000, null) } catch {}
    if (!itsTurn(m, me)) { const t = turnAt(m, me); stopped = t === 'stopped'; waitUntil = stopped ? '9999-12-31T00:00:00.000Z' : (t || m.everyone_at) }
  }
  // A release this PC went back from by itself waits for Adal's decision (Admin → Updates → assign).
  const undone = !upToDate ? Undo.blocked(m.sha) : null
  return {
    waitUntil, ...(stopped ? { stopped: true } : {}), ...(undone ? { blocked: undone.reason } : {}),
    hasUpdate: !upToDate, upToDate, installed,
    latest: { sha: m.sha, short: m.short, message: m.message, date: m.date },
    changes: upToDate ? [] : (m.changes || []).slice(0, 40),
    count: upToDate ? 0 : (m.changes || []).length || 1,
    source: 'supabase', manifest: m,
    note: cloudError ? `Supabase not reachable: ${cloudError.message}` : null,
  }
}

async function checkGitHub() {
  const cfg = config()
  const commit = await github(`/commits/${encodeURIComponent(cfg.branch)}`)
  const latest = describeCommit(commit)
  const installed = await getInstalled()
  const known = Boolean(installed.sha)
  let upToDate = known && installed.sha === latest.sha
  let note = known ? null : 'Installed revision could not be detected; showing the latest published revision.'
  let changes = []
  let count = 0

  // Different is not the same as newer: ask GitHub which side is ahead, so
  // a PC that is newer than the published version is never "updated" back.
  if (known && !upToDate) {
    try {
      const cmp = await github(`/compare/${installed.sha}...${latest.sha}`)
      if (cmp.status === 'behind' || cmp.status === 'identical') {
        upToDate = true
        note = cmp.status === 'behind' ? `This PC is newer than the published version (${cmp.behind_by} change(s) ahead).` : null
      } else {
        if (cmp.status === 'diverged') {
          note = `This PC has ${cmp.behind_by} change(s) that are not published; updating replaces them with the published version.`
        }
        count = cmp.ahead_by || (cmp.commits || []).length
        changes = (cmp.commits || []).map(describeCommit).reverse().slice(0, 40)
          .map(c => ({ short: c.short, message: c.message, date: c.date }))
      }
    } catch {
      // The installed commit is not on GitHub (made on this PC, never pushed).
      upToDate = true
      note = 'This PC runs a version that is not published on GitHub — nothing to update to.'
    }
  } else if (!known) {
    changes = [{ short: latest.short, message: latest.message, date: latest.date }]
    count = 1
  }

  return {
    hasUpdate: !upToDate,
    upToDate,
    installed,
    latest,
    changes,
    count,
    repo: cfg.repo,
    branch: cfg.branch,
    repoUrl: `https://github.com/${cfg.repo}`,
    compareUrl: known ? `https://github.com/${cfg.repo}/compare/${installed.sha}...${latest.sha}` : null,
    note,
  }
}

// The last answer of the background check (every UPDATE_CHECK_MINUTES).
export const updateNotice = { checkedAt: null, result: null, error: null, applying: false, applyingSince: null, auto: false, autoError: null }

async function handleCheck(req, res) {
  try {
    const result = await checkForUpdate()
    Object.assign(updateNotice, { checkedAt: new Date().toISOString(), result, error: null })
    res.json(result)
  } catch (err) {
    console.error('[system/update/check]', err.message)
    res.status(502).json({ error: 'Could not reach the updates (Supabase or GitHub).', details: err.message })
  }
}

let watcher = null
let lastCheck = 0
// What this PC runs, with its order (the last check's).
let mineNow = null

/**
 * Updates by itself: an installed PC (USB install, not a developer's git
 * checkout) installs a new version as soon as no automation run is working
 * or waiting in line — a restart in the middle would cut a run off. Settings
 * → "Update by itself" (auto_update = off) or ADAL_AUTO_UPDATE=0 turns it off.
 * A failed install is tried again after 2 hours, never in a loop.
 */
let updateDb = null
const dbOf = () => updateDb
const autoState = { failedSha: '', failedAt: 0, failedSource: '', waitingSince: 0 }
async function autoUpdateOn(db) {
  if (String(process.env.ADAL_AUTO_UPDATE || '').trim() === '0') return false
  try {
    // A busy database must not hold the update back: no answer in 5 s = the default (on).
    const row = db ? await withTimeout(db('settings').where('key', 'auto_update').first(), 5000, null) : null
    if (row && String(row.value).toLowerCase() === 'off') return false
  } catch {}
  return true
}

// The runs work in Adal Robots, its own program (robots/adal-robots.mjs), not in this server: here runsWorking() is 0,
// and an update installed and restarted in the middle of a run (2026-11-27, Main: the server ended cleanly 100 s after
// its start). Its /health says how many work. No answer: 0, as before. Off: ADAL_UPDATE_ASKS_ROBOTS=0.
export async function robotsRunning(env = process.env) {
  if (env.ADAL_UPDATE_ASKS_ROBOTS === '0') return 0
  try {
    const { robotsInApp } = await import('../services/robotsInApp.js')
    if (robotsInApp()) return 0
    const { ROBOTS_URL } = await import('../services/robotsLink.js')
    const r = await fetch(`${ROBOTS_URL()}/health`, { signal: AbortSignal.timeout(3000) })
    return Math.max(0, Number((await r.json())?.running) || 0)
  } catch { return 0 }
}

async function busyNow(db) {
  let running = 0, waiting = 0
  try { const { runsWorking } = await import('../services/busy.js'); running = runsWorking() } catch {}
  running += await robotsRunning()
  try { if (db) waiting = Number((await withTimeout(db('automation_queue').where('status', 'pending').count({ c: '*' }).first(), 5000, null))?.c || 0) } catch {}
  // A move from another system (Transitions) is lost by a restart: the update waits for it too.
  try { if ((await import('../services/transition.js')).transitionRunning()) running++ } catch {}
  return { running, waiting, busy: running > 0 || waiting > 0 }
}

/**
 * Never longer than 10 minutes for the runs (owner's rule, 2026-11-22): every run is stopped at 10 minutes
 * anyway (services/runLimit.js), so what still works after that is stuck; the update goes on.
 * since: when the wait began (0 = not waiting). Returns { wait, since, waited }.
 */
export function holdForRuns(busy, since, now = Date.now(), limit = RUN_LIMIT_MS) {
  if (!busy) return { wait: false, since: 0, waited: 0 }
  const from = since || now
  const waited = now - from
  return { wait: waited < limit, since: from, waited }
}

/**
 * What the last automatic install did, kept in data/update-state.json: an install that the server's
 * stop cut off (no "installed", no "failed" in the log) is said at the next start, and a version
 * this PC went back from (safeStart.js) is said with its reason.
 */
const STATE_FILE = () => path.join(backendDirOf(config().projectRoot), 'data', 'update-state.json')
function installStep(s) {
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...s, pid: process.pid, at: new Date().toISOString() }, null, 1)) } catch {}
}
function sayLastInstall() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'))
    if (s.step === 'installing' && s.pid !== process.pid) {
      console.error(`[update] the automatic install of ${s.short || s.sha} that began ${s.at} did not finish: the server stopped during it (it starts again by itself)`)
      installStep({ ...s, step: 'cut off', cut_at: s.at })
    } else if (s.step === 'failed' && !s.said) {
      console.error(`[update] the last automatic install of ${s.short || s.sha} failed (${s.at}): ${s.error}`)
      fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...s, said: true }, null, 1))
    }
  } catch {}
  try {
    const rolledFile = path.join(backendDirOf(config().projectRoot), 'data', 'rolled-back.json')
    const r = JSON.parse(fs.readFileSync(rolledFile, 'utf8'))
    if (r && !r.said) {
      console.error(`[update] this PC went back from ${String(r.from || '?').slice(0, 7)} to ${String(r.to || '?').slice(0, 7)} on ${r.at}: ${r.why}${r.failed?.length ? ` (not put back: ${r.failed.join(', ')})` : ''} — not installed again by itself until Adal says so`)
      fs.writeFileSync(rolledFile, JSON.stringify({ ...r, said: new Date().toISOString() }, null, 2))
    }
  } catch {}
}

async function autoUpdate(db, result) {
  if (!result?.hasUpdate || updateNotice.applying) return
  if (!(await autoUpdateOn(db))) return
  const installed = result.installed || await getInstalled()
  if (installed.isRepo) return // a developer's copy: never pulled by itself
  const sha = result.latest?.sha || ''
  // Staged release: this PC's turn has not come yet (it can still be installed by hand).
  if (result.waitUntil && Date.parse(result.waitUntil) > Date.now()) return
  // Went back from it by itself: never again by itself until Adal assigns a retry.
  if (result.blocked) return
  // A version this PC had to go back from is not installed again by itself.
  try {
    const { rolledBack } = await import('../../safeStart.js')
    if (sha && rolledBack(backendDirOf(config().projectRoot))?.from === sha) return
  } catch {}
  // A release that failed waits 2 hours (a cut download: 15 minutes, it goes on from where it stopped).
  if (sha && sha === autoState.failedSha && Date.now() - autoState.failedAt < (autoState.failedDownload ? 15 * 60 * 1000 : 2 * 3600 * 1000)) return
  const b = await busyNow(db)
  const hold = holdForRuns(b.busy, autoState.waitingSince)
  autoState.waitingSince = hold.since
  const waited = hold.waited
  if (hold.wait) {
    console.log(`🆕 Update ${result.latest?.short} waits: ${b.running} run(s) working, ${b.waiting} in line`)
    return
  }
  if (b.busy) console.log(`🆕 Update ${result.latest?.short} waited ${Math.round(waited / 60000)} min for ${b.running} run(s) working, ${b.waiting} in line — installing now`)
  autoState.waitingSince = 0
  console.log(`🆕 Installing update ${result.latest?.short} by itself (${result.count} change(s))`)
  installStep({ sha, short: result.latest?.short, step: 'installing' })
  updateNotice.auto = true
  // applyUpdate answers like a route; this collects its answer.
  const res = { code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } }
  updateNotice.applying = true
  updateNotice.applyingSince = new Date().toISOString()
  try { await applyUpdate(null, res) } catch (e) { res.code = 500; res.body = { error: e.message } } finally {
    updateNotice.applying = false
    updateNotice.auto = false
  }
  installStep({ sha, short: result.latest?.short, step: res.code >= 400 || !res.body?.success ? 'failed' : 'installed', error: res.body?.error || null, log: String(res.body?.log || '').slice(-1500) })
  if (res.code >= 400 || !res.body?.success) {
    Object.assign(autoState, { failedSha: sha, failedAt: Date.now(), failedSource: result.source || '', failedDownload: /download|fetch|timeout|abort|stalled|no answer|Supabase/i.test(String(res.body?.error || '')) })
    updateNotice.autoError = res.body?.error || 'the update did not install'
    console.error(`[update] automatic update failed: ${updateNotice.autoError}`)
  } else {
    updateNotice.autoError = null
    updateNotice.result = null
    console.log(`✅ Update ${result.latest?.short} installed by itself — ${res.body.message}`)
  }
}

/**
 * Going back by itself (services/autoUndo.js): the way back signed into the
 * release this PC runs (kept here, else Supabase), else the copy
 * safeStart.js kept of the version before. Waits for runs at most 10 minutes.
 */
export async function autoRollback(reason) {
  const logs = []
  try {
    for (let since = 0; ;) {
      const b = await busyNow(dbOf())
      const h = holdForRuns(b.busy, since)
      if (!h.wait) break
      since = h.since
      await new Promise(r => setTimeout(r, 30_000))
    }
    while (updateNotice.applying) await new Promise(r => setTimeout(r, 5000))
    const plan = await rollbackPlan()
    if (plan.available) {
      const L = await import('../services/lanRelease.js')
      const installed = await getInstalled()
      const mine = installedRelease(installed, L.current()?.manifest)
      console.log(`↩️ Going back by itself from ${plan.from} to ${plan.to}: ${reason}`)
      updateNotice.applying = true
      updateNotice.applyingSince = new Date().toISOString()
      try {
        const r = await installEnvelope(config(), logs, installed, mine, rollbackOf(L.current().manifest), {}, null)
        return r.success ? { ok: true, to: plan.to } : { ok: false, to: plan.to, error: r.error }
      } finally { updateNotice.applying = false; updateNotice.result = null }
    }
    // No signed way back (an older release): the copy kept before the update.
    const S = await import('../../safeStart.js')
    const backendDir = backendDirOf(config().projectRoot)
    let prev = null
    try { prev = JSON.parse(fs.readFileSync(path.join(S.paths(backendDir).prev, 'version.json'), 'utf8')) } catch {}
    if (prev?.sha && prev.sha === Undo.probation()?.from) {
      const r = S.rollBack(backendDir, prev, reason)
      setTimeout(() => process.exit(1), 3000) // the launcher starts the version put back
      return { ok: !r.failed.length, to: String(prev.sha).slice(0, 7), error: r.failed.length ? `not put back: ${r.failed.join(', ')}` : '' }
    }
    return { ok: false, error: plan.reason || 'no version before is kept on this PC' }
  } catch (e) { return { ok: false, error: e.message } }
}

/** Admin's decisions for a release this PC went back from (release/assign.json, signed on Adal's PC). */
async function applyAssignments() {
  const open = Undo.reports().filter(r => r.status === 'rolled-back' || r.status === 'kept')
  if (!open.length) return
  const { readSigned } = await import('../services/updateChannel.js')
  const rules = Undo.readAssign(await readSigned('assign.json').catch(() => null))
  if (!rules.length) return
  let agency = ''
  try { agency = await withTimeout((await import('../services/chatCloud.js')).cloudAgencyId(dbOf()), 5000, '') || '' } catch {}
  for (const row of open) {
    const d = Undo.decisionFor(rules, row, { agency })
    if (d && Undo.settle(row.sha, d)) {
      console.log(`📋 Adal decided for ${row.short}: ${d === 'keep' ? 'stay on the version before' : 'try it again'}`)
      if (d !== 'keep') lastCheck = 0
    }
  }
}

/** The self-check of a version just installed (services/autoUndo.js). */
function undoChecks(db, sha) {
  const cfg = config()
  const backendDir = backendDirOf(cfg.projectRoot)
  return {
    files: async () => {
      const kept = (await import('../services/lanRelease.js')).current()?.manifest
      if (kept?.sha !== sha || !kept.app_files) return ''
      const bad = Undo.filesDiffer(kept.app_files, cfg.projectRoot, backendDir)
      return bad.length ? `${bad.length} file(s) not as signed (${bad.slice(0, 3).join(', ')})` : ''
    },
    packages: async () => { const b = await brokenPackages(backendDir); return b.length ? `${b.join(', ')} do not load` : '' },
    database: async () => { if (!db) return ''; const ok = await withTimeout(db.raw('select 1').then(() => true), 10_000, false); return ok ? '' : 'no answer in 10 s' },
    server: async () => {
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/api/health`, { signal: AbortSignal.timeout(10_000) })
      return r.status >= 500 ? `answers ${r.status}` : ''
    },
  }
}

/** Looks for a new version now and then, and installs it by itself (see autoUpdate). */
// A Companion newer than this main PC hands its signed release here (services/peerUpdate.js). Off: ADAL_PEER_UPDATES=0.
let peerSince = 0
async function peerTick(db) {
  const P = await import('../services/peerUpdate.js')
  if (!P.peerUpdatesOn() || updateNotice.applying) return
  if ((await import('../services/mainPC.js')).isCompanion()) return
  if (!(await autoUpdateOn(db))) return
  const L = await import('../services/lanRelease.js')
  await P.peerStep({
    peers: async () => (await import('../services/remoteBrowsers.js')).deviceDoors(),
    mine: async () => installedRelease(await getInstalled(), L.current()?.manifest),
    busy: async () => { const h = holdForRuns((await busyNow(db)).running > 0, peerSince); peerSince = h.since; return h.wait },
    apply: async (dir) => {
      updateNotice.applying = true; updateNotice.applyingSince = new Date().toISOString()
      try { return await applyLocalRelease(dir) } finally { updateNotice.applying = false }
    },
    notice: updateNotice,
  })
}
export function startUpdateWatcher(db = null) {
  setUpdateDb(db)
  if (db) updateDb = db
  if (watcher) return
  // Just updated: on probation (crash loops, a failed self-check or many errors go back by themselves).
  Undo.setUndoer(autoRollback)
  getInstalled().then(i => { if (!i.isRepo && i.sha) Undo.watch({ installedSha: i.sha, checks: undoChecks(db, i.sha) }) }).catch(() => {})
  const every = Number(process.env.UPDATE_CHECK_MINUTES || 15) * 60 * 1000
  sayLastInstall()
  let ticking = false
  const tick = async () => {
    // One look at a time: on a slow line a check outlasted the minute, and two looks then both
    // installed the same release into the same download (2026-11-24, Main).
    if (updateNotice.applying || ticking) return
    // A robot run has the internet (runFocus.js): no update look or download now; again a moment after it.
    try { const RF = await import('../services/runFocus.js'); if (RF.held('the update check')) { RF.later('the update check', tick); return } } catch {}
    ticking = true
    try {
      // GitHub is asked every UPDATE_CHECK_MINUTES; a found update is tried
      // again every minute until the runs are idle.
      let result = updateNotice.result
      if (!result || Date.now() - lastCheck >= every) {
        result = await checkForUpdate()
        lastCheck = Date.now()
        if (result.hasUpdate && result.latest.sha !== updateNotice.result?.latest?.sha) {
          console.log(`🆕 Update available: ${result.count} change(s), newest ${result.latest.short}`)
        }
        Object.assign(updateNotice, { checkedAt: new Date().toISOString(), result, error: null })
        await applyAssignments().catch(e => console.warn('[update] Adal\'s decisions:', e.message))
      }
      await autoUpdate(db, result)
      await peerTick(db).catch(e => console.warn('[peer-update]', e.message))
    } catch (e) {
      Object.assign(updateNotice, { checkedAt: new Date().toISOString(), error: e.message })
      console.error(`[update] the update look failed: ${e.message}`)
    } finally { ticking = false }
  }
  setTimeout(tick, 60 * 1000).unref?.()
  watcher = setInterval(tick, 60 * 1000)
  watcher.unref?.()
}

/** Quote a filesystem path for safe use in a shell command. */
const q = (value) => `"${String(value).replace(/"/g, '')}"`

/**
 * Locate the Node/npm pair used to install dependencies.
 *
 * A packaged (USB-installed) copy has NO system Node on PATH — it carries a
 * portable runtime in `<root>/runtime`. Prefer that, and only fall back to a
 * system-wide npm when the runtime is absent (developer machines).
 */
function findToolchain(projectRoot) {
  const roots = [projectRoot, path.join(BACKEND_ROOT, '..'), BACKEND_ROOT]
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'

  for (const root of roots) {
    const runtime = path.join(root, 'runtime')
    const node = path.join(runtime, nodeName)
    const npmCli = path.join(runtime, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (fs.existsSync(node) && fs.existsSync(npmCli)) return { node, npmCli }
  }
  for (const root of roots) {
    const node = path.join(root, 'runtime', nodeName)
    if (fs.existsSync(node)) return { node, npmCli: null }
  }
  return null
}

/** Build an npm invocation that works with or without a system npm. */
function npmCmd(toolchain, args) {
  if (toolchain?.npmCli) return `${q(toolchain.node)} ${q(toolchain.npmCli)} ${args}`
  return `npm ${args}`
}

/** Install npm deps, run migrations and build the frontend after a pull. */
async function installDependencies(projectRoot, logs) {
  const toolchain = findToolchain(projectRoot)
  logs.push(
    toolchain
      ? `Toolchain: ${toolchain.node}${toolchain.npmCli ? ' (bundled npm)' : ' (system npm)'}`
      : 'Toolchain: system npm from PATH',
  )

  const backend = backendDirOf(projectRoot)
  if (fs.existsSync(path.join(backend, 'package.json'))) {
    const ni = await run(npmCmd(toolchain, 'install --omit=dev --no-audit --no-fund'), backend, 20 * 60 * 1000)
    logs.push(`[backend] npm install → ${ni.ok ? 'ok' : 'failed'}\n${ni.out.slice(-400)}`)

    const knexCli = path.join(backend, 'node_modules', 'knex', 'bin', 'cli.js')
    const migrate = fs.existsSync(knexCli)
      ? await run(`${q(toolchain?.node || 'node')} ${q(knexCli)} migrate:latest`, backend)
      : await run('npx knex migrate:latest', backend)
    logs.push(`[backend] migrate → ${migrate.ok ? 'ok' : 'skipped'}\n${migrate.out.slice(-300)}`)
  }

  const frontend = path.join(projectRoot, 'adal-keep-frontend')
  if (fs.existsSync(path.join(frontend, 'package.json'))) {
    const ni = await run(npmCmd(toolchain, 'install --no-audit --no-fund'), frontend, 20 * 60 * 1000)
    logs.push(`[frontend] npm install → ${ni.ok ? 'ok' : 'failed'}\n${ni.out.slice(-400)}`)

    const build = await run(npmCmd(toolchain, 'run build'), frontend, 20 * 60 * 1000)
    logs.push(`[frontend] build → ${build.ok ? 'ok' : 'failed'}\n${build.out.slice(-400)}`)
  }
}

/** Fallback for installs that are not a git checkout: download the source
 *  tarball straight from GitHub and copy it over the app, preserving data. */
async function installFromTarball(cfg, logs, sha = '') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-update-'))
  try {
    const archive = path.join(tmp, 'source.tar.gz')
    // Exactly the version that is recorded as installed afterwards (a change
    // published during the download must not make the next check offer the
    // same update again).
    const ref = sha || `refs/heads/${cfg.branch}`
    const url = cfg.token
      ? `https://api.github.com/repos/${cfg.repo}/tarball/${encodeURIComponent(sha || cfg.branch)}`
      : `https://codeload.github.com/${cfg.repo}/tar.gz/${ref.split('/').map(encodeURIComponent).join('/')}`
    const headers = { 'User-Agent': 'adal-keep-updater' }
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`

    const res = await fetch(url, { headers })
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`)
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(archive)
      Readable.fromWeb(res.body).pipe(ws).on('finish', resolve).on('error', reject)
    })
    logs.push(`Downloaded ${(fs.statSync(archive).size / 1048576).toFixed(1)} MB from GitHub`)

    const extracted = path.join(tmp, 'src')
    fs.mkdirSync(extracted, { recursive: true })
    const tar = await run(`"${TAR}" -xzf "${archive}" -C "${extracted}"`, tmp, 5 * 60 * 1000)   // Windows: its own tar.exe (Git's tar reads C: as a host)
    if (!tar.ok) throw new Error(`Extraction failed (is "tar" installed?): ${tar.out.slice(-300)}`)

    const entries = fs.readdirSync(extracted, { withFileTypes: true }).filter((e) => e.isDirectory())
    const rootDir = entries.length ? path.join(extracted, entries[0].name) : extracted

    const keepData = (from) => (src) => {
      const rel = path.relative(from, src)
      if (!rel) return true
      return !rel.split(path.sep).some((part) => PROTECTED.has(part))
    }
    // Only the app itself: the backend into the folder the server runs from,
    // the frontend source next to it (built below, then served from its dist).
    const backendDir = backendDirOf(cfg.projectRoot)
    for (const [from, to] of [
      [path.join(rootDir, 'adal-keep-backend'), backendDir],
      [path.join(rootDir, 'adal-keep-frontend'), path.join(cfg.projectRoot, 'adal-keep-frontend')],
    ]) {
      if (!fs.existsSync(from)) throw new Error(`the download has no ${path.basename(from)} folder`)
      fs.cpSync(from, to, { recursive: true, force: true, filter: keepData(from) })
      logs.push(`Updated ${to} (user data preserved)`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Adal's signed release from Supabase: the backend code and the frontend
 * already built — no frontend build on the PC, and npm install only when the
 * package list changed. Returns the marker to write.
 */
/** The packages main.js needs that do not load in `backendDir` (each tried in its own Node). */
export const CORE_PACKAGES = ['express', 'knex', 'sqlite3', 'sharp', 'puppeteer', 'dotenv', 'bcryptjs']
export async function brokenPackages(backendDir, names = CORE_PACKAGES) {
  const out = []
  for (const n of names) {
    const r = await run(`"${process.execPath}" -e "require(${JSON.stringify(n).replace(/"/g, '\\"')})"`, backendDir, 60 * 1000)
    if (!r.ok) out.push(n)
  }
  return out
}

export async function installFromRelease(cfg, logs, manifest, localArchive = null, pieceFrom = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-update-'))
  try {
    const archive = localArchive || path.join(tmp, 'release.tar.gz')
    const L = await import('../services/lanRelease.js')
    // From Supabase (or kept here / rebuilt from a patch); checked against the signed manifest.
    if (!localArchive) await L.fetchPiece(manifest, { file: manifest.file, sha256: manifest.sha256 }, archive, pieceFrom)
    logs.push(`Downloaded ${(fs.statSync(archive).size / 1048576).toFixed(1)} MB (signed by Adal, checked)`)
    await L.keepPiece(manifest.sha256, archive).catch(() => {})   // kept: "Go back to previous version" and the next patch start from it
    const extracted = path.join(tmp, 'src')
    fs.mkdirSync(extracted, { recursive: true })
    // The .tar.gz, or the plain .tar a patch rebuilt (updates v2).
    const gz = (() => { try { const fd = fs.openSync(archive, 'r'); const b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); return b[0] === 0x1f && b[1] === 0x8b } catch { return true } })()
    const tar = await run(`"${TAR}" -x${gz ? 'z' : ''}f "${archive}" -C "${extracted}"`, tmp, 5 * 60 * 1000)
    if (!tar.ok) throw new Error(`Extraction failed: ${tar.out.slice(-300)}`)
    const keepData = (from) => (src) => {
      const rel = path.relative(from, src)
      if (rel && rel.split(path.sep).some((part) => PROTECTED.has(part))) return false
      // A program the server runs (bin/*.exe) that has not changed is left as it
      // is: Windows refuses to overwrite a running one, and that stopped the whole update.
      if (/\.exe$/i.test(src)) {
        try {
          const dest = path.join(backendDirOf(cfg.projectRoot), rel)
          if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size && fs.readFileSync(dest).equals(fs.readFileSync(src))) return false
        } catch {}
      }
      return true
    }
    // The double-C watcher lets go of its file (it starts again with the new server).
    try { await (await import('../services/screenClip.js')).stopClipWatcher() } catch {}
    const backendDir = backendDirOf(cfg.projectRoot)
    const from = path.join(extracted, 'adal-keep-backend')
    if (!fs.existsSync(path.join(from, 'server.js'))) throw new Error('the release has no backend')
    // The version that works now is kept: if the new one does not start, the PC goes back to it (safeStart.js).
    try {
      const { savePrevious } = await import('../../safeStart.js')
      if (savePrevious(backendDir, fs.readdirSync(from).filter(n => !PROTECTED.has(n)))) logs.push('Kept the version before it (it comes back by itself if the new one does not start)')
    } catch (e) { logs.push(`Could not keep the version before it: ${e.message}`) }
    fs.cpSync(from, backendDir, { recursive: true, force: true, filter: keepData(from) })
    logs.push(`Updated ${backendDir} (user data preserved)`)
    // The built pages: a clean folder (old builds' files do not pile up).
    const dist = path.join(cfg.projectRoot, 'adal-keep-frontend', 'dist')
    const fresh = path.join(extracted, 'adal-keep-frontend', 'dist')
    if (fs.existsSync(path.join(fresh, 'index.html'))) {
      const old = `${dist}.old`
      fs.rmSync(old, { recursive: true, force: true })
      if (fs.existsSync(dist)) fs.renameSync(dist, old)
      fs.mkdirSync(path.dirname(dist), { recursive: true })
      fs.cpSync(fresh, dist, { recursive: true })
      fs.rmSync(old, { recursive: true, force: true })
      logs.push(`Updated ${dist}`)
    }
    // The Windows programs (AdalKeep.exe, the Companion, the agent): only the
    // ones that changed. A running program cannot be overwritten, but it can be
    // renamed: the old one becomes <name>.old and the new one is used from the next start.
    // 32-bit Windows: the GOARCH=386 builds (never a 64-bit program there).
    const progs = programsFor(manifest)
    if (progs.missing) logs.push(`No 32-bit programs in ${manifest.short}: this ${pcArch()} PC keeps the ones it has`)
    for (const p of progs.list) {
      try {
        const dest = path.join(cfg.projectRoot, p.name)
        if (!PROGRAMS.has(p.name) || !fs.existsSync(dest)) continue
        const { createHash } = await import('crypto')
        if (createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === p.sha256) continue
        const got = path.join(tmp, p.name)
        // A small patch from the program installed here when the release has one (updates v2).
        await L.fetchPiece(manifest, p, got, { ...pieceFrom, local: [dest, `${dest}.old`] })
        fs.rmSync(`${dest}.old`, { force: true })
        fs.renameSync(dest, `${dest}.old`)
        try { fs.copyFileSync(got, dest) } catch (e) { fs.renameSync(`${dest}.old`, dest); throw e }
        logs.push(`Updated ${p.name} (used from the next start)`)
      } catch (e) { logs.push(`${p.name} not updated: ${e.message}`) }
    }
    // Packages: only when their list changed (or are missing).
    const marker = readMarker(cfg.projectRoot) || {}
    const hasModules = fs.existsSync(path.join(backendDir, 'node_modules'))
    if (!hasModules || marker.lock_hash !== manifest.lock_hash) {
      const toolchain = findToolchain(cfg.projectRoot)
      const ni = await run(npmCmd(toolchain, 'install --omit=dev --no-audit --no-fund'), backendDir, 20 * 60 * 1000)
      logs.push(`[backend] npm install → ${ni.ok ? 'ok' : 'failed'}\n${ni.out.slice(-400)}`)
      if (!ni.ok && !hasModules) throw new Error('npm install failed')
    } else logs.push('Packages unchanged — no npm install')
    // The packages the server cannot start without must load (2026-11-17: an
    // install cut off half-way left knex and puppeteer gutted, and the PC was
    // down — a rollback restores code, not packages). Broken: installed again.
    const broken = await brokenPackages(backendDir)
    if (broken.length) {
      logs.push(`Packages broken (${broken.join(', ')}) — installing them again`)
      const toolchain = findToolchain(cfg.projectRoot)
      const again = await run(npmCmd(toolchain, 'install --omit=dev --no-audit --no-fund --force'), backendDir, 20 * 60 * 1000)
      const still = await brokenPackages(backendDir)
      logs.push(`[backend] npm install again → ${again.ok ? 'ok' : 'failed'}${still.length ? ` — still broken: ${still.join(', ')}` : ' — all load'}`)
      if (still.length) throw new Error(`packages still broken after a second install: ${still.join(', ')}`)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// POST /api/system/update/apply — fetch + install the latest revision
// ---------------------------------------------------------------------------
async function handleApply(req, res) {
  // Pressed again (or on two PCs at once): the update that is running is enough.
  if (updateNotice.applying) {
    return res.status(409).json({ error: 'The update is already being installed — wait for the page to reload by itself.', applying: true })
  }
  // A move from another system (Transitions) is lost by the restart: even a
  // pressed "Update now" waits for it (it installs by itself when the move ends).
  try {
    if ((await import('../services/transition.js')).transitionRunning() && !req.body?.force) {
      return res.status(409).json({ error: 'A move from another system is running (Settings → Transitions). The update installs by itself as soon as it ends.', moving: true })
    }
  } catch {}
  updateNotice.applying = true
  updateNotice.applyingSince = new Date().toISOString()
  try { return await applyUpdate(req, res) } finally {
    updateNotice.applying = false
    updateNotice.result = null // the next look compares again with the new version
  }
}

/**
 * Installs one signed release ({ manifest, signature }) on an installed PC:
 * only forward, the app first fetched whole into the cache (kept here, a patch,
 * or Supabase, resumable), then put in place. Answers like a route
 * ({ success, … } or { code, error }).
 */
async function installEnvelope(cfg, logs, installed, mine, env, from = {}) {
  const L = await import('../services/lanRelease.js')
  if (!env?.manifest || !verifyManifest(env.manifest, env.signature)) return { code: 400, error: 'The release is not signed by Adal — not installed' }
  let manifest = env.manifest
  if (installed.sha && (installed.sha === manifest.sha || (L.orderKnown(mine) && !L.isNewer(manifest, mine)))) {
    return { success: true, alreadyUpToDate: true, branch: 'release', source: from.source || 'supabase', message: `Already up to date — this PC runs ${installed.short}, the release offered (${manifest.short}) is not newer.` }
  }
  // An older version (a rollback) must be able to read this PC's database.
  const refused = await databaseRefusal(dbOf(), manifest)
  if (refused) return { code: 409, error: refused, databaseAhead: true }
  const app = { file: manifest.file, sha256: manifest.sha256 }
  try {
    await L.fetchPiece(manifest, app, null, from)
  } catch (e) {
    logs.push(`Download of ${manifest.short} failed: ${e.message}`)
    throw e
  }
  await installFromRelease(cfg, logs, manifest, null, from)
  WhatsNew.rememberInstalled(manifest)
  // On probation: a version that breaks this PC goes back by itself (services/autoUndo.js).
  if (!manifest.rollback_of) Undo.beginProbation({ to: manifest, from: mine })
  else Undo.endProbation()
  await L.recordInstalled(env, cfg.projectRoot).catch(e => logs.push(`Not kept here: ${e.message}`))
  writeMarker(cfg.projectRoot, { sha: manifest.sha, branch: 'release', source: manifest.lan ? 'lan' : 'supabase', lock_hash: manifest.lock_hash, message: manifest.message, date: manifest.date || '', published_at: manifest.published_at || '', ...(manifest.seq ? { seq: manifest.seq } : {}) })
  mineNow = manifest
  const restarts = ['AdalKeep.exe', 'run-server.bat'].some(f => fs.existsSync(path.join(cfg.projectRoot, f)))
  if (restarts) setTimeout(() => process.exit(0), 3000)
  return {
    success: true, branch: 'release', source: 'supabase',
    installed: { sha: manifest.sha, short: manifest.short },
    message: restarts ? 'Update installed. The server restarts now — reload the page in about 20 seconds.' : 'Update installed. Please restart the app to apply changes.',
  }
}

/**
 * "Go back to previous version" on this PC: { available, from, to, refused, reason }.
 * Only the way back signed into the release this PC runs (never a bare downgrade).
 */
export async function rollbackPlan(db = dbOf()) {
  const installed = await getInstalled()
  if (installed.isRepo) return { available: false, reason: 'A developer\'s git checkout: use git.' }
  const L = await import('../services/lanRelease.js')
  const kept = L.current()?.manifest
  if (!kept || kept.sha !== installed.sha) return { available: false, reason: 'This PC does not keep the signed release it runs yet — try again after the next update check.' }
  const back = rollbackOf(kept)
  if (!back) return { available: false, from: kept.short, reason: kept.rollback_of ? 'This PC already went back once. The next version from Adal moves it forward again.' : 'This version has no way back signed by Adal (it was published before this button existed).' }
  const refused = await databaseRefusal(db, back.manifest)
  return { available: !refused, from: kept.short, to: back.manifest.short, refused: refused || '', reason: refused || '' }
}

const ROLLBACK_ROLES = new Set(['owner', 'admin'])
async function handleRollback(req, res) {
  if (req.auth && !ROLLBACK_ROLES.has(req.auth.role)) return res.status(403).json({ error: 'Only an admin can go back to the previous version.' })
  if (updateNotice.applying) return res.status(409).json({ error: 'An update is being installed already — wait for the page to reload by itself.', applying: true })
  if (req.app?.locals?.db) updateDb = req.app.locals.db
  const logs = []
  updateNotice.applying = true
  updateNotice.applyingSince = new Date().toISOString()
  try {
    const plan = await rollbackPlan()
    if (!plan.available) return res.status(plan.refused ? 409 : 400).json({ error: plan.reason, databaseAhead: !!plan.refused })
    if (!req.body?.force) {
      const b = await busyNow(dbOf())
      if (b.busy) return res.status(409).json({ error: `${b.running} run(s) working and ${b.waiting} waiting: going back restarts the server. Wait until they finish, or press again to go back anyway.`, busy: true })
    }
    const L = await import('../services/lanRelease.js')
    const installed = await getInstalled()
    const mine = installedRelease(installed, L.current()?.manifest)
    const back = rollbackOf(L.current().manifest)
    logs.push(`Going back from ${plan.from} to ${plan.to} (signed by Adal) — this PC's kept pieces first, Supabase next`)
    console.log(`↩️ Going back from ${plan.from} to ${plan.to}`)
    const result = await installEnvelope(config(), logs, installed, mine, back, {}, null)
    if (result.success && !result.alreadyUpToDate) result.message = `Went back to ${plan.to}. The other PCs follow at their next update check. ${result.message.replace(/^Update installed\.\s*/, '')}`
    res.status(result.code || 200).json({ ...result, code: undefined, log: logs.join('\n').slice(-4000) })
  } catch (err) {
    console.error('[system/update/rollback]', err.message)
    res.status(500).json({ error: err.message, log: logs.join('\n').slice(-4000) })
  } finally {
    updateNotice.applying = false
    updateNotice.result = null
  }
}

/** The update as the background check runs it (also for tests): { code, body }. */
export async function applyNow() {
  const res = { code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } }
  await applyUpdate(null, res)
  return res
}

/**
 * A signed release from a local folder or .zip / .tar.gz installed here (for a
 * main PC whose internet is down: the release copied over the LAN by scp).
 * Adal's signature and every piece's SHA-256 are checked; only forward unless
 * `force` (never an unsigned one). Used by POST /update/apply-local and by
 * scripts/apply-release.mjs (which runs this code from the release itself, so
 * it works on a PC whose server is older than this route).
 * Returns { code?, success?, error?, message, log }.
 */
export async function applyLocalRelease(src, { force = false } = {}) {
  const cfg = config()
  const logs = []
  try {
    const installed = await getInstalled()
    if (installed.isRepo) return { code: 400, error: 'A developer\'s git checkout: use git, not a release file.' }
    const L = await import('../services/lanRelease.js')
    const env = await L.importRelease(src)
    logs.push(`Release ${env.manifest.short} from ${src}: signed by Adal, ${env.pieces} of ${env.of} piece(s) here and checked`)
    const mine = force ? null : installedRelease(installed, L.current()?.manifest)
    const result = await installEnvelope(cfg, logs, force ? { ...installed, sha: '' } : installed, mine, { manifest: env.manifest, signature: env.signature }, { cloud: false, source: 'file' })
    console.log(`[system/update/apply-local] ${result.error || result.message}`)
    return { ...result, log: logs.join('\n').slice(-4000) }
  } catch (err) {
    console.error('[system/update/apply-local]', err.message)
    return { code: 500, error: err.message, log: logs.join('\n').slice(-4000) }
  }
}

/**
 * POST /api/system/update/apply-local   (this PC only: 127.0.0.1)
 *   { path } or ?path=   a folder or .zip / .tar.gz with a signed release
 *   (another PC's data/lan-release or updates folder, or scripts/release-bundle.mjs)
 *   force=1              also a release that is not newer (never an unsigned one)
 */
async function handleApplyLocal(req, res) {
  const { isLocal } = await import('../services/networkGate.js')
  if (!isLocal(req)) return res.status(403).json({ error: 'Only on this PC itself (127.0.0.1)' })
  if (updateNotice.applying) return res.status(409).json({ error: 'An update is being installed already.' })
  const src = String(req.body?.path || req.query?.path || '').trim()
  if (!src) return res.status(400).json({ error: 'Give the path of the release folder or .zip: {"path": "C:/Users/hp/adal-release.zip"}' })
  updateNotice.applying = true
  updateNotice.applyingSince = new Date().toISOString()
  try {
    const force = ['1', 'true', 'yes'].includes(String(req.body?.force ?? req.query?.force ?? '').toLowerCase())
    // Not while a run works (10 minutes at most, as every update); force: at once.
    for (let since = 0; !force && !['1', 'true'].includes(String(req.body?.now ?? ''));) {
      const h = holdForRuns((await busyNow(dbOf())).running > 0, since)
      if (!h.wait) break
      since = h.since
      await new Promise(r => setTimeout(r, 5000))
    }
    const r = await applyLocalRelease(src, { force })
    res.status(r.code || 200).json({ ...r, code: undefined })
  } finally {
    updateNotice.applying = false
    updateNotice.result = null
  }
}


async function applyUpdate(req, res) {
  const cfg = config()
  const logs = []
  try {
    const installed = await getInstalled()
    setUpdateDb(req?.app?.locals?.db)
    if (req?.app?.locals?.db) updateDb = req.app.locals.db

    // --- Installed PC: Adal's signed release from Supabase ---
    if (!installed.isRepo) {
      const L = await import('../services/lanRelease.js')
      const mine = installedRelease(installed, L.current()?.manifest)
      mineNow = mine
      try { await latestRelease('release') } catch (e) { throw new Error(`Supabase updates: ${e.message}`) }
      const env = lastEnvelope
      if (!env) throw new Error('Supabase updates: no release published yet')
      const result = await installEnvelope(cfg, logs, installed, mine, env, {})
      return res.status(result.code || 200).json({ ...result, code: undefined, log: logs.join('\n').slice(-4000) })
    }

    // The revision GitHub currently publishes on the tracked branch — this is
    // what we record in the marker so the next "check" reports "up to date".
    let targetSha = ''
    try {
      const commit = await github(`/commits/${encodeURIComponent(cfg.branch)}`)
      targetSha = commit.sha || ''
    } catch (err) {
      logs.push(`Could not read the target revision from GitHub: ${err.message}`)
    }

    // --- Non-git install (packaged/USB install): pull the GitHub tarball ---
    if (!installed.isRepo) {
      logs.push(`Not a git checkout (${cfg.projectRoot}); fetching source from GitHub.`)
      await installFromTarball(cfg, logs, targetSha)

      // Copying source files is not enough: the backend needs its new
      // dependencies and the frontend has to be re-bundled.
      await installDependencies(cfg.projectRoot, logs)

      writeMarker(cfg.projectRoot, { sha: targetSha, branch: cfg.branch })
      // USB install: AdalKeep.exe (older installs: run-server.bat) starts the
      // server again when it exits, so exiting loads the new code. Give the
      // answer time to reach the page.
      const restarts = ['AdalKeep.exe', 'run-server.bat'].some(f => fs.existsSync(path.join(cfg.projectRoot, f)))
      if (restarts) setTimeout(() => process.exit(0), 3000)
      return res.json({
        success: true,
        branch: cfg.branch,
        installed: { sha: targetSha, short: targetSha.slice(0, 7) },
        message: restarts
          ? 'Update installed. The server restarts now — reload the page in about 20 seconds.'
          : 'Update downloaded from GitHub and installed. Please restart the app to apply changes.',
        log: logs.join('\n').slice(-4000),
      })
    }

    // --- Git checkout: fetch + fast-forward pull --------------------------
    logs.push(`Project root: ${cfg.projectRoot}`)
    // Never switch branches or pull over local edits: they would be lost or
    // would tangle the merge. Ignored data (uploads, database, .env) is not checked.
    const dirty = await run('git status --porcelain --untracked-files=no', cfg.projectRoot)
    if (dirty.ok && dirty.out.trim()) {
      throw new Error('Local changes exist in the code folder. Commit or stash them first, then update again.')
    }
    const auth = gitAuthArgs(cfg.token)
    const fetched = await run(`git ${auth}fetch origin ${cfg.branch}`, cfg.projectRoot)
    logs.push(`[git] fetch origin ${cfg.branch} → ${fetched.ok ? 'ok' : 'failed'}\n${fetched.out.slice(-500)}`)
    if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.out.slice(-300)}`)

    const remote = await run(`git rev-parse origin/${cfg.branch}`, cfg.projectRoot)
    const remoteSha = remote.ok ? remote.out.trim() : ''
    if (remoteSha && remoteSha === installed.sha) {
      return res.json({
        success: true, alreadyUpToDate: true, branch: cfg.branch,
        message: 'Already up to date — nothing to install.',
        log: logs.join('\n').slice(-4000),
      })
    }

    const curBranch = await run('git rev-parse --abbrev-ref HEAD', cfg.projectRoot)
    if (curBranch.ok && curBranch.out.trim() !== cfg.branch) {
      const checkout = await run(`git checkout ${cfg.branch}`, cfg.projectRoot)
      logs.push(`[git] checkout ${cfg.branch} → ${checkout.ok ? 'ok' : 'failed'}\n${checkout.out.slice(-400)}`)
      if (!checkout.ok) throw new Error(`Could not switch to branch "${cfg.branch}": ${checkout.out.slice(-300)}`)
    }

    const pulled = await run(`git ${auth}pull --ff-only origin ${cfg.branch}`, cfg.projectRoot)
    logs.push(`[git] pull → ${pulled.ok ? 'ok' : 'failed'}\n${pulled.out.slice(-600)}`)
    if (!pulled.ok) throw new Error(`git pull failed: ${pulled.out.slice(-300)}`)

    await installDependencies(cfg.projectRoot, logs)

    const head = await run('git log -1 --oneline', cfg.projectRoot)
    const newSha = await run('git rev-parse HEAD', cfg.projectRoot)
    writeMarker(cfg.projectRoot, { sha: newSha.ok ? newSha.out.trim() : '', branch: cfg.branch })

    res.json({
      success: true,
      branch: cfg.branch,
      message: head.ok && head.out ? `Updated to ${head.out.trim()}. Please restart the app.` : 'Update installed. Please restart the app.',
      log: logs.join('\n').slice(-4000),
    })
  } catch (err) {
    console.error('[system/update/apply]', err.message)
    res.status(500).json({ error: err.message || 'Update failed.', log: logs.join('\n').slice(-4000) })
  }
}

// ---------------------------------------------------------------------------
// The version this process started with (read once).
let BOOT_VERSION = ''
getInstalled().then(i => { BOOT_VERSION = i.sha || '' }).catch(() => {})

// Routes (mounted at /api/system)
// ---------------------------------------------------------------------------
// Windows: its own tar.exe (bsdtar). Git's tar, when first on the PATH, reads "C:…" as a host and fails.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe') : 'tar'
router.get('/update/check', handleCheck)
router.post('/update/apply', handleApply)
router.post('/update/apply-local', handleApplyLocal)

// "Go back to previous version" (services/rollback.js): what it would do, and doing it.
router.get('/update/rollback', async (req, res) => {
  try { res.json(await rollbackPlan(req.app.locals.db)) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/update/rollback', handleRollback)
// The "What's new" card: once per PC, after an update.
router.get('/update/whats-new', async (req, res) => {
  const installed = await getInstalled().catch(() => null)
  res.json({ whatsNew: WhatsNew.pending(installed?.sha) })
})
router.post('/update/whats-new/seen', (req, res) => res.json({ ok: WhatsNew.dismiss(String(req.body?.sha || '')) }))

// Backwards-compatible aliases
router.get('/check', handleCheck)
router.post('/apply', handleApply)
router.post('/update', handleApply)

// What the banner shows: the background check's last answer (no GitHub call).
router.get('/update/notice', async (req, res) => {
  let running = 0
  try { const { queueSnapshot } = await import('../services/worker.js'); running = queueSnapshot().running.length } catch {}
  let moving = false
  try { moving = (await import('../services/transition.js')).transitionRunning() } catch {}
  const r = updateNotice.result
  res.json({
    hasUpdate: !!r?.hasUpdate, count: r?.count || 0, changes: r?.changes || [], latest: r?.latest || null,
    installed: r?.installed || null, note: r?.note || null, checkedAt: updateNotice.checkedAt,
    applying: updateNotice.applying, running, moving, peer: updateNotice.peer || null,
    // The version this server runs now: an open page reloads when it changes.
    version: BOOT_VERSION, auto: updateNotice.auto, autoError: updateNotice.autoError,
    autoUpdate: await autoUpdateOn(req.app.locals.db),
  })
})

// The Adal Keep USB plugged into this PC (services/usbKeeper.js): its state, and the fix.
router.get('/update/usb', async (req, res) => {
  try { res.json(await (await import('../services/usbKeeper.js')).status()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/update/usb/fix', async (req, res) => {
  try {
    const K = await import('../services/usbKeeper.js')
    // Only a drive found by its label: never a path from the request.
    const d = (await K.findDrives()).find(x => x.root === req.body?.root)
    if (!d) return res.status(404).json({ error: 'The ADAL KEEP USB is not plugged in here.' })
    res.json(await K.fix(d.root, { label: d.label }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/update/status', async (req, res) => {
  const cfg = config()
  const installed = await getInstalled()
  res.json({ repo: cfg.repo, branch: installed.branch || cfg.branch, installed })
})

export default router
