/**
 * The Windows side of the window hotkey.
 *
 * There is no Electron API here: this plugin runs inside the host process,
 * which is Electron started with ELECTRON_RUN_AS_NODE and therefore owns no
 * BrowserWindow. Nothing in the host service catalog exposes a window handle
 * either, so the window has to be found and driven through Win32 directly.
 *
 * Two facts from probing this machine shape the implementation:
 *
 *   1. ShowWindow / SetWindowPos / ShowWindowAsync come back with
 *      ERROR_ACCESS_DENIED (5) for the app window when the caller sits at a
 *      different integrity level — the calls return false and do nothing.
 *      SendMessage(WM_SYSCOMMAND, SC_MINIMIZE | SC_RESTORE) works in exactly
 *      that situation, so the message path is primary and ShowWindow is only a
 *      fallback.
 *   2. Global hotkeys are delivered to the thread that registered them, which
 *      means the registration must live in a process that stays alive. The host
 *      may restart at any time, so this is a detached PowerShell process whose
 *      lifetime is tied to the host pid by a watcher thread rather than to any
 *      plugin object.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export const DEFAULT_LOG = join(tmpdir(), 'dsh-hotkey', 'hotkey.log')
const LOG_MAX_BYTES = 256 * 1024

/** RegisterHotKey modifier bits. */
const MOD_BITS = {
  ctrl: 0x0002,
  control: 0x0002,
  alt: 0x0001,
  shift: 0x0004,
  win: 0x0008,
  meta: 0x0008,
  super: 0x0008,
}

const MOD_LABEL = [
  [0x0002, 'Ctrl'],
  [0x0001, 'Alt'],
  [0x0004, 'Shift'],
  [0x0008, 'Win'],
]

/** Virtual-key codes that are not a single letter, digit, or F-key. */
const NAMED_KEYS = new Map(Object.entries({
  space: [0x20, 'Space'],
  tab: [0x09, 'Tab'],
  enter: [0x0D, 'Enter'],
  return: [0x0D, 'Enter'],
  escape: [0x1B, 'Esc'],
  esc: [0x1B, 'Esc'],
  backspace: [0x08, 'Backspace'],
  delete: [0x2E, 'Delete'],
  del: [0x2E, 'Delete'],
  insert: [0x2D, 'Insert'],
  ins: [0x2D, 'Insert'],
  home: [0x24, 'Home'],
  end: [0x23, 'End'],
  pageup: [0x21, 'PageUp'],
  pgup: [0x21, 'PageUp'],
  pagedown: [0x22, 'PageDown'],
  pgdn: [0x22, 'PageDown'],
  left: [0x25, 'Left'],
  up: [0x26, 'Up'],
  right: [0x27, 'Right'],
  down: [0x28, 'Down'],
  printscreen: [0x2C, 'PrintScreen'],
  prtsc: [0x2C, 'PrintScreen'],
  capslock: [0x14, 'CapsLock'],
  caps: [0x14, 'CapsLock'],
  ';': [0xBA, ';'],
  semicolon: [0xBA, ';'],
  '=': [0xBB, '='],
  equal: [0xBB, '='],
  plus: [0xBB, '+'],
  ',': [0xBC, ','],
  comma: [0xBC, ','],
  '-': [0xBD, '-'],
  minus: [0xBD, '-'],
  '.': [0xBE, '.'],
  period: [0xBE, '.'],
  '/': [0xBF, '/'],
  slash: [0xBF, '/'],
  '`': [0xC0, '`'],
  backquote: [0xC0, '`'],
  grave: [0xC0, '`'],
  '[': [0xDB, '['],
  bracketleft: [0xDB, '['],
  '\\': [0xDC, '\\'],
  backslash: [0xDC, '\\'],
  ']': [0xDD, ']'],
  bracketright: [0xDD, ']'],
  "'": [0xDE, "'"],
  quote: [0xDE, "'"],
  numpad0: [0x60, 'Num0'],
  numpad1: [0x61, 'Num1'],
  numpad2: [0x62, 'Num2'],
  numpad3: [0x63, 'Num3'],
  numpad4: [0x64, 'Num4'],
  numpad5: [0x65, 'Num5'],
  numpad6: [0x66, 'Num6'],
  numpad7: [0x67, 'Num7'],
  numpad8: [0x68, 'Num8'],
  numpad9: [0x69, 'Num9'],
  numpadmultiply: [0x6A, 'Num*'],
  numpadadd: [0x6B, 'Num+'],
  numpadsubtract: [0x6D, 'Num-'],
  numpaddecimal: [0x6E, 'Num.'],
  numpaddivide: [0x6F, 'Num/'],
}))

