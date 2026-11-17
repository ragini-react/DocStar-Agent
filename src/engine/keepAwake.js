// On a Mac, the agent keeps the machine awake while the automation runs (macOS `caffeinate`, tied to this process),
// and lets it sleep again when paused or stopped. Elsewhere (a cloud worker) it does nothing.
import { spawn } from 'node:child_process'

export function createKeepAwake({ activity, platform = process.platform }) {
  let child = null
  return {
    set(running) {
      if (platform !== 'darwin') return
      if (running && !child) {
        // -i: no idle sleep, -s: no system sleep on AC power, -w: ends with this process.
        child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' })
        child.on('error', e => { activity.warn('keep_awake_failed', `Could not keep the Mac awake: ${e.message}`); child = null })
        child.on('exit', () => { child = null })
        activity.info('keep_awake', 'Keeping the Mac awake while the automation runs')
      } else if (!running && child) {
        child.kill()
        child = null
        activity.info('keep_awake', 'The Mac may sleep again (automation not running)')
      }
    },
    stop() { child?.kill(); child = null }
  }
}
