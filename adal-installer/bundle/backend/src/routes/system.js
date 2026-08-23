import { Router } from 'express'
import os from 'os'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()

// Get all IPv4 addresses of the machine
router.get('/interfaces', (req, res) => {
  const ifaces = os.networkInterfaces()
  const list = []
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        list.push({ name, address: iface.address })
      }
    }
  }
  res.json(list)
})

// Bind the server to a specific IP by updating .env
router.post('/bind-ip', async (req, res) => {
  const { ip } = req.body
  if (!ip) return res.status(400).json({ error: 'IP address required' })

  const envPath = path.join(process.cwd(), '.env')
  let content = ''
  try {
    content = await fs.readFile(envPath, 'utf8')
  } catch {
    // .env may not exist; we'll create it.
  }

  // Replace or add LISTEN_IP
  if (/^LISTEN_IP=/m.test(content)) {
    content = content.replace(/^LISTEN_IP=.*/m, `LISTEN_IP=${ip}`)
  } else {
    content += `\nLISTEN_IP=${ip}\n`
  }

  await fs.writeFile(envPath, content)

  // Restart suggestion – we don't auto‑restart to avoid process killing.
  // On Windows you can use a process manager (PM2, nodemon) to restart on file change.
  res.json({
    message: 'LISTEN_IP updated to ' + ip + '. Please restart the server manually or use a process manager.'
  })
})

export default router