// Client half of @local/dsh-window-hotkey.
//
// This registers the command row in 通用设置 → 通用快捷键 AND keeps the OS-global
// registration in sync with it. The panel itself is Electron's own shortcut
// editor: it writes keybindings.json and moves the in-app binding. The real
// Ctrl+Alt+Q is a Win32 global hotkey owned by a PowerShell helper in the host
// process, which the panel knows nothing about — so every accepted binding is
// forwarded to the host route, which restarts the helper.
//
// Without that forward the panel would be a lie: it would show a new key while
// the machine kept registering the old one.
//
// The in-app resolve() stays a no-op on purpose. While DSH is focused the OS
// already delivers the key to the helper, and running an in-app action as well
// would toggle the window twice.
window.__ModuleLoader__.load({
  id: '@local/dsh-window-hotkey',
  factory(require) {
    return {
      inject: ['shortcuts'],
      apply(ctx) {
        const COMMAND_ID = 'window-toggle.toggle'
        const ROUTE = 'dsh-window-hotkey'

        const isZh =
          typeof navigator !== 'undefined' &&
          (navigator.language || 'zh-CN').toLowerCase().startsWith('zh')
        const label = () => (isZh ? '切换窗口' : 'Toggle window')

        // Physical code -> the spelling hotkey.js parses. Every code the
        // shortcut protocol admits is covered; an unknown one returns null and
        // the binding is left alone rather than sent as something wrong.
        const CODES = {
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
        const MODIFIERS = { control: 'ctrl', alt: 'alt', shift: 'shift', meta: 'win' }

        function keyToken(code) {
          if (typeof code !== 'string') return null
          const letter = /^Key([A-Z])$/.exec(code)
          if (letter !== null) return letter[1].toLowerCase()
          const digit = /^Digit([0-9])$/.exec(code)
          if (digit !== null) return digit[1]
          const fkey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
          if (fkey !== null) return 'f' + fkey[1]
          return Object.hasOwn(CODES, code) ? CODES[code] : null
        }

        /** Catalog binding -> "ctrl+alt+q", or null when it cannot be expressed. */
        function toHotkey(binding) {
          if (binding === null || typeof binding !== 'object') return null
          // A two-key chord cannot be a RegisterHotKey combination.
          if (binding.secondCode !== undefined) return null
          const key = keyToken(binding.code)
          if (key === null) return null
          const mods = (binding.modifiers || []).map((m) => MODIFIERS[m]).filter(Boolean)
          if (mods.length === 0) return null
          return [...mods, key].join('+')
        }

        function routeUrl() {
          const base = typeof document !== 'undefined' ? document.baseURI : ''
          try {
            const url = new URL(base || 'http://dsh.internal/')
            url.search = ''
            url.hash = ''
            if (!url.pathname.endsWith('/')) url.pathname += '/'
            return new URL(ROUTE, url.href).href
          } catch {
            return null
          }
        }

        let route = null
        let sent = null // last combination the host accepted
        let reverting = false

        function post(path, body) {
          if (route === null) route = routeUrl()
          if (route === null) return Promise.resolve(null)
          return fetch(route + path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin',
          }).then(
            (response) => response.json().catch(() => null),
            () => null,
          )
        }

        /** Put the panel row back on the key the machine actually registers. */
        function revertTo(actual, fallbackBinding) {
          if (reverting) return
          reverting = true
          const binding =
            actual === null
              ? null
              : (function () {
                  const parts = String(actual).split('+')
                  const key = parts.pop()
                  const code = (function () {
                    if (/^[a-z]$/.test(key)) return 'Key' + key.toUpperCase()
                    if (/^[0-9]$/.test(key)) return 'Digit' + key
                    if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return 'F' + key.slice(1)
                    for (const [name, token] of Object.entries(CODES)) if (token === key) return name
                    return null
                  })()
                  if (code === null) return fallbackBinding
                  return {
                    code,
                    modifiers: parts.map((m) => (m === 'ctrl' ? 'control' : m === 'win' ? 'meta' : m)),
                  }
                })()
          const config = ctx.shortcuts.config.getSnapshot()
          Promise.resolve()
            .then(() => ctx.shortcuts.edit({ type: 'set', id: COMMAND_ID, binding }, config.revision))
            .catch(() => undefined)
            .then(() => {
              reverting = false
            })
        }

        /** Forward the panel's current choice to the process that owns the hotkey. */
        function sync(binding) {
          const hotkey = toHotkey(binding)
          // Unbound is a real state the panel can show; anything else that
          // failed to convert is a shape the helper cannot express, so leave
          // the working registration untouched.
          if (hotkey === null && binding !== null) return
          const signature = hotkey === null ? '(none)' : hotkey
          if (signature === sent) return
          const previous = sent
          sent = signature
          post('bind', { hotkey }).then((result) => {
            if (result !== null && result.ok === true) return
            // The host could not own it: restore the previous choice so the
            // panel never displays a key the machine is not registering.
            sent = previous
            if (result !== null && typeof result.hotkey === 'string') revertTo(result.hotkey, binding)
            else if (previous !== null) revertTo(previous === '(none)' ? null : previous, binding)
          })
        }

        ctx.effect(() => {
          const off = ctx.shortcuts.register({
            id: COMMAND_ID,
            label,
            aliases: ['window toggle', 'toggle window', '窗口快捷键', '热键', '开关窗口'],
            defaults: {
              'desktop:windows': { code: 'KeyQ', modifiers: ['primary', 'alt'] },
            },
            regions: ['page', 'editable', 'terminal'],
            modals: ['settings', 'shortcuts'],
            resolve: () => ({ status: 'handled', run: () => {} }),
          })

          // Seed `sent` from the host so the first catalog emission after a
          // reload does not look like a change and restart the helper.
          const stateRoute = (route === null ? (route = routeUrl()) : route)
          if (stateRoute !== null) {
            fetch(stateRoute + 'state', { credentials: 'same-origin' })
              .then((response) => response.json())
              .then(
                (state) => {
                  if (sent === null) sent = typeof state?.hotkey === 'string' ? state.hotkey : '(none)'
                },
                () => undefined,
              )
          }

          const unsubscribe = ctx.shortcuts.catalog.subscribe(() => {
            const rows = ctx.shortcuts.catalog.getSnapshot()
            const row = rows.find((entry) => entry.id === COMMAND_ID)
            if (row === undefined) return
            sync(row.binding)
          })

          return () => {
            unsubscribe()
            off()
          }
        }, 'window-toggle: register shortcuts command')
      },
    }
  },
})
