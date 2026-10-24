$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class E2E {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
  [DllImport("user32.dll")] public static extern uint MsgWaitForMultipleObjects(uint count, IntPtr handles, bool waitAll, uint ms, uint mask);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] public static extern uint GetLastError();

  [StructLayout(LayoutKind.Sequential)] public struct MSG {
    public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY;
  }

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

  public static string State(IntPtr h) { return "iconic=" + IsIconic(h) + " visible=" + IsWindowVisible(h); }

  // Returns true if a WM_HOTKEY for id arrived within timeout; drains other messages.
  public static bool WaitHotkey(int id, int timeoutMs) {
    int deadline = Environment.TickCount + timeoutMs;
    while (Environment.TickCount < deadline) {
      MSG m;
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) {
        if (m.message == 0x0312 && (int)m.wParam == id) return true;
      }
      int remaining = deadline - Environment.TickCount;
      if (remaining <= 0) break;
      MsgWaitForMultipleObjects(0, IntPtr.Zero, false, (uint)Math.Min(remaining, 200), 0x04FF);
    }
    return false;
  }

  public static void PressCtrlAltQ() {
    const uint UP = 0x0002;
    keybd_event(0x11, 0, 0, UIntPtr.Zero);       // ctrl down
    keybd_event(0x12, 0, 0, UIntPtr.Zero);       // alt down
    System.Threading.Thread.Sleep(60);
    keybd_event(0x51, 0, 0, UIntPtr.Zero);       // q down
    keybd_event(0x51, 0, UP, UIntPtr.Zero);      // q up
    System.Threading.Thread.Sleep(60);
    keybd_event(0x12, 0, UP, UIntPtr.Zero);      // alt up
    keybd_event(0x11, 0, UP, UIntPtr.Zero);      // ctrl up
  }
}
'@

$h = [E2E]::Find()
"hwnd=0x{0:X8} state: $([E2E]::State($h))" -f $h.ToInt64()

# Restore if minimized so we start from a known state
if ([E2E]::IsIconic($h)) {
  $r = [IntPtr]::Zero
  [void][E2E]::SendMessageTimeoutW($h, 0x0112, [IntPtr]0xF120, [IntPtr]::Zero, 2, 2000, [ref]$r)
  Start-Sleep -Milliseconds 500
  "restored to: $([E2E]::State($h))"
}

$mods = 0x0001 -bor 0x0002   # MOD_ALT | MOD_CONTROL
$vkQ  = 0x51

$ok1 = [E2E]::RegisterHotKey([IntPtr]::Zero, 1, $mods, $vkQ)
"registerHotKey id=1 -> $ok1 err=$([E2E]::GetLastError())  threadId=$([E2E]::GetCurrentThreadId())"
if (-not $ok1) { exit 2 }

$ok2 = [E2E]::RegisterHotKey([IntPtr]::Zero, 2, $mods, $vkQ)
"second register (expected False) -> $ok2 err=$([E2E]::GetLastError())"

"press ctrl+alt+q #1"
[E2E]::PressCtrlAltQ()
$got1 = [E2E]::WaitHotkey(1, 3000)
"  wm_hotkey=$got1 state=$([E2E]::State($h))"
Start-Sleep -Milliseconds 600
"  settled state=$([E2E]::State($h))"

"press ctrl+alt+q #2"
[E2E]::PressCtrlAltQ()
$got2 = [E2E]::WaitHotkey(1, 3000)
"  wm_hotkey=$got2"
Start-Sleep -Milliseconds 600
"  settled state=$([E2E]::State($h))"

"foreground=0x{0:X8}" -f ([E2E]::GetForegroundWindow().ToInt64())

[void][E2E]::UnregisterHotKey([IntPtr]::Zero, 1)
"unregistered"
