/**
 * Host half of @local/dsh-window-hotkey.
 *
 * The host process is Electron started with ELECTRON_RUN_AS_NODE: it owns no
 * BrowserWindow and no host service exposes a window handle, so the real window
 * toggle is driven from a small PowerShell helper (hotkey.js) that registers a
 * Win32 global hotkey and minimizes/restores the app window even when the app
 * is not focused.
 *
 * Rebinding: the shortcut panel edits `keybindings.json` through Electron's own
 * single-writer adapter. That file is THE source of truth for what the row
 * displays. This host reads that same file (once a second, plus a fast-path POST
 * from an older client build) and re-arms the helper to match. There is only
 * ONE controller: every path funnels through `rebind`, which coalesces bursts,
 * and nothing here ever writes back to the panel. That is what makes the row
 * behave exactly like every other shortcut.
 *
 * The chosen combination is also cached in hotkey-state.json next to this file,
 * so a host restart re-arms the same key before the panel file is consulted.
 *
 * Failure policy: a broken hotkey must never take the desktop down again.
 * Every step below is guarded and reports to the helper log instead of throwing
 * out of apply().
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOG, logSize, parseHotkey, readNewLines, record, startHelper } from './hotkey.js'

const DEFAULT_HOTKEY = 'ctrl+alt+q'
/**
 * What the panel shows when our command has no override: it comes from the
 * `defaults['desktop:windows']` declared in client.js, NOT from config.hotkey.
 * Keep the two in sync. A "reset" in the panel removes the override entirely,
 * so the host must re-arm exactly this rather than keeping the previous key.
 */
const PANEL_DEFAULT_HOTKEY = DEFAULT_HOTKEY
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
 * undefined = "no opinion, use the patch config"; null = "deliberately unbound".
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
    record(cfg, `could not cache the chosen hotkey: ${shortError(error)}`)
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

// ---- the shortcut panel's file -------------------------------------------

