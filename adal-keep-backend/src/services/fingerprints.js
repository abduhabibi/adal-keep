import os from 'os'
import crypto from 'crypto'
import { execSync } from 'child_process'

export function generateFingerprint() {
  const parts = []

  // 1. CPU Model (Cross-platform)
  const cpu = os.cpus()[0]?.model || 'unknown-cpu'
  parts.push(cpu.trim())

  // 2. Hostname (Cross-platform)
  parts.push(os.hostname().trim())

  // 3. First real MAC address (Cross-platform)
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        parts.push(iface.mac.toUpperCase())
        break
      }
    }
  }

  // 4. OS-specific Hardware Serial
  const platform = os.platform()
  try {
    if (platform === 'win32') {
      // Windows: Get BIOS serial number
      const biosSerial = execSync('wmic bios get serialnumber', { encoding: 'utf8' })
        .split('\n')[1]?.trim()
      
      if (biosSerial && biosSerial !== 'To be filled by O.E.M.' && biosSerial !== 'Default string') {
        parts.push(biosSerial)
      } else {
        // Fallback to Disk Serial on Windows
        const diskSerial = execSync('wmic diskdrive get serialnumber', { encoding: 'utf8' })
          .split('\n')[1]?.trim()
        if (diskSerial) parts.push(diskSerial)
      }
    } else {
      // Linux: Get systemd machine-id (most reliable on modern Linux)
      const machineId = execSync('cat /etc/machine-id', { encoding: 'utf8' }).trim()
      if (machineId) {
        parts.push(machineId)
        parts.push(execSync('cat /var/lib/dbus/machine-id', { encoding: 'utf8' }).trim()) // Fallback dbus id
      } else {
        // Fallback to disk serial on Linux
        const disk = execSync(
          'lsblk -o SERIAL -n /dev/sda 2>/dev/null || lsblk -o SERIAL -n /dev/nvme0n1 2>/dev/null || echo ""',
          { encoding: 'utf8' }
        ).trim()
        if (disk) parts.push(disk)
      }
    }
  } catch {
    // Silently ignore if command fails. We already have CPU, Hostname, and MAC, which is enough.
  }

  // Filter out any empty strings, join, and hash
  const raw = parts.filter(Boolean).join('||')
  return crypto.createHash('sha256').update(raw).digest('hex')
}