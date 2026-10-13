import { Router } from 'express'
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'

const execAsync = promisify(exec)
const router = Router()

router.post('/check', async (req, res) => {
  try {
    const isWindows = os.platform() === 'win32'
    // The commands assume the repo is one level above backend/
    // and that you have git, npm, npx available.
    const cmd = `
      cd .. &&
      git pull origin linux &&
      cd backend &&
      npm install &&
      npx knex migrate:latest &&
      cd ../frontend &&
      npm install &&
      npm run build
    `
    const { stdout, stderr } = await execAsync(cmd, { shell: true })
    // No auto‑restart – we leave that to the user or process manager.
    res.json({ success: true, output: stdout, error: stderr })
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack })
  }
})

export default router