function resolveKey(token) {
  if (/^[a-z]$/i.test(token)) {
    const code = token.toUpperCase().charCodeAt(0)
    return { vk: code, label: token.toUpperCase() }
  }
  if (/^[0-9]$/.test(token)) {
    return { vk: 0x30 + Number(token), label: token }
  }
  const fkey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token)
  if (fkey !== null) {
    const n = Number(fkey[1])
    return { vk: 0x6F + n, label: `F${n}` }
  }
  const named = NAMED_KEYS.get(token.toLowerCase())
  if (named !== undefined) return { vk: named[0], label: named[1] }
  throw new Error(`unknown key "${token}" in hotkey`)
}

/**
 * "ctrl+alt+q" -> { mods, vk, label }.
 *
 * A global hotkey with no modifier swallows a plain key in every application on
 * the machine, so that is rejected rather than obeyed, and so is a combo with
 * two non-modifier keys (RegisterHotKey cannot express it).
 */
export function parseHotkey(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new Error('hotkey is empty')
  const tokens = raw.split('+').map((part) => part.trim()).filter((part) => part !== '')
  if (tokens.length === 0) throw new Error(`hotkey "${raw}" has no keys`)

  let mods = 0
  let key
  for (const token of tokens) {
    const bit = MOD_BITS[token.toLowerCase()]
    if (bit !== undefined) {
      mods |= bit
      continue
    }
    if (key !== undefined) {
      throw new Error(`hotkey "${raw}" has two non-modifier keys ("${key.label}" and "${token}")`)
    }
    key = resolveKey(token)
  }
  if (mods === 0) {
    throw new Error(`hotkey "${raw}" needs at least one of ctrl, alt, shift, or win`)
  }
  if (key === undefined) {
    throw new Error(`hotkey "${raw}" has modifiers but no key`)
  }
  const label = [...MOD_LABEL.filter(([bit]) => (mods & bit) !== 0).map(([, name]) => name), key.label].join('+')
  return { mods, vk: key.vk, label }
}

function b64utf8(text) {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64')
}

/**
 * One PowerShell program holding the whole helper: P/Invoke surface, window
 * lookup, toggle, hotkey loop, and parent watchdog.
 *
 * Titles, log paths, and the window-title suffix travel as base64 so arbitrary
 * UTF-8 (quotes, CJK) cannot break a PowerShell literal and the script source
 * stays pure ASCII.
 */
