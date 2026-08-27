import os from 'os'
import crypto from 'crypto'
import { execSync } from 'child_process'
import fs from 'fs'

export function generateFingerprint() {
  const parts = []

  // 1. CPU model
  const cpu = os.cpus()[0]?.model || 'unknown-cpu'
  parts.push(cpu.trim())

  // 2. Hostname
  parts.push(os.hostname().trim())

  // 3. First real MAC
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        parts.push(iface.mac.toUpperCase())
        break
      }
    }
  }

  // 4. Platform-specific stable ID
  const platform = os.platform()
  try {
    if (platform === 'win32') {
      // Windows BIOS serial
      try {
        const bios = execSync('wmic bios get serialnumber', { encoding: 'utf8' })
          .split('\n')[1]?.trim()
        if (bios && !['To be filled by O.E.M.', 'Default string', 'None'].includes(bios)) {
          parts.push(bios)
        }
      } catch {}
    } else if (platform === 'darwin') {
      // macOS hardware UUID
      try {
        const uuid = execSync('system_profiler SPHardwareDataType | awk \'/Hardware UUID/ {print $3}\'', { encoding: 'utf8' }).trim()
        if (uuid) parts.push(uuid)
      } catch {}
    } else {
      // Linux / Zorin / Ubuntu / Oracle
      // Prefer /etc/machine-id (very stable)
      if (fs.existsSync('/etc/machine-id')) {
        parts.push(fs.readFileSync('/etc/machine-id', 'utf8').trim())
      } else if (fs.existsSync('/var/lib/dbus/machine-id')) {
        parts.push(fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim())
      }

      // Also try a disk serial as extra stability
      try {
        const disk = execSync(
          'lsblk -d -o SERIAL -n 2>/dev/null | head -1 || echo ""',
          { encoding: 'utf8' }
        ).trim()
        if (disk) parts.push(disk)
      } catch {}
    }
  } catch {
    // ignore – we already have CPU + hostname + MAC
  }

  const raw = parts.filter(Boolean).join('||')
  return crypto.createHash('sha256').update(raw).digest('hex')
}
