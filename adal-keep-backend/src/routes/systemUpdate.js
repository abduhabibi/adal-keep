import { Router } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'

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
async function handleCheck(req, res) {
  const cfg = config()
  try {
    const commit = await github(`/commits/${encodeURIComponent(cfg.branch)}`)
    const latest = describeCommit(commit)
    const installed = await getInstalled()
    const known = Boolean(installed.sha)
    const upToDate = known && installed.sha === latest.sha

    res.json({
      hasUpdate: !upToDate,
      upToDate,
      installed,
      latest,
      repo: cfg.repo,
      branch: cfg.branch,
      repoUrl: `https://github.com/${cfg.repo}`,
      compareUrl: known ? `https://github.com/${cfg.repo}/compare/${installed.sha}...${latest.sha}` : null,
      note: known ? null : 'Installed revision could not be detected; showing the latest published revision.',
    })
  } catch (err) {
    console.error('[system/update/check]', err.message)
    res.status(502).json({ error: 'Could not reach GitHub for updates.', details: err.message })
  }
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
async function installFromTarball(cfg, logs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adal-update-'))
  try {
    const archive = path.join(tmp, 'source.tar.gz')
    const url = cfg.token
      ? `https://api.github.com/repos/${cfg.repo}/tarball/${encodeURIComponent(cfg.branch)}`
      : `https://codeload.github.com/${cfg.repo}/tar.gz/refs/heads/${encodeURIComponent(cfg.branch)}`
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

// ---------------------------------------------------------------------------
// POST /api/system/update/apply — fetch + install the latest revision
// ---------------------------------------------------------------------------
async function handleApply(req, res) {
  const cfg = config()
  const logs = []
  try {
    const installed = await getInstalled()

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
      await installFromTarball(cfg, logs)

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
// Routes (mounted at /api/system)
// ---------------------------------------------------------------------------
router.get('/update/check', handleCheck)
router.post('/update/apply', handleApply)

// Backwards-compatible aliases
router.get('/check', handleCheck)
router.post('/apply', handleApply)
router.post('/update', handleApply)

router.get('/update/status', async (req, res) => {
  const cfg = config()
  const installed = await getInstalled()
  res.json({ repo: cfg.repo, branch: installed.branch || cfg.branch, installed })
})

export default router
