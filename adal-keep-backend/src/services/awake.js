/**
 * awake.js — the PC does not go to sleep while long work runs (a move from
 * another system takes hours on a slow line, and sleep cuts it). Windows is
 * told the way video players tell it; the screen may still turn off. As soon as
 * nothing holds it, the PC may sleep again. Elsewhere this does nothing.
 */
import { spawn } from 'child_process'

let helper = null
const holders = new Set()

const PS = `Add-Type -Namespace Adal -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[Adal.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null
while ($true) { Start-Sleep -Seconds 30; [Adal.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null }`

/** Holds the PC awake until the returned function is called. */
export function keepAwake(why) {
  const token = Symbol(why)
  holders.add(token)
  if (process.platform === 'win32' && !helper) {
    helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, stdio: 'ignore' })
    helper.on('exit', () => { helper = null })
    console.log(`[awake] the PC stays awake: ${why}`)
  }
  return () => {
    if (!holders.delete(token) || holders.size) return
    helper?.kill()
    helper = null
    console.log('[awake] the PC may sleep again')
  }
}

process.on('exit', () => helper?.kill())
