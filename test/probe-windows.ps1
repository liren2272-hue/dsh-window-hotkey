$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W2 {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  public static List<string> List(bool visibleOnly) {
    var rows = new List<string>();
    EnumWindows((h, p) => {
      bool vis = IsWindowVisible(h);
      if (visibleOnly && !vis) return true;
      var t = new StringBuilder(512);
      GetWindowTextW(h, t, 512);
      var c = new StringBuilder(256);
      GetClassNameW(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      string name = "?";
      try { name = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { name = "<gone>"; }
      if (t.Length == 0 && !visibleOnly && !name.Contains("DeepSeek")) return true;
      rows.Add(string.Format("hwnd=0x{0:X8} pid={1,-6} proc={2,-24} vis={3} iconic={4} class={5,-24} title={6}",
        h.ToInt64(), pid, name, vis ? 1 : 0, IsIconic(h) ? 1 : 0, c.ToString(), t.ToString()));
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
Write-Output ("foreground=0x{0:X8}" -f [W2]::GetForegroundWindow().ToInt64())
Write-Output ("shell=0x{0:X8}" -f [W2]::GetShellWindow().ToInt64())
Write-Output '--- visible ---'
[W2]::List($true) | ForEach-Object { Write-Output $_ }
Write-Output '--- hidpi/others (ProcessName contains DeepSeek) ---'
[W2]::List($false) | ForEach-Object { Write-Output $_ }
