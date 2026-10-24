$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class Diag {
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
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("kernel32.dll")] public static extern uint GetLastError();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT {
    public int length; public int flags; public int showCmd;
    public POINT ptMin; public POINT ptMax; public RECT rcNormal;
  }

  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      string title = t.ToString();
      if (title.Length == 0 || !title.EndsWith("DeepSeek Harness")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  public static string Placement(IntPtr h) {
    var wp = new WINDOWPLACEMENT();
    wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
    bool ok = GetWindowPlacement(h, ref wp);
    return "ok=" + ok + " showCmd=" + wp.showCmd + " flags=" + wp.flags
      + " normal=" + wp.rcNormal.Left + "," + wp.rcNormal.Top + "," + wp.rcNormal.Right + "," + wp.rcNormal.Bottom;
  }

  public static string Rect(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "rect-failed";
    return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
  }
}
'@

$h = [Diag]::Find()
"hwnd=0x{0:X8} pid={1}" -f $h.ToInt64(), 0
if ($h -eq [IntPtr]::Zero) { exit 1 }
$p = 0
[void][Diag]::GetWindowThreadProcessId($h, [ref]$p)
"pid=$p"
"style=0x{0:X8} exstyle=0x{1:X8}" -f ([Diag]::GetWindowLong($h, -16)), ([Diag]::GetWindowLong($h, -20))
"visible=$([Diag]::IsWindowVisible($h)) iconic=$([Diag]::IsIconic($h))"
"placement: $([Diag]::Placement($h))"
"rect: $([Diag]::Rect($h))"
"fg=0x{0:X8} shell=0x{1:X8}" -f ([Diag]::GetForegroundWindow().ToInt64()), ([Diag]::GetShellWindow().ToInt64())

"--- SetWindowPos move test (delta) ---"
$r0 = [Diag]::Rect($h)
$ok = [Diag]::SetWindowPos($h, [IntPtr]::Zero, 40, 40, 0, 0, 0x0001 -bor 0x0004 -bor 0x0010)  # SWP_NOSIZE|SWP_NOZORDER... flags: NOSIZE=1 NOZORDER=4 NOACTIVATE=0x10
"setwindowpos=$ok err=$([Diag]::GetLastError())"
Start-Sleep -Milliseconds 300
"rect before=$r0 after=$([Diag]::Rect($h))"

"--- ShowWindow(SW_MINIMIZE=6) ---"
$res = [Diag]::ShowWindow($h, 6)
"showwindow returned=$res err=$([Diag]::GetLastError())"
Start-Sleep -Milliseconds 250
"t+250ms iconic=$([Diag]::IsIconic($h)) visible=$([Diag]::IsWindowVisible($h)) placement: $([Diag]::Placement($h))"
Start-Sleep -Milliseconds 1500
"t+1750ms iconic=$([Diag]::IsIconic($h)) visible=$([Diag]::IsWindowVisible($h)) placement: $([Diag]::Placement($h)) rect: $([Diag]::Rect($h))"

"--- SendMessage WM_SYSCOMMAND SC_MINIMIZE (0x0112, 0xF020) ---"
$r = [IntPtr]::Zero
$ok2 = [Diag]::SendMessageTimeoutW($h, 0x0112, [IntPtr]0xF020, [IntPtr]::Zero, 0x0002, 1500, [ref]$r)
"sendtimeout=$ok2 result=$($r.ToInt64()) err=$([Diag]::GetLastError())"
Start-Sleep -Milliseconds 400
"after syscmd iconic=$([Diag]::IsIconic($h)) placement: $([Diag]::Placement($h))"
