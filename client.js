// Client half of @local/dsh-window-hotkey.
//
// This registers ONE ordinary command in 通用设置 → 通用快捷键, exactly the way
// every core command does. The panel is Electron's own shortcut editor: it owns
// keybindings.json, renders the row and saves the binding. We deliberately do
// NOT subscribe to the catalog, do NOT forward the binding and do NOT call
// edit() from here.
//
// The old build did all three. Client POST /bind and the host file-watcher both
// reacted to a single panel edit, so two helpers were spawned for one change;
// when one lost RegisterHotKey the client's revertTo() called edit() and pulled
// the row back to a stale key. The result was exactly the two complaints: the
// panel text looked wrong and the command did not behave like the others.
//
// Now there is one writer (the panel) and one reader (the host watcher). The
// OS-global Ctrl+Alt+Q is a Win32 hotkey owned by a PowerShell helper in the
// host process; the host re-arms it from whatever the panel saved. The in-app
// resolve() stays a no-op on purpose: while DSH is focused the OS already
// delivers the key to the helper, so running an in-app action too would toggle
// the window twice.
window.__ModuleLoader__.load({
  id: '@local/dsh-window-hotkey',
  factory(require) {
    return {
      inject: ['shortcuts', 'locale'],
      apply(ctx) {
        const COMMAND_ID = 'window-toggle.toggle'

        // The panel calls label() again on every locale change
        // (ShortcutsService does ctx.locale.subscribe(() => refreshLabels())).
        // Read the app's ACTIVE language through its own locale service: the
        // old build guessed from navigator.language, which is "en-US" on many
        // Chinese desktops and made this one row show an English label among the
        // Chinese rows. `<html lang>` is a backup (locale keeps it in sync too).
        const label = () => {
          let active
          try { active = ctx.locale.getSnapshot().active } catch { /* not ready */ }
          if (!active && typeof document !== 'undefined') {
            active = document.documentElement && document.documentElement.lang
          }
          return String(active || 'en').toLowerCase().startsWith('zh') ? '最小化/还原窗口' : 'Minimize / Restore window'
        }

        // The order of these two effects is deliberate: by the time the command
        // is registered (and the panel first renders it) the locale snapshot is
        // already available, and a later language switch re-invokes label().
        ctx.effect(
          () =>
            ctx.shortcuts.register({
              id: COMMAND_ID,
              label,
              aliases: ['window toggle', 'toggle window', '窗口快捷键', '热键', '开关窗口'],
              defaults: {
                'desktop:windows': { code: 'KeyQ', modifiers: ['primary', 'alt'] },
              },
              regions: ['page', 'editable', 'terminal'],
              modals: ['settings', 'shortcuts'],
              resolve: () => ({ status: 'handled', run: () => {} }),
            }),
          'window-toggle: register shortcuts command',
        )
      },
    }
  },
})
