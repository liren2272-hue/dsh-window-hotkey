$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class DshWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      string title = t.ToString();
      if (title.Length == 0 || !title.EndsWith("DeepSeek Harness")) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static void Focus(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint fgPid; uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out fgPid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
    BringWindowToTop(h);
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fgThread, false);
  }

  public static string Toggle() {
    IntPtr h = Find();
    if (h == IntPtr.Zero) return "not-found";
    if (IsIconic(h)) { ShowWindow(h, 9); Focus(h); return "restored"; }
    ShowWindow(h, 6);
    return "minimized";
  }
}
'@

$h = [DshWin]::Find()
"found=0x{0:X8}" -f $h.ToInt64()
if ($h -eq [IntPtr]::Zero) { exit 1 }

"before iconic=$([DshWin]::IsIconic($h))"
"toggle1=$([DshWin]::Toggle())"
Start-Sleep -Milliseconds 900
"after minimize iconic=$([DshWin]::IsIconic($h))"
"toggle2=$([DshWin]::Toggle())"
Start-Sleep -Milliseconds 900
"after restore iconic=$([DshWin]::IsIconic($h)) foreground=0x{0:X8}" -f ([DshWin]::GetForegroundWindow().ToInt64())
