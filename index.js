/**
 * Window hotkey: one global shortcut that minimizes the DeepSeek Harness window
 * when it is in the way and brings it back when it is not.
 *
 * The shortcut has to be registered by a process that stays alive and owns a
 * message loop, and this host process is the wrong shape for that: it is
 * Electron under ELECTRON_RUN_AS_NODE, so it has no BrowserWindow to minimize
 * even if RegisterHotKey worked from here. The implementation is therefore a
 * small detached PowerShell helper (see hotkey.js) whose lifetime is tied to
 * this process id by a watcher thread.
 *
 * Failure policy: a hotkey that cannot be registered (another program owns the
 * combination) is reported once and then left alone. Nothing here throws into
 * the host — a window shortcut is a convenience, never a reason to break the
 * profile.
 */
import { logSize, parseHotkey, readNewLines, record, startHelper } from './hotkey.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const inject = ['timer']

const DEFAULTS = {
  enabled: true,
  hotkey: 'ctrl+alt+q',
  /** A top-level window titles ending with this string is the app window. */
  windowTitle: 'DeepSeek Harness',
  /** How long the helper keeps retrying when the combination is already taken. */
  registerTimeoutMs: 10_000,
  logFile: join(tmpdir(), 'dsh-hotkey', 'hotkey.log'),
  powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
}

/**
 * Wait this long after spawning before believing the helper's own log: the
 * helper compiles a C# type before it registers, and the first compile on a cold
 * machine takes a couple of seconds.
 */
const STATUS_DELAY_MS = 5_000

export function apply(ctx, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }

  if (!cfg.enabled) {
    ctx.logger?.info?.('hotkey: disabled by config (hotkey.enabled = false)')
    return
  }
  if (process.platform !== 'win32') {
    ctx.logger?.warn?.(`hotkey: window hotkey needs Windows, this host is ${process.platform}; not starting`)
    return
  }

  let combo
  try {
    combo = parseHotkey(cfg.hotkey)
  } catch (error) {
    ctx.logger?.warn?.(`hotkey: ignoring invalid hotkey: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const startedOffset = logSize(cfg)

  ctx.effect(() => {
    record(cfg, `spawn hotkey=${combo.label} parent=${process.pid}`)
    const helper = startHelper(cfg, combo, { parentPid: process.pid, registerTimeoutMs: cfg.registerTimeoutMs, logger: ctx.logger })
    ctx.logger?.info?.(`hotkey: ${combo.label} toggles the window (helper pid ${helper.pid ?? '?'})`)

    // The registration happens inside the helper, so "did it work" is only
    // answerable by reading what the helper wrote. Reporting it beats leaving the
    // user with a shortcut that silently does nothing.
    const statusTimer = ctx.timer.timeout(() => {
      const { lines } = readNewLines(cfg, startedOffset)
      const failed = lines.find((line) => line.includes('register failed'))
      const registered = lines.find((line) => line.includes('registered mods='))
      const target = lines.find((line) => line.includes('target hwnd='))
      if (registered === undefined) {
        if (failed !== undefined) {
          ctx.logger?.warn?.(`hotkey: ${combo.label} is taken by another program; pick another combination (details in ${cfg.logFile})`)
        }
        return
      }
      const where = target === undefined ? '' : `, window ${target.replace(/^.*target hwnd=/, 'hwnd=').replace(/ title=.*$/, '')}`
      ctx.logger?.info?.(`hotkey: ${combo.label} listening${where}`)
    }, STATUS_DELAY_MS)

    return () => {
      try {
        statusTimer()
      } catch {
        /* the timer already fired */
      }
      record(cfg, `stop hotkey=${combo.label}`)
      helper.stop()
    }
  })
}