const PANEL_CODES = {
  Slash: '/', Comma: ',', Period: '.', Backslash: '\\', Backquote: '`',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Enter: 'enter', Escape: 'escape',
  Space: 'space', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
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

/** Panel binding -> "ctrl+alt+q"; null = unbound; undefined = unexpressible. */
function bindingToHotkey(binding) {
  if (binding === null) return null
  if (typeof binding !== 'object') return undefined
  if (binding.secondCode !== undefined) return undefined
  const key = panelKeyToken(binding.code)
  if (key === null) return undefined
  const mods = (binding.modifiers || []).map((m) => PANEL_MODIFIERS[m]).filter(Boolean)
  if (mods.length === 0) return undefined
  return [...mods, key].join('+')
}

function panelFile() {
  const appData = process.env.APPDATA
  if (typeof appData !== 'string' || appData === '') return null
  const candidates = [
    join(appData, '@deepseek-ai', 'dsh-desktop', 'keybindings.json'),
    join(appData, 'DeepSeek Harness', 'keybindings.json'),
    join(appData, 'dsh-desktop', 'keybindings.json'),
  ]
  for (const candidate of candidates) {
    try { readFileSync(candidate); return candidate } catch { /* next */ }
  }
  return candidates[0]
}

/**
 * Read the panel's choice for this command.
 *   string  = an explicit override from keybindings.json
 *   null    = explicitly unbound
 *   DEFAULT = no override (reset / never edited) -> the row shows its default
 *   undefined = unreadable file -> keep whatever the machine has now
 */
function readPanelChoice(file, platform) {
  let document
  try { document = JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
  const profile = document?.profiles?.[`desktop:${platform}`]
  if (profile === null || typeof profile !== 'object') return PANEL_DEFAULT_HOTKEY
  if (!Object.hasOwn(profile, COMMAND_ID)) return PANEL_DEFAULT_HOTKEY
  return bindingToHotkey(profile[COMMAND_ID])
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on?.('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy?.(); return }
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
    try { handle?.stop?.() } catch (error) { record(cfg, `helper stop failed: ${shortError(error)}`) }
  }

  function startCombo(comboText) {
    const combo = parseHotkey(comboText)
    const offset = logSize(cfg)
    stopCurrent()
    const handle = startHelper(cfg, combo, {
      parentPid: process.pid,
      registerTimeoutMs: REGISTER_TIMEOUT_MS,
    })
    current = { combo, handle, text: comboText }
    record(cfg, `helper started pid=${handle?.pid} hotkey=${combo.label} titleSuffix=${JSON.stringify(windowTitle)}`)
    return { combo, offset }
  }

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

  // ONE controller for the global hotkey. A burst of notifications (POST fast
  // path + file poll + an older client forwarding) coalesces into a single
  // re-arm: `desired` is set immediately and rebind() always acts on the latest
  // value, so no two helpers race to own RegisterHotKey.
  // undefined = "no request yet": applyDesired() must NOT act on it, otherwise
  // it would unbind the key armed at startup. null is a real request (unbind).
  let desired = undefined // string, null (unbound), or undefined (no request)
  let applying = false

  async function applyDesired() {
    if (applying || disposed) return
    applying = true
    try {
      while (!disposed) {
        const target = desired
        if (target === undefined || target === (current?.text ?? null)) return
        let result
        try { result = await rebind(target) } catch (error) {
          record(cfg, `rebind threw: ${shortError(error)}`)
        }
        // A failure is logged by rebind(); don't retry the same value forever.
        if (result && !result.ok) {
          record(cfg, `rebind to ${JSON.stringify(target)} failed: ${result.error}`)
        }
        if (desired === target) return
        // `desired` changed while we were registering: loop and follow the new
        // value instead of resurrecting the stale one.
      }
    } finally {
      applying = false
    }
  }

  function requestHotkey(value) {
    desired = value
    applyDesired().catch(() => undefined)
  }

  /** Apply one combination, rolling back to the previous key if it cannot be owned. */
  async function rebind(comboText) {
    if (comboText === null) return unbind()
    const previous = current?.text ?? null
    let started
    try { started = startCombo(comboText) } catch (error) {
      return { ok: false, error: shortError(error) }
    }
    if (await confirmRegistration(started.offset)) {
      writeState(cfg, comboText)
      return { ok: true, hotkey: comboText, label: started.combo.label }
    }
    if (previous !== null) {
      try { startCombo(previous) } catch (error) {
        record(cfg, `could not restore the previous hotkey: ${shortError(error)}`)
      }
    }
    return { ok: false, error: `"${comboText}" could not be registered (another program may already own it)` }
  }

  function unbind() {
    stopCurrent()
    writeState(cfg, null)
    record(cfg, 'global hotkey released')
    return { ok: true, hotkey: null, label: null }
  }

  // --- initial arm -------------------------------------------------------
  // Prefer the panel file (the user's actual choice) over the cache; the cache
  // is only a fallback so the key works before the renderer has written yet.
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  const panel = text(config.panelFile, '') || panelFile()
  const panelChoice = panel === null ? undefined : readPanelChoice(panel, platform)
  const initial = panelChoice !== undefined
    ? panelChoice
    : (stored === undefined ? text(config.hotkey, DEFAULT_HOTKEY) : stored)

  if (initial !== null) {
    try { startCombo(initial) } catch (error) {
      record(cfg, `initial hotkey ${JSON.stringify(initial)} is not usable: ${shortError(error)}`)
      try { startCombo(text(config.hotkey, DEFAULT_HOTKEY)) } catch (fallbackError) {
        record(cfg, `fallback hotkey is not usable either: ${shortError(fallbackError)}`)
      }
    }
  } else {
    record(cfg, 'no global hotkey bound (the shortcut panel can assign one)')
  }

  // Remember where we started so the poll does not re-arm needlessly.
  let lastPanelChoice = panelChoice

  // --- single source of truth: watch the panel's file --------------------
  ctx.effect(() => {
    if (panel === null) return () => {}
    let timer = null
    const poll = () => {
      const choice = readPanelChoice(panel, platform)
      if (choice === undefined || choice === lastPanelChoice) return
      lastPanelChoice = choice
      requestHotkey(choice)
    }
    timer = setInterval(poll, WATCH_INTERVAL_MS)
    timer.unref?.()
    return () => { if (timer !== null) clearInterval(timer) }
  }, 'window-hotkey: shortcut panel watcher')

  // Cleanup: killing the helper on unload avoids a process that still owns the
  // global hotkey after the plugin is gone.
  ctx.effect(() => () => { disposed = true; stopCurrent() }, 'window-hotkey: global hotkey helper')

  // Compatibility fast path: an older client build may still POST here. It is
  // funneled through the very same coalescing controller, so it can never fight
  // the file-watcher. Nothing is ever written back to the panel.
  ctx.inject(['webServer'], (sctx) => {
    try {
      sctx.effect(
        () =>
          sctx.webServer.register(
            {
              kind: 'prefix',
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
                    // The panel is the authority; this only reports the machine.
                    panelChoice: lastPanelChoice ?? null,
                  })
                }

                if (action === 'bind' && req.method === 'POST') {
                  let body
                  try { body = JSON.parse((await readBody(req)) || '{}') } catch (error) {
                    return json(res, 400, { ok: false, error: `invalid request body: ${shortError(error)}` })
                  }
                  if (body?.hotkey === null) {
                    requestHotkey(null)
                    return json(res, 200, { ok: true, hotkey: null, label: null })
                  }
                  if (typeof body?.hotkey !== 'string') {
                    return json(res, 400, { ok: false, error: 'hotkey must be a string or null' })
                  }
                  requestHotkey(body.hotkey)
                  return json(res, 200, { ok: true, hotkey: body.hotkey })
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
