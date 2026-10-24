# Runs the plugin's generated helper exactly as the host would, then drives it
# through a thread message the same way RegisterHotKey would on a real keypress.
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\15940\Documents\deepseek-harness\default-workspace\dsh-hotkey'
$log = Join-Path $env:TEMP 'dsh-hotkey\test-helper.log'
$errFile = Join-Path $env:TEMP 'dsh-hotkey\helper-stderr.txt'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Remove-Item $log, $errFile -ErrorAction SilentlyContinue

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOTKEY_TEST_LOG = $log
$node = 'D:\Program Files\Deepseek\DeepSeek Harness.exe'
& $node "$root\test\gen.mjs" | Out-Null
"gen: $(Get-Content "$root\test\gen-status.txt" -Raw)"

$helper = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
  -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "$root\test\generated-helper.ps1") `
  -WindowStyle Hidden -PassThru -RedirectStandardError $errFile -RedirectStandardOutput (Join-Path $env:TEMP 'dsh-hotkey\helper-stdout.txt')
"helper pid=$($helper.Id)"

Start-Sleep -Seconds 6
"alive=$(-not $helper.HasExited)"
if (Test-Path $errFile) { "stderr:"; Get-Content $errFile | Select-Object -First 40 }

"--- log ---"
if (Test-Path $log) { Get-Content $log } else { "NO LOG" }

$threadLine = (Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ -match 'thread=(\d+)' } | Select-Object -First 1)
"thread line: $threadLine"
if ($threadLine -match 'thread=(\d+)') { $threadId = [uint32]$Matches[1]; "threadId=$threadId" } else { "cannot parse thread id"; $helper | Stop-Process -Force; exit 1 }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Drive {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostThreadMessageW(uint tid, uint msg, IntPtr w, IntPtr l);
  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      if (c.ToString() != "Chrome_WidgetWin_1") return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      if (!t.ToString().EndsWith("DeepSeek Harness")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static string State() {
    IntPtr h = Find();
    return "hwnd=0x" + h.ToInt64().ToString("X8") + " iconic=" + IsIconic(h) + " fg=0x" + GetForegroundWindow().ToInt64().ToString("X8");
  }
}
'@

"state before: $([Drive]::State())"
$ok1 = [Drive]::PostThreadMessageW($threadId, 0x0312, [IntPtr]1, [IntPtr]::Zero)
"post WM_HOTKEY #1 = $ok1 err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
Start-Sleep -Milliseconds 1200
"state after #1: $([Drive]::State())"

$ok2 = [Drive]::PostThreadMessageW($threadId, 0x0312, [IntPtr]1, [IntPtr]::Zero)
"post WM_HOTKEY #2 = $ok2"
Start-Sleep -Milliseconds 1200
"state after #2: $([Drive]::State())"

"--- log after presses ---"
if (Test-Path $log) { Get-Content $log } else { "NO LOG" }
if (-not $helper.HasExited) { $helper | Stop-Process -Force }
"helper stopped"