export const CSHARP = `
using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class DshHotkeyHelper
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder s, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    const int SW_SHOW = 5;
    const int SW_MINIMIZE = 6;
    const int SW_RESTORE = 9;
    const uint WM_HOTKEY = 0x0312;
    const uint WM_SYSCOMMAND = 0x0112;
    const int SC_MINIMIZE = 0xF020;
    const int SC_RESTORE = 0xF120;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    static string logPath = "";
    static string suffix = "";

    static void Log(string message)
    {
        try
        {
            string dir = Path.GetDirectoryName(logPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
            var info = new FileInfo(logPath);
            if (info.Exists && info.Length > 256 * 1024) File.WriteAllText(logPath, "");
            File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
        }
        catch
        {
            // logging must never take the helper down
        }
    }

    /// <summary>Fallback path when the app window rejects ShowWindow (UIPI).</summary>
    static bool SysCommand(IntPtr hWnd, int command)
    {
        try
        {
            IntPtr result;
            bool ok = SendMessageTimeoutW(hWnd, WM_SYSCOMMAND, (IntPtr)command, IntPtr.Zero, 0x0002, 2000, out result);
            return ok;
        }
        catch
        {
            return false;
        }
    }

    static string ImageName(uint pid)
    {
        IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return null;
        try
        {
            var buffer = new StringBuilder(1024);
            uint size = (uint)buffer.Capacity;
            if (!QueryFullProcessImageNameW(handle, 0, buffer, ref size)) return null;
            return buffer.ToString();
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    static string TitleOf(IntPtr hWnd)
    {
        var buffer = new StringBuilder(512);
        int n = GetWindowTextW(hWnd, buffer, buffer.Capacity);
        if (n <= 0) return "";
        return buffer.ToString(0, Math.Min(n, buffer.Length));
    }

    static string ClassOf(IntPtr hWnd)
    {
        var buffer = new StringBuilder(128);
        int n = GetClassNameW(hWnd, buffer, buffer.Capacity);
        if (n <= 0) return "";
        return buffer.ToString(0, Math.Min(n, buffer.Length));
    }

    /// <summary>
    /// The app window is the best-scoring top-level window whose title ends with
    /// the configured suffix. Visibility, the Chrome_WidgetWin_* class, and the
    /// executable name are evidence, not requirements: a badge-points search
    /// still finds the window if the app was renamed or rebuilt on another
    /// framework, instead of silently matching nothing.
    /// </summary>
    static IntPtr FindWindow()
    {
        IntPtr best = IntPtr.Zero;
        int bestScore = int.MinValue;
        uint self = (uint)Process.GetCurrentProcess().Id;

        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            string title = TitleOf(hWnd);
            if (title.Length == 0) return true;
            if (!title.EndsWith(suffix, StringComparison.Ordinal)) return true;

            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            int score = 0;
            bool visible = IsWindowVisible(hWnd);
            if (visible) score += 20; else score += 2;
            if (IsIconic(hWnd)) score += 5;
            if (ClassOf(hWnd).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) score += 30;
            if (pid != self) score += 3;
            string image = ImageName(pid);
            if (image != null && image.EndsWith("DeepSeek Harness.exe", StringComparison.OrdinalIgnoreCase)) score += 60;

            if (score > bestScore)
            {
                bestScore = score;
                best = hWnd;
            }
            return true;
        }, IntPtr.Zero);

        return best;
    }

    static bool Focus(IntPtr hWnd)
    {
        IntPtr foreground = GetForegroundWindow();
        uint pid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out pid);
        uint self = GetCurrentThreadId();
        bool attached = false;
        try
        {
            if (foregroundThread != 0 && foregroundThread != self) attached = AttachThreadInput(self, foregroundThread, true);
        }
        catch
        {
        }
        try
        {
            BringWindowToTop(hWnd);
            bool ok = SetForegroundWindow(hWnd);
            if (!ok)
            {
                Thread.Sleep(20);
                ok = SetForegroundWindow(hWnd);
            }
            return ok;
        }
        finally
        {
            if (attached)
            {
                try { AttachThreadInput(self, foregroundThread, false); } catch { }
            }
        }
    }

    static void Toggle()
    {
        IntPtr hWnd = FindWindow();
        if (hWnd == IntPtr.Zero)
        {
            Log("toggle: no window title ends with \\"" + suffix + "\\"");
            return;
        }

        string title = TitleOf(hWnd);
        if (title.Length > 64) title = title.Substring(0, 64) + "...";
        bool visible = IsWindowVisible(hWnd);
        bool iconic = IsIconic(hWnd);

        if (!visible)
        {
            // Hidden to tray or by the app itself: restore is what resurrects it,
            // but ShowWindow is the only call that un-hides.
            bool shown = ShowWindowAsync(hWnd, SW_SHOW);
            SysCommand(hWnd, SC_RESTORE);
            Focus(hWnd);
            Log("restore (was hidden) hwnd=0x" + hWnd.ToInt64().ToString("X8") + " shown=" + shown + " title=\\"" + title + "\\"");
            return;
        }

        if (iconic)
        {
            bool sent = SysCommand(hWnd, SC_RESTORE);
            if (!sent) ShowWindowAsync(hWnd, SW_RESTORE);
            Focus(hWnd);
            Log("restore hwnd=0x" + hWnd.ToInt64().ToString("X8") + " sent=" + sent + " iconic=" + IsIconic(hWnd) + " title=\\"" + title + "\\"");
            return;
        }

        bool handed = SysCommand(hWnd, SC_MINIMIZE);
        if (!handed)
        {
            try { ShowWindow(hWnd, SW_MINIMIZE); } catch { }
        }
        Thread.Sleep(30);
        Log("minimize hwnd=0x" + hWnd.ToInt64().ToString("X8") + " sent=" + handed + " iconic=" + IsIconic(hWnd) + " title=\\"" + title + "\\"");
    }

    /// <summary>
    /// A detached helper outlives the host that spawned it. Watching the host pid
    /// is what keeps a stale registration from blocking the next one after a
    /// restart.
    /// </summary>
    static void WatchParent(int parentPid)
    {
        var thread = new Thread(delegate()
        {
            while (true)
            {
                Thread.Sleep(2000);
                bool dead = false;
                try
                {
                    using (Process process = Process.GetProcessById(parentPid))
                    {
                        if (process.HasExited) dead = true;
                    }
                }
                catch (ArgumentException)
                {
                    dead = true;
                }
                catch (InvalidOperationException)
                {
                    dead = true;
                }
                catch
                {
                    // Unknown (access denied and friends): keep running rather than
                    // drop a working hotkey on a guess.
                }
                if (dead)
                {
                    Log("parent " + parentPid + " is gone, exiting");
                    try { UnregisterHotKey(IntPtr.Zero, HotkeyId); } catch { }
                    Environment.Exit(0);
                }
            }
        });
        thread.IsBackground = true;
        thread.Name = "dsh-hotkey-parent-watch";
        thread.Start();
    }

    static int HotkeyId = 1;

    public static int Run(uint mods, uint vk, string titleSuffix, string logFile, int parentPid, int registerTimeoutMs, int hotkeyId)
    {
        HotkeyId = hotkeyId;
        suffix = titleSuffix;
        logPath = logFile;

        Log("helper start pid=" + Process.GetCurrentProcess().Id + " parent=" + parentPid + " thread=" + GetCurrentThreadId());

        int waited = 0;
        bool registered = false;
        while (true)
        {
            registered = RegisterHotKey(IntPtr.Zero, hotkeyId, mods, vk);
            if (registered) break;
            int error = Marshal.GetLastWin32Error();
            if (waited >= registerTimeoutMs)
            {
                Log("register failed after " + waited + "ms error=" + error + " (another program may already own this combination)");
                return 4;
            }
            if (waited == 0) Log("register busy error=" + error + ", retrying for up to " + registerTimeoutMs + "ms");
            Thread.Sleep(250);
            waited += 250;
        }

        Log("registered mods=0x" + mods.ToString("X") + " vk=0x" + vk.ToString("X") + " id=" + hotkeyId);

        IntPtr target = FindWindow();
        if (target == IntPtr.Zero)
        {
            Log("no window yet whose title ends with \\"" + suffix + "\\"; will look again on each press");
        }
        else
        {
            uint pid;
            GetWindowThreadProcessId(target, out pid);
            string title = TitleOf(target);
            if (title.Length > 64) title = title.Substring(0, 64) + "...";
            Log("target hwnd=0x" + target.ToInt64().ToString("X8") + " pid=" + pid + " class=\\"" + ClassOf(target) + "\\" visible=" + IsWindowVisible(target) + " iconic=" + IsIconic(target) + " title=\\"" + title + "\\"");
        }

        if (parentPid > 0) WatchParent(parentPid);

        MSG msg;
        while (true)
        {
            int result = GetMessage(out msg, IntPtr.Zero, 0, 0);
            if (result == 0 || result == -1) break;
            if (msg.message != WM_HOTKEY) continue;
            if (msg.wParam.ToInt64() != (long)hotkeyId) continue;
            try
            {
                Toggle();
            }
            catch (Exception error)
            {
                Log("toggle threw: " + error.GetType().Name + ": " + error.Message);
            }
        }

        Log("message loop ended, unregistering");
        try { UnregisterHotKey(IntPtr.Zero, hotkeyId); } catch { }
        return 0;
    }
}
`

