/**
 * Host half of @local/dsh-window-hotkey.
 *
 * The host process is Electron started with ELECTRON_RUN_AS_NODE: it owns no
 * BrowserWindow and no host service exposes a window handle, so the real
 * Ctrl+Alt+Q toggle is driven from a small PowerShell helper (hotkey.js) that
 * registers a Win32 global hotkey and minimizes/restores the app window even
 * when the app is not focused.
 *
 * Rebinding: the shortcut panel edits `keybindings.json` through Electron's own
 * single-writer adapter, which only moves the in-app binding. The OS-global
 * registration lives in the helper process, so the Client half forwards every
 * accepted binding here over a webServer route and this side restarts the
 * helper. That makes the panel the single source of truth: what it shows is
 * what the machine actually registers.
 *
 * The chosen combination is also cached in hotkey-state.json next to this file,
 * so a host restart re-arms the same key instead of falling back to the patch
 * config.
 *
 * Failure policy: a broken hotkey must never take the desktop down again.
 * Every step below is guarded and reports to the helper log instead of
 * throwing out of apply().
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOG, logSize, parseHotkey, readNewLines, record, startHelper } from './hotkey.js'

const DEFAULT_HOTKEY = 'ctrl+alt+q'
const DEFAULT_WINDOW_TITLE = 'DeepSeek Harness'
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'hotkey-state.json')
const ROUTE = '/dsh-window-hotkey'
/** How long a freshly spawned helper gets to win RegisterHotKey. */
const REGISTER_TIMEOUT_MS = 4_000
/** Command id shared with the Client half and the shortcut panel. */
const COMMAND_ID = 'window-toggle.toggle'
/** How often the panel's file is re-read (ms). */
const WATCH_INTERVAL_MS = 1_000

function text(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function shortError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cached combination, or undefined when nothing has been chosen yet.
 *
 * undefined and null mean different things: undefined is "no opinion, use the
 * patch config", null is "the user deliberately unbound the command".
 */
function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (raw === null || typeof raw !== 'object' || !Object.hasOwn(raw, 'hotkey')) return undefined
    return typeof raw.hotkey === 'string' && raw.hotkey.trim() ? raw.hotkey.trim() : null
  } catch {
    return undefined
  }
}

