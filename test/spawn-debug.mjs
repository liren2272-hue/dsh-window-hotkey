// Isolates the plugin's spawn call with inherited stdio, so a PowerShell failure
// that the plugin deliberately hides (stdio: 'ignore') becomes visible.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildHelperScript, parseHotkey } from '../hotkey.js'

const here = dirname(fileURLToPath(import.meta.url))
const logFile = join(here, 'debug-hotkey.log')
const cfg = { logFile, windowTitle: 'DeepSeek Harness' }
const scriptPath = join(here, 'debug-helper.ps1')

writeFileSync(scriptPath, buildHelperScript(cfg, parseHotkey('ctrl+alt+q'), { parentPid: 0, registerTimeoutMs: 3000 }), 'utf8')

const child = spawn(
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  { stdio: 'inherit', windowsHide: true },
)
console.log('spawned pid', child.pid)
child.on('exit', (code, signal) => console.log('child exit', code, signal))
child.on('error', (error) => console.log('child error', error.message))

setTimeout(() => {
  child.kill()
  let log = ''
  try {
    log = readFileSync(logFile, 'utf8')
  } catch (error) {
    log = `(no log: ${error.message})`
  }
  console.log('--- log ---\n' + log)
  process.exit(0)
}, 5000)
