/**
 * "Remote support by Adal" (Settings): the switch for the support access that
 * the installer set up (adal-installer/files/support-setup.ps1).
 *   <install>\support-off.flag present  => off (default ON: no file)
 * Windows: a SYSTEM scheduled task ("Adal Keep Support (Main|Companion)")
 * applies it — switching off does what "Adal Disconnect" does (sshd stopped,
 * key and SSH rule removed); switching on puts everything back — and writes
 * every change to ProgramData\ssh\logs\adal-support.log. AdalKeep.exe repairs
 * the support access at every start unless the flag is there.
 * Updates never touch the key (it lives in ProgramData, outside the install).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'

/** The install folder: <install>\backend\src\services -> <install>; a Companion's server in waiting sits in <install>\server\backend. */
export function installRoot(dir = path.dirname(fileURLToPath(import.meta.url))) {
  let root = path.resolve(dir, '..', '..', '..')
  if (path.basename(root).toLowerCase() === 'server') root = path.dirname(root)
  return root
}

export const flagPath = (root = installRoot()) => path.join(root, 'support-off.flag')
export const supportRole = (root = installRoot()) =>
  (fs.existsSync(path.join(root, 'adal-companion.exe')) && !fs.existsSync(path.join(root, 'runtime', 'node.exe')) ? 'Companion' : 'Main')

export function supportOn(root = installRoot()) { return !fs.existsSync(flagPath(root)) }

export function setSupport(on, root = installRoot(), who = os.userInfo().username) {
  const f = flagPath(root)
  if (on) { try { fs.unlinkSync(f) } catch { /* already on */ } }
  else fs.writeFileSync(f, `off by ${who} at ${new Date().toISOString()}\n`)
  if (process.platform === 'win32') {
    // Apply now (the task is SYSTEM; any signed-in user may start it). Without the task the launcher does it at the next start.
    execFile('schtasks.exe', ['/Run', '/TN', `Adal Keep Support (${supportRole(root)})`], { windowsHide: true }, () => {})
  }
  return supportOn(root)
}
