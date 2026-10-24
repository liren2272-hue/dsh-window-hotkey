# End-to-end check against the running host: post the same WM_HOTKEY the real
# shortcut delivers to the helper thread, then read what the helper logged.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class LiveProbe
{
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostThreadMessageW(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
}
'@

$log = 'C:\Users\15940\AppData\Local\Temp\dsh-hotkey\hotkey.log'
$line = Get-Content $log -Encoding UTF8 | Where-Object { $_ -match 'helper start' } | Select-Object -Last 1
if (-not $line) { Write-Output 'no helper start line'; exit 1 }
$thread = [int]([regex]::Match($line, 'thread=(\d+)').Groups[1].Value)
Write-Output "helper thread=$thread"

function Tail([int]$n) { Get-Content $log -Encoding UTF8 | Select-Object -Last $n }

$ok1 = [LiveProbe]::PostThreadMessageW($thread, 0x0312, [IntPtr]1, [IntPtr]::Zero)
Write-Output "post#1=$ok1 error=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
Start-Sleep -Milliseconds 1200
Tail 2 | Write-Output

$ok2 = [LiveProbe]::PostThreadMessageW($thread, 0x0312, [IntPtr]1, [IntPtr]::Zero)
Write-Output "post#2=$ok2 error=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
Start-Sleep -Milliseconds 1200
Tail 2 | Write-Output
