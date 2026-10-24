# Lifecycle cases the hotkey helper has to survive: a second helper that cannot
# register (host restarted while the old one still held the key), and a helper
# whose host process is gone.
$ErrorActionPreference = 'Continue'
$root = 'C:\Users\15940\Documents\deepseek-harness\default-workspace\dsh-hotkey'
$scriptDir = Join-Path $root 'test'
$dir = Join-Path $env:TEMP 'dsh-hotkey'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$node = 'D:\Program Files\Deepseek\DeepSeek Harness.exe'
$env:ELECTRON_RUN_AS_NODE = '1'

function New-Helper([string]$logName, [string]$outName, [int]$parent, [int]$timeout) {
  $env:DSH_HOTKEY_TEST_LOG = Join-Path $dir $logName
  $env:DSH_HOTKEY_TEST_OUT = $outName
  $env:DSH_HOTKEY_TEST_PARENT = "$parent"
  $env:DSH_HOTKEY_TEST_REGISTER_TIMEOUT = "$timeout"
  Remove-Item (Join-Path $dir $logName) -ErrorAction SilentlyContinue
  & $node "$scriptDir\gen.mjs" | Out-Null
  return Join-Path $dir $logName
}

function Start-Helper([string]$scriptName, [string]$tag) {
  $path = Join-Path $scriptDir $scriptName
  if (-not (Test-Path $path)) { Write-Output "MISSING SCRIPT $path" }
  Start-Process -FilePath $ps `
    -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $path) `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardError (Join-Path $dir "$tag-stderr.txt") -RedirectStandardOutput (Join-Path $dir "$tag-stdout.txt")
}

Write-Output '=== A: second helper cannot register while the first holds the key ==='
$aLog = New-Helper 'a.log' 'helper-a.ps1' 0 8000
Write-Output "gen: $(Get-Content (Join-Path $scriptDir 'gen-status.txt') -Raw)"
$aProc = Start-Helper 'helper-a.ps1' 'a'
Start-Sleep -Seconds 5
Write-Output "A alive=$(-not $aProc.HasExited)"
if (Test-Path $aLog) { Get-Content $aLog | Write-Output } else { Write-Output 'A: NO LOG' }

$bLog = New-Helper 'b.log' 'helper-b.ps1' 0 1500
$bProc = Start-Helper 'helper-b.ps1' 'b'
$null = $bProc.WaitForExit(15000)
Write-Output "B exited=$($bProc.HasExited) exitcode=$($bProc.ExitCode)"
if (Test-Path $bLog) { Get-Content $bLog | Write-Output } else { Write-Output 'B: NO LOG' }
if (Test-Path (Join-Path $dir 'b-stderr.txt')) { Write-Output 'B stderr:'; Get-Content (Join-Path $dir 'b-stderr.txt') | Select-Object -First 20 }

Write-Output ''
Write-Output '=== B: helper exits when its host process disappears ==='
# Release the key first, or the third helper can never get past registration.
if (-not $aProc.HasExited) { $aProc | Stop-Process -Force; Start-Sleep -Seconds 1 }
$dummy = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 600') -WindowStyle Hidden -PassThru
Write-Output "dummy parent pid=$($dummy.Id)"
$cLog = New-Helper 'c.log' 'helper-c.ps1' $dummy.Id 8000
$cProc = Start-Helper 'helper-c.ps1' 'c'
Start-Sleep -Seconds 5
Write-Output "C alive before kill=$(-not $cProc.HasExited)"
$dummy | Stop-Process -Force
Write-Output 'parent killed, waiting...'
$gone = $cProc.WaitForExit(12000)
Write-Output "C exited within 12s=$gone exitcode=$($cProc.ExitCode)"
if (Test-Path $cLog) { Get-Content $cLog | Write-Output } else { Write-Output 'C: NO LOG' }

if (-not $aProc.HasExited) { $aProc | Stop-Process -Force }
if (-not $cProc.HasExited) { $cProc | Stop-Process -Force }
Write-Output 'cleaned up'

# Leave the desktop as we found it.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Restore {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SendMessageTimeoutW(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
  public static IntPtr Find() {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      if (!t.ToString().EndsWith("DeepSeek Harness")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static string Fix() {
    IntPtr h = Find();
    if (h == IntPtr.Zero) return "no window";
    if (IsIconic(h)) {
      IntPtr r;
      SendMessageTimeoutW(h, 0x0112, (IntPtr)0xF120, IntPtr.Zero, 2, 2000, out r);
      System.Threading.Thread.Sleep(400);
      SetForegroundWindow(h);
    }
    return "iconic=" + IsIconic(h);
  }
}
'@
"window state now: $([Restore]::Fix())"