export function buildHelperScript(cfg, combo, options = {}) {
  const parentPid = Math.max(0, Math.floor(options.parentPid ?? 0))
  const registerTimeoutMs = Math.max(0, Math.floor(options.registerTimeoutMs ?? 10_000))
  const hotkeyId = 1
  const titleSuffix = String(cfg.windowTitle ?? 'DeepSeek Harness').trim()
  const logFile = cfg.logFile ?? DEFAULT_LOG
  const csharp = CSHARP
  const lines = ["$ErrorActionPreference='Stop'"]
  lines.push(`$log=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64utf8(logFile)}'))`)
  lines.push(`$suffix=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64utf8(titleSuffix)}'))`)
  lines.push("Add-Type -TypeDefinition @'")
  lines.push(csharp)
  lines.push("'@")
  lines.push(`$code=[DshHotkeyHelper]::Run(${combo.mods}, ${combo.vk}, $suffix, $log, ${parentPid}, ${registerTimeoutMs}, ${hotkeyId})`)
  lines.push('exit $code')
  return lines.join('\n')
}

function stamp() {
  const now = new Date()
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
}

/**
 * Append one plain line to the same file the helper writes, so the story of a
 * press (registered -> target found -> minimized) reads in order instead of
 * arriving in two formats.
 */
