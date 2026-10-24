$ErrorActionPreference='Stop'
$log=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('QzpcVXNlcnNcMTU5NDBcQXBwRGF0YVxMb2NhbFxUZW1wXGRzaC1ZSHNiSUtcZHNoLWhvdGtleVx0ZXN0LWhlbHBlci5sb2c='))
$suffix=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('RGVlcFNlZWsgSGFybmVzcw=='))
Add-Type -TypeDefinition @'

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
            Log("toggle: no window title ends with \"" + suffix + "\"");
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
            Log("restore (was hidden) hwnd=0x" + hWnd.ToInt64().ToString("X8") + " shown=" + shown + " title=\"" + title + "\"");
            return;
        }

        if (iconic)
        {
            bool sent = SysCommand(hWnd, SC_RESTORE);
            if (!sent) ShowWindowAsync(hWnd, SW_RESTORE);
            Focus(hWnd);
            Log("restore hwnd=0x" + hWnd.ToInt64().ToString("X8") + " sent=" + sent + " iconic=" + IsIconic(hWnd) + " title=\"" + title + "\"");
            return;
        }

        bool handed = SysCommand(hWnd, SC_MINIMIZE);
        if (!handed)
        {
            try { ShowWindow(hWnd, SW_MINIMIZE); } catch { }
        }
        Thread.Sleep(30);
        Log("minimize hwnd=0x" + hWnd.ToInt64().ToString("X8") + " sent=" + handed + " iconic=" + IsIconic(hWnd) + " title=\"" + title + "\"");
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
            Log("no window yet whose title ends with \"" + suffix + "\"; will look again on each press");
        }
        else
        {
            uint pid;
            GetWindowThreadProcessId(target, out pid);
            string title = TitleOf(target);
            if (title.Length > 64) title = title.Substring(0, 64) + "...";
            Log("target hwnd=0x" + target.ToInt64().ToString("X8") + " pid=" + pid + " class=\"" + ClassOf(target) + "\" visible=" + IsWindowVisible(target) + " iconic=" + IsIconic(target) + " title=\"" + title + "\"");
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

'@
$code=[DshHotkeyHelper]::Run(3, 81, $suffix, $log, 0, 8000, 1)
exit $code