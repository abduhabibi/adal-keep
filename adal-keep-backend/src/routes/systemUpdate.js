import { Router } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const execAsync = promisify(exec)
const router = Router()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = path.join(__dirname, '../..')
const PROJECT_ROOT = path.join(BACKEND_ROOT, '..')

function gitEnv() {
  const env = { ...process.env }
  const token = process.env.GITHUB_TOKEN || ''
  const repo = process.env.GITHUB_REPO || ''
  // HTTPS with token: https://x-access-token:TOKEN@github.com/owner/repo.git
  if (token && repo.includes('github.com')) {
    env.GIT_ASKPASS = 'echo'
    env.GIT_TERMINAL_PROMPT = '0'
  }
  return env
}

async function run(cmd, cwd) {
  const { stdout, stderr } = await execAsync(cmd, {
    cwd,
    env: gitEnv(),
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 10 * 60 * 1000
  })
  return { stdout: stdout || '', stderr: stderr || '' }
}

/**
 * POST /api/system/update
 * Pulls latest from GitHub branch and reinstalls deps / migrates.
 * Configure: GITHUB_REPO, GITHUB_BRANCH (default linux), GITHUB_TOKEN (private repos)
 */
router.post('/update', async (req, res) => {
  try {
    const branch = process.env.GITHUB_BRANCH || 'linux'
    const remoteRepo = (process.env.GITHUB_REPO || '').trim()
    const token = (process.env.GITHUB_TOKEN || '').trim()

    if (!fs.existsSync(path.join(PROJECT_ROOT, '.git'))) {
      if (!remoteRepo) {
        return res.status(400).json({
          error: 'Not a git repo and GITHUB_REPO is empty. Set GITHUB_REPO in .env'
        })
      }
      // clone into temp then rsync is dangerous; require existing git
      return res.status(400).json({
        error: 'Project root is not a git repository. Run git init && git remote add origin <url> once.'
      })
    }

    const logs = []

    // Optional: rewrite origin URL with token for private pull
    if (remoteRepo) {
      let url = remoteRepo
      if (token && url.startsWith('https://') && !url.includes('@')) {
        url = url.replace('https://', `https://x-access-token:${token}@`)
      }
      try {
        await run(`git remote set-url origin "${url}"`, PROJECT_ROOT)
        logs.push('origin URL updated')
      } catch (e) {
        logs.push('remote set-url: ' + e.message)
      }
    }

    const fetch = await run(`git fetch origin ${branch}`, PROJECT_ROOT)
    logs.push(fetch.stdout || fetch.stderr)
    const pull = await run(`git pull origin ${branch}`, PROJECT_ROOT)
    logs.push(pull.stdout || pull.stderr)

    // Install backend
    const be = path.join(PROJECT_ROOT, 'adal-keep-backend')
    if (fs.existsSync(path.join(be, 'package.json'))) {
      const ni = await run('npm install', be)
      logs.push('backend npm: ' + (ni.stdout || ni.stderr).slice(-500))
      try {
        const mig = await run('npx knex migrate:latest', be)
        logs.push('migrate: ' + (mig.stdout || mig.stderr).slice(-400))
      } catch (e) {
        logs.push('migrate skip/fail: ' + e.message)
      }
    }

    // Install + build frontend
    const fe = path.join(PROJECT_ROOT, 'adal-keep-frontend')
    if (fs.existsSync(path.join(fe, 'package.json'))) {
      const ni = await run('npm install', fe)
      logs.push('frontend npm: ' + (ni.stdout || ni.stderr).slice(-500))
      try {
        const b = await run('npm run build', fe)
        logs.push('build: ' + (b.stdout || b.stderr).slice(-500))
      } catch (e) {
        logs.push('build skip/fail: ' + e.message)
      }
    }

    let head = ''
    try {
      const h = await run('git log -1 --oneline', PROJECT_ROOT)
      head = (h.stdout || '').trim()
    } catch {}

    res.json({
      success: true,
      message: head ? `Updated to ${head}` : 'Update finished',
      branch,
      log: logs.join('\n').slice(-4000)
    })
  } catch (err) {
    console.error('[system/update]', err)
    res.status(500).json({
      error: err.message || 'Update failed',
      log: String(err.stderr || err.stdout || '').slice(-2000)
    })
  }
})

router.get('/update/status', async (req, res) => {
  try {
    const branch = process.env.GITHUB_BRANCH || 'linux'
    const { stdout } = await run('git rev-parse --abbrev-ref HEAD && git log -1 --oneline', PROJECT_ROOT)
    res.json({ branch, head: stdout.trim(), repo: process.env.GITHUB_REPO || null })
  } catch (e) {
    res.json({ error: e.message })
  }
})

export default router