export function record(cfg, message) {
  const file = cfg.logFile ?? DEFAULT_LOG
  try {
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > LOG_MAX_BYTES) truncateSync(file, 0)
    } catch {
      /* the file does not exist yet */
    }
    appendFileSync(file, `${stamp()} [plugin] ${message}\n`, 'utf8')
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * Read whatever the helper appended since `offset`, newest last.
 *
 * `offset` comes from a byte size, so it has to be applied to the bytes: slicing
 * the decoded string would drift by one character per CJK title in the log and
 * eventually read past the end.
 */
export function readNewLines(cfg, offset) {
  const file = cfg.logFile ?? DEFAULT_LOG
  try {
    const bytes = readFileSync(file)
    if (bytes.length <= offset) return { offset: bytes.length, lines: [] }
    const text = bytes.subarray(offset).toString('utf8')
    return { offset: bytes.length, lines: text.split(/\r?\n/).filter((line) => line.trim() !== '') }
  } catch {
    return { offset, lines: [] }
  }
}

export function logSize(cfg) {
  try {
    return statSync(cfg.logFile ?? DEFAULT_LOG).size
  } catch {
    return 0
  }
}

/**
 * Start the helper, returning a stop function.
 *
 * The script goes to a file instead of `-EncodedCommand`: the C# source alone is
 * ~13 KB, and UTF-16 base64 turns that into a command line well past Windows'
 * 32767-character limit, which Node reports as `spawn ENAMETOOLONG`. A file also
 * makes the generated program inspectable when something misbehaves.
 *
 * The child is deliberately *not* detached. A detached PowerShell launched this
 * way never runs its script (verified on this machine with `DETACHED_PROCESS`:
 * no output, no log, immediate exit), and a helper has no reason to outlive its
 * host anyway — a survivor would hold the hotkey and block the next
 * registration. Detaching was never what made the old helper harmless: the
 * parent watcher in the script is, and it still fires when the host is killed.
 */
export function startHelper(cfg, combo, options = {}) {
  const script = buildHelperScript(cfg, combo, options)
  const dir = dirname(cfg.logFile ?? DEFAULT_LOG)
  const scriptPath = join(dir, `helper-${process.pid}.ps1`)
  mkdirSync(dir, { recursive: true })
  sweepStaleScripts(dir)
  writeFileSync(scriptPath, script, 'utf8')

  const spawnImpl = cfg.spawn ?? spawn
  const child = spawnImpl(
    cfg.powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  child.on?.('error', (error) => {
    record(cfg, `spawn failed: ${String(error)}`)
    options.logger?.warn?.(`hotkey: helper process failed to start: ${String(error)}`)
  })
  child.unref?.()
  return {
    pid: child.pid,
    scriptPath,
    stop() {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      try {
        unlinkSync(scriptPath)
      } catch {
        /* the helper already cleaned it up, or the file never landed */
      }
    },
  }
}

/**
 * A host that dies without disposing leaves its helper script behind. Anything
 * older than an hour cannot belong to a live helper, so sweep those instead of
 * letting temp grow one 13 KB file per crash.
 */
function sweepStaleScripts(dir) {
  const cutoff = Date.now() - 60 * 60 * 1000
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!/^helper-\d+\.ps1$/.test(entry)) continue
    const path = join(dir, entry)
    try {
      if (statSync(path).mtimeMs > cutoff) continue
      unlinkSync(path)
    } catch {
      /* raced with another host or the sweep itself */
    }
  }
}