function writeState(cfg, hotkey) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify({ hotkey }, null, 2)}\n`, 'utf8')
  } catch (error) {
    // A read-only install still works for this session; only the cache is lost.
    record(cfg, `could not cache the chosen hotkey: ${shortError(error)}`)
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

// ---- the shortcut panel's file -------------------------------------------
//
// Electron's shortcut editor owns keybindings.json. Watching it here means a
// rebind takes effect even when the renderer never forwards it (an old client
// bundle, a hand edit, a change made while the page was loading). The route is
// still the fast path; this is the safety net.

const PANEL_CODES = {
  Slash: '/',
  Comma: ',',
  Period: '.',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Enter: 'enter',
  Escape: 'escape',
  Space: 'space',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}
const PANEL_MODIFIERS = { control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'win' }

function panelKeyToken(code) {
  if (typeof code !== 'string') return null
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter !== null) return letter[1].toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit !== null) return digit[1]
  const fkey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (fkey !== null) return 'f' + fkey[1]
  return Object.hasOwn(PANEL_CODES, code) ? PANEL_CODES[code] : null
}

/** Panel binding -> "ctrl+alt+q", or null when it is unbound/unexpressible. */
function bindingToHotkey(binding) {
  if (binding === null) return null
  if (typeof binding !== 'object') return undefined
  // A two-key chord cannot be a RegisterHotKey combination.
  if (binding.secondCode !== undefined) return undefined
  const key = panelKeyToken(binding.code)
  if (key === null) return undefined
  const mods = (binding.modifiers || []).map((m) => PANEL_MODIFIERS[m]).filter(Boolean)
  if (mods.length === 0) return undefined
  return [...mods, key].join('+')
}

/** The panel file for this machine, or null when it does not exist yet. */
function panelFile() {
  const appData = process.env.APPDATA
  if (typeof appData !== 'string' || appData === '') return null
  const candidates = [
    join(appData, '@deepseek-ai', 'dsh-desktop', 'keybindings.json'),
    join(appData, 'DeepSeek Harness', 'keybindings.json'),
    join(appData, 'dsh-desktop', 'keybindings.json'),
  ]
  for (const candidate of candidates) {
    try {
      readFileSync(candidate)
      return candidate
    } catch {
      // try the next candidate
    }
  }
  // Not created yet: return the canonical location so a later edit is seen.
  return candidates[0]
}

/** Read the panel's choice for this command; undefined when it has no opinion. */
function readPanelChoice(file, platform) {
  let document
  try {
    document = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const profile = document?.profiles?.[`desktop:${platform}`]
  if (profile === null || typeof profile !== 'object') return undefined
  if (!Object.hasOwn(profile, COMMAND_ID)) return undefined
  return bindingToHotkey(profile[COMMAND_ID])
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on?.('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on?.('error', reject)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const windowTitle = text(config.windowTitle, DEFAULT_WINDOW_TITLE)
  // hotkey.js spawns cfg.powershell verbatim; it has no default of its own.
  const cfg = { powershell: 'powershell.exe', windowTitle, logFile: DEFAULT_LOG }

  const stored = readState()
  let current = null // { combo, handle, text }
  let disposed = false

  function stopCurrent() {
    const handle = current?.handle
    current = null
    try {
      handle?.stop?.()
    } catch (error) {
      record(cfg, `helper stop failed: ${shortError(error)}`)
    }
  }

  /** Spawn one helper, returning the combo plus the log offset it started at. */
  function startCombo(comboText) {
    const combo = parseHotkey(comboText) // throws on an unusable combination
    const offset = logSize(cfg)
    stopCurrent()
    const handle = startHelper(cfg, combo, {
      parentPid: process.pid,
      registerTimeoutMs: REGISTER_TIMEOUT_MS,
    })
    current = { combo, handle, text: comboText }
    record(
      cfg,
      `helper started pid=${handle?.pid} hotkey=${combo.label} titleSuffix=${JSON.stringify(windowTitle)}`,
    )
    return { combo, offset }
  }

  /**
   * Wait until the new helper either owns the combination or gives up.
   *
   * The spawn itself always succeeds, so "did it work" is only visible in the
   * log. Returning false here is what lets a failed rebind roll back instead of
   * silently leaving the user with no working hotkey.
   */
  async function confirmRegistration(offset, timeoutMs = REGISTER_TIMEOUT_MS + 1_500) {
    let cursor = offset
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const read = readNewLines(cfg, cursor)
      cursor = read.offset
      for (const line of read.lines) {
        if (line.includes('registered mods=')) return true
        if (line.includes('register failed after')) return false
      }
      if (disposed) return false
      await sleep(120)
    }
    return false
  }

  /** Apply a combination from the shortcut panel, rolling back if it cannot be owned. */
  async function rebind(comboText) {
    const previous = current?.text ?? null
    let started
    try {
      started = startCombo(comboText)
    } catch (error) {
      return { ok: false, error: shortError(error) }
    }
    if (await confirmRegistration(started.offset)) {
      writeState(cfg, comboText)
      return { ok: true, hotkey: comboText, label: started.combo.label }
    }
    // Roll back so a conflicting pick never costs the user their working key.
    if (previous !== null) {
      try {
        startCombo(previous)
      } catch (error) {
        record(cfg, `could not restore the previous hotkey: ${shortError(error)}`)
      }
    }
    return {
      ok: false,
      error: `"${comboText}" could not be registered (another program may already own it)`,
    }
  }

  /** Drop the global registration entirely (the panel shows an unbound row). */
  function unbind() {
    stopCurrent()
    writeState(cfg, null)
    record(cfg, 'global hotkey released')
    return { ok: true, hotkey: null, label: null }
  }

  // stored === undefined means the panel has never spoken: use the patch
  // config. stored === null means the user unbound it on purpose, so honour
  // that across restarts instead of resurrecting the default.
  const initial = stored === undefined ? text(config.hotkey, DEFAULT_HOTKEY) : stored

  if (initial !== null) {
    try {
      startCombo(initial)
    } catch (error) {
      record(cfg, `config hotkey ${JSON.stringify(initial)} is not usable: ${shortError(error)}`)
      if (stored !== undefined) {
        // The cached choice went stale (a hand-edited file, say). Fall back to
        // the patch config rather than leaving the user with nothing.
        try {
          startCombo(text(config.hotkey, DEFAULT_HOTKEY))
        } catch (fallbackError) {
          record(cfg, `fallback hotkey is not usable either: ${shortError(fallbackError)}`)
        }
      }
    }
  } else {
    record(cfg, 'no global hotkey bound (the shortcut panel can assign one)')
  }

  // Safety net: follow the shortcut panel's file directly.
  //
  // The Client half forwards an accepted binding over the route, which is the
  // fast path. This watcher covers the cases where that never arrives — an old
  // client bundle still in the module graph, a hand edit, or a change made
  // while the page was loading. Without it the panel would happily show a new
  // key while the machine kept registering the old one.
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  // config.panelFile lets a test point the watcher at a fixture instead of the
  // real profile file.
  const panel = text(config.panelFile, '') || panelFile()

  ctx.effect(() => {
    if (panel === null) return () => {}
    let lastSeen = current?.text ?? null
    let busy = false
    let timer = null

    async function poll() {
      if (busy || disposed) return
      const choice = readPanelChoice(panel, platform)
      // undefined = the panel has no opinion yet; undefined also covers an
      // unreadable file, which must not disturb a working registration.
      if (choice === undefined) return
      if (choice === lastSeen) return
      busy = true
      try {
        if (choice === null) {
          unbind()
          lastSeen = null
          return
        }
        const result = await rebind(choice)
        if (result.ok) {
          lastSeen = choice
        } else {
          // The machine refused it. Keep the working key and say so; the panel
          // still shows the refused choice, so the log is the record.
          record(cfg, `panel choice ${JSON.stringify(choice)} was not applied: ${result.error}`)
          lastSeen = current?.text ?? null
        }
      } catch (error) {
        record(cfg, `panel watcher failed: ${shortError(error)}`)
      } finally {
        busy = false
      }
    }

    timer = setInterval(() => {
      poll().catch(() => undefined)
    }, WATCH_INTERVAL_MS)
    // Do not hold the host process open on this timer.
    timer.unref?.()

    return () => {
      if (timer !== null) clearInterval(timer)
    }
  }, 'window-hotkey: shortcut panel watcher')

  // Cordis has no `dispose` event — the cleanup hook is the function returned
  // from ctx.effect(). Registering a disposer here means unloading the plugin
  // (or stopping the host) kills the helper instead of leaving a process that
  // still owns the global hotkey.
  ctx.effect(() => {
    return () => {
      disposed = true
      stopCurrent()
    }
  }, 'window-hotkey: global hotkey helper')

  ctx.inject(['webServer'], (sctx) => {
    try {
      sctx.effect(
        () =>
          sctx.webServer.register(
            {
              kind: 'prefix',
              // No trailing slash: the host matches `pathname === prefix ||
              // pathname.startsWith(prefix + '/')`.
              path: ROUTE,
              handler: async (req, res) => {
                const url = new URL(req.url ?? '/', 'http://dsh.local')
                const action = url.pathname.split('/').filter(Boolean)[1] ?? ''

                if (action === 'state' && req.method === 'GET') {
                  return json(res, 200, {
                    ok: true,
                    hotkey: current?.text ?? null,
                    label: current?.combo?.label ?? null,
                    log: DEFAULT_LOG,
                  })
                }

                if (action === 'bind' && req.method === 'POST') {
                  let body
                  try {
                    body = JSON.parse((await readBody(req)) || '{}')
                  } catch (error) {
                    return json(res, 400, { ok: false, error: `invalid request body: ${shortError(error)}` })
                  }
                  // null is a deliberate unbind, not a missing value.
                  if (body?.hotkey === null) return json(res, 200, unbind())
                  if (typeof body?.hotkey !== 'string') {
                    return json(res, 400, { ok: false, error: 'hotkey must be a string or null' })
                  }
                  try {
                    const result = await rebind(body.hotkey)
                    return json(res, result.ok ? 200 : 409, result)
                  } catch (error) {
                    record(cfg, `rebind failed unexpectedly: ${shortError(error)}`)
                    return json(res, 500, { ok: false, error: shortError(error) })
                  }
                }

                return json(res, 404, { ok: false, error: 'unknown window-hotkey route' })
              },
            },
            'window-hotkey: rebind route',
          ),
        'window-hotkey: rebind route',
      )
    } catch (error) {
      ctx.logger?.warn?.(`window-hotkey: could not register its route: ${shortError(error)}`)
    }
  })
}
