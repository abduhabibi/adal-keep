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
const PROTECTED = new Set(['.git', '.env', '.env.bak', 'data', 'uploads', 'logs', 'node_modules', MARKER])

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

async function run(cmd, cwd, timeout = 5 * 60 * 1000) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
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

/** Install npm deps, run migrations and build the frontend after a pull. */
async function installDependencies(projectRoot, logs) {
  const backend = path.join(projectRoot, 'adal-keep-backend')
  if (fs.existsSync(path.join(backend, 'package.json'))) {
    const ni = await run('npm install --no-audit --no-fund', backend)
    logs.push(`[backend] npm install → ${ni.ok ? 'ok' : 'failed'}\n${ni.out.slice(-400)}`)
    const mig = await run('npx knex migrate:latest', backend)
    logs.push(`[backend] migrate → ${mig.ok ? 'ok' : 'skipped'}\n${mig.out.slice(-300)}`)
  }
  const frontend = path.join(projectRoot, 'adal-keep-frontend')
  if (fs.existsSync(path.join(frontend, 'package.json'))) {
    const ni = await run('npm install --no-audit --no-fund', frontend)
    logs.push(`[frontend] npm install → ${ni.ok ? 'ok' : 'failed'}\n${ni.out.slice(-400)}`)
    const build = await run('npm run build', frontend)
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

    fs.cpSync(rootDir, cfg.projectRoot, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(rootDir, src)
        if (!rel) return true
        return !rel.split(path.sep).some((part) => PROTECTED.has(part))
      },
    })
    logs.push(`Extracted update into ${cfg.projectRoot} (user data preserved)`)
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

    // --- Non-git install: pull the GitHub tarball -------------------------
    if (!installed.isRepo) {
      logs.push(`Not a git checkout (${cfg.projectRoot}); fetching source from GitHub.`)
      await installFromTarball(cfg, logs)
      const after = await getInstalled()
      writeMarker(cfg.projectRoot, { sha: after.sha || '', branch: cfg.branch })
      return res.json({
        success: true,
        branch: cfg.branch,
        message: 'Update downloaded from GitHub and installed. Please restart the app to apply changes.',
        log: logs.join('\n').slice(-4000),
      })
    }

    // --- Git checkout: fetch + fast-forward pull --------------------------
    logs.push(`Project root: ${cfg.projectRoot}`)
    const fetched = await run(`git fetch origin ${cfg.branch}`, cfg.projectRoot)
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

    const pulled = await run(`git pull --ff-only origin ${cfg.branch}`, cfg.projectRoot)
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
