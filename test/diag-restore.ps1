$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class D2 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetLastError();

  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      string title = t.ToString();
      if (title.Length == 0 || !title.EndsWith("DeepSeek Harness")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  public static string SysCommand(IntPtr h, int cmd) {
    IntPtr res;
    bool ok = SendMessageTimeoutW(h, 0x0112, (IntPtr)cmd, IntPtr.Zero, 0x0002, 2000, out res);
    return "ok=" + ok + " res=" + res.ToInt64() + " err=" + GetLastError();
  }

  public static string Foreground() {
    return "0x" + GetForegroundWindow().ToInt64().ToString("X8");
  }

  public static string TryForeground(IntPtr h) {
    bool sfw = SetForegroundWindow(h);
    uint e1 = GetLastError();
    IntPtr fg = GetForegroundWindow();
    return "setfg=" + sfw + " err=" + e1 + " fg=0x" + fg.ToInt64().ToString("X8");
  }

  public static string TryAttachForeground(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint pid;
    uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    bool btt = BringWindowToTop(h);
    bool sfw = SetForegroundWindow(h);
    uint e1 = GetLastError();
    if (attached) AttachThreadInput(me, fgThread, false);
    IntPtr now = GetForegroundWindow();
    return "attached=" + attached + " bringtop=" + btt + " setfg=" + sfw + " err=" + e1 + " fg=0x" + now.ToInt64().ToString("X8");
  }
}
'@

$h = [D2]::Find()
"hwnd=0x{0:X8}" -f $h.ToInt64()
"start: iconic=$([D2]::IsIconic($h)) visible=$([D2]::IsWindowVisible($h)) fg=$([D2]::Foreground())"

"--- A: SC_RESTORE (0xF120) ---"
"D2.SysCommand = $([D2]::SysCommand($h, 0xF120))"
Start-Sleep -Milliseconds 500
"after: iconic=$([D2]::IsIconic($h)) fg=$([D2]::Foreground())"

"--- B: minimize via SC_MINIMIZE then restore + SetForegroundWindow ---"
"min: $([D2]::SysCommand($h, 0xF020))"
Start-Sleep -Milliseconds 400
"after min: iconic=$([D2]::IsIconic($h))"
"restore: $([D2]::SysCommand($h, 0xF120))"
Start-Sleep -Milliseconds 300
"after restore: iconic=$([D2]::IsIconic($h))"
"setfg: $([D2]::TryForeground($h))"
Start-Sleep -Milliseconds 200
"fg now: $([D2]::Foreground())"

"--- C: minimize, then showwindowasync(9) ---"
"min: $([D2]::SysCommand($h, 0xF020))"
Start-Sleep -Milliseconds 400
$r = [D2]::ShowWindowAsync($h, 9)
"showwindowasync=$r err=$([D2]::GetLastError())"
Start-Sleep -Milliseconds 500
"after swa: iconic=$([D2]::IsIconic($h)) fg=$([D2]::Foreground())"

"--- D: attach+foreground after minimize ---"
"min: $([D2]::SysCommand($h, 0xF020))"
Start-Sleep -Milliseconds 400
"attachfg: $([D2]::TryAttachForeground($h))"
Start-Sleep -Milliseconds 300
"final: iconic=$([D2]::IsIconic($h)) fg=$([D2]::Foreground())"
