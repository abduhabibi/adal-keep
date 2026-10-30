import { Router } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { latestRelease, downloadRelease, setUpdateDb } from '../services/updateChannel.js'

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

async function run(cmd, cwd, timeout = 5 * 60 * 1000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      windowsHide: true,
      cwd,
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
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

function readMarker(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, MARKER), 'utf8')) } catch { return null }
}

function writeMarker(root, data) {
  try {
    fs.writeFileSync(path.join(root, MARKER), JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2))
  } catch { /* best-effort */ }
}

/** Detect the currently installed revision (git first, then marker file). */
async function getInstalled() {
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
  // Installed PCs: Adal's signed release in Supabase (the GitHub repository
  // may be private). GitHub stays as the fallback while PCs move over.
  let supabaseError = null
  if (!installedNow.isRepo) {
    try { return await checkSupabase(installedNow) } catch (e) { supabaseError = e.message }
  }
  try {
    const r = await checkGitHub()
    if (supabaseError) r.note = [r.note, `Supabase updates: ${supabaseError}`].filter(Boolean).join(' · ')
    return r
  } catch (e) {
    throw new Error(supabaseError ? `Supabase: ${supabaseError} · GitHub: ${e.message}` : e.message)
  }
}

async function checkSupabase(installed) {
  const m = await latestRelease('release')
  const upToDate = !!installed.sha && installed.sha === m.sha
  return {
    hasUpdate: !upToDate, upToDate, installed,
    latest: { sha: m.sha, short: m.short, message: m.message, date: m.date },
    changes: upToDate ? [] : (m.changes || []).slice(0, 40),
    count: upToDate ? 0 : (m.changes || []).length || 1,
    source: 'supabase', manifest: m,
    note: null,
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

/**
 * Updates by itself: an installed PC (USB install, not a developer's git
 * checkout) installs a new version as soon as no automation run is working
 * or waiting in line — a restart in the middle would cut a run off. Settings
 * → "Update by itself" (auto_update = off) or ADAL_AUTO_UPDATE=0 turns it off.
 * A failed install is tried again after 2 hours, never in a loop.
 */
const autoState = { failedSha: '', failedAt: 0, waitingSince: 0 }
async function autoUpdateOn(db) {
  if (String(process.env.ADAL_AUTO_UPDATE || '').trim() === '0') return false
  try {
    const row = db ? await db('settings').where('key', 'auto_update').first() : null
    if (row && String(row.value).toLowerCase() === 'off') return false
  } catch {}
  return true
}

async function busyNow(db) {
  let running = 0, waiting = 0
  try { const { runsWorking } = await import('../services/busy.js'); running = runsWorking() } catch {}
  try { if (db) waiting = Number((await db('automation_queue').where('status', 'pending').count({ c: '*' }).first())?.c || 0) } catch {}
  return { running, waiting, busy: running > 0 || waiting > 0 }
}

async function autoUpdate(db, result) {
  if (!result?.hasUpdate || updateNotice.applying) return
  if (!(await autoUpdateOn(db))) return
  const installed = result.installed || await getInstalled()
  if (installed.isRepo) return // a developer's copy: never pulled by itself
  const sha = result.latest?.sha || ''
  if (sha && sha === autoState.failedSha && Date.now() - autoState.failedAt < 2 * 3600 * 1000) return
  const b = await busyNow(db)
  if (b.busy) {
    if (!autoState.waitingSince) autoState.waitingSince = Date.now()
    console.log(`🆕 Update ${result.latest?.short} waits: ${b.running} run(s) working, ${b.waiting} in line`)
    return
  }
  autoState.waitingSince = 0
  console.log(`🆕 Installing update ${result.latest?.short} by itself (${result.count} change(s))`)
  updateNotice.auto = true
  // applyUpdate answers like a route; this collects its answer.
  const res = { code: 200, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b; return this } }
  updateNotice.applying = true
  updateNotice.applyingSince = new Date().toISOString()
  try { await applyUpdate(null, res) } finally {
    updateNotice.applying = false
    updateNotice.auto = false
  }
  if (res.code >= 400 || !res.body?.success) {
    Object.assign(autoState, { failedSha: sha, failedAt: Date.now() })
    updateNotice.autoError = res.body?.error || 'the update did not install'
    console.error(`[update] automatic update failed: ${updateNotice.autoError}`)
  } else {
    updateNotice.autoError = null
    updateNotice.result = null
    console.log(`✅ Update ${result.latest?.short} installed by itself — ${res.body.message}`)
  }
}

/** Looks for a new version now and then, and installs it by itself (see autoUpdate). */
export function startUpdateWatcher(db = null) {
  setUpdateDb(db)
  if (watcher) return
  const every = Number(process.env.UPDATE_CHECK_MINUTES || 15) * 60 * 1000
  let lastCheck = 0
  const tick = async () => {
    if (updateNotice.applying) return
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
      }
      await autoUpdate(db, result)
    } catch (e) {
      Object.assign(updateNotice, { checkedAt: new Date().toISOString(), error: e.message })
    }
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
    const tar = await run(`tar -xzf "${archive}" -C "${extracted}"`, tmp, 5 * 60 * 1000)
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
async function installFromRelease(cfg, logs, manifest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-update-'))
  try {
    const archive = path.join(tmp, 'release.tar.gz')
    await downloadRelease(manifest, archive)
    logs.push(`Downloaded ${(fs.statSync(archive).size / 1048576).toFixed(1)} MB from Supabase (signed by Adal, checked)`)
    const extracted = path.join(tmp, 'src')
    fs.mkdirSync(extracted, { recursive: true })
    const tar = await run(`tar -xzf "${archive}" -C "${extracted}"`, tmp, 5 * 60 * 1000)
    if (!tar.ok) throw new Error(`Extraction failed: ${tar.out.slice(-300)}`)
    const keepData = (from) => (src) => {
      const rel = path.relative(from, src)
      return !rel || !rel.split(path.sep).some((part) => PROTECTED.has(part))
    }
    const backendDir = backendDirOf(cfg.projectRoot)
    const from = path.join(extracted, 'adal-keep-backend')
    if (!fs.existsSync(path.join(from, 'server.js'))) throw new Error('the release has no backend')
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
    // Packages: only when their list changed (or are missing).
    const marker = readMarker(cfg.projectRoot) || {}
    const hasModules = fs.existsSync(path.join(backendDir, 'node_modules'))
    if (!hasModules || marker.lock_hash !== manifest.lock_hash) {
      const toolchain = findToolchain(cfg.projectRoot)
      const ni = await run(npmCmd(toolchain, 'install --omit=dev --no-audit --no-fund'), backendDir, 20 * 60 * 1000)
      logs.push(`[backend] npm install → ${ni.ok ? 'ok' : 'failed'}\n${ni.out.slice(-400)}`)
      if (!ni.ok && !hasModules) throw new Error('npm install failed')
    } else logs.push('Packages unchanged — no npm install')
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
  updateNotice.applying = true
  updateNotice.applyingSince = new Date().toISOString()
  try { return await applyUpdate(req, res) } finally {
    updateNotice.applying = false
    updateNotice.result = null // the next look compares again with the new version
  }
}

async function applyUpdate(req, res) {
  const cfg = config()
  const logs = []
  try {
    const installed = await getInstalled()
    setUpdateDb(req?.app?.locals?.db)

    // --- Installed PC: Adal's signed release from Supabase -----------------
    if (!installed.isRepo) {
      let manifest = null
      try { manifest = await latestRelease('release') } catch (e) { logs.push(`Supabase updates: ${e.message} — trying GitHub`) }
      if (manifest) {
        await installFromRelease(cfg, logs, manifest)
        writeMarker(cfg.projectRoot, { sha: manifest.sha, branch: 'release', source: 'supabase', lock_hash: manifest.lock_hash, message: manifest.message })
        const restarts = ['AdalKeep.exe', 'run-server.bat'].some(f => fs.existsSync(path.join(cfg.projectRoot, f)))
        if (restarts) setTimeout(() => process.exit(0), 3000)
        return res.json({
          success: true, branch: 'release', source: 'supabase',
          installed: { sha: manifest.sha, short: manifest.short },
          message: restarts ? 'Update installed. The server restarts now — reload the page in about 20 seconds.' : 'Update installed. Please restart the app to apply changes.',
          log: logs.join('\n').slice(-4000),
        })
      }
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
router.get('/update/check', handleCheck)
router.post('/update/apply', handleApply)

// Backwards-compatible aliases
router.get('/check', handleCheck)
router.post('/apply', handleApply)
router.post('/update', handleApply)

// What the banner shows: the background check's last answer (no GitHub call).
router.get('/update/notice', async (req, res) => {
  let running = 0
  try { const { queueSnapshot } = await import('../services/worker.js'); running = queueSnapshot().running.length } catch {}
  const r = updateNotice.result
  res.json({
    hasUpdate: !!r?.hasUpdate, count: r?.count || 0, changes: r?.changes || [], latest: r?.latest || null,
    installed: r?.installed || null, note: r?.note || null, checkedAt: updateNotice.checkedAt,
    applying: updateNotice.applying, running,
    // The version this server runs now: an open page reloads when it changes.
    version: BOOT_VERSION, auto: updateNotice.auto, autoError: updateNotice.autoError,
    autoUpdate: await autoUpdateOn(req.app.locals.db),
  })
})

router.get('/update/status', async (req, res) => {
  const cfg = config()
  const installed = await getInstalled()
  res.json({ repo: cfg.repo, branch: installed.branch || cfg.branch, installed })
})

export default router
