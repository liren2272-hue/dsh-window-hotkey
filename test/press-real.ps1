# Try real key injection (Ctrl+Alt+Q) and observe whether the live helper reacts.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class RealKeys
{
    [DllImport("user32.dll", SetLastError = true)] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
function Tap-Q {
    [RealKeys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)   # Ctrl down
    [RealKeys]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # Alt down
    [RealKeys]::keybd_event(0x51, 0, 0, [UIntPtr]::Zero)   # Q down
    Start-Sleep -Milliseconds 60
    [RealKeys]::keybd_event(0x51, 0, 2, [UIntPtr]::Zero)   # Q up
    [RealKeys]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)   # Alt up
    [RealKeys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)   # Ctrl up
}
$log = 'C:\Users\15940\AppData\Local\Temp\dsh-hotkey\hotkey.log'
$before = (Get-Content $log -Encoding UTF8).Count
Write-Output "log lines before=$before"
Tap-Q
Start-Sleep -Milliseconds 1500
$after1 = (Get-Content $log -Encoding UTF8).Count
Write-Output "after press#1 lines=$after1"
Get-Content $log -Encoding UTF8 | Select-Object -Last 3 | Write-Output
Tap-Q
Start-Sleep -Milliseconds 1500
Write-Output "after press#2 lines=$((Get-Content $log -Encoding UTF8).Count)"
Get-Content $log -Encoding UTF8 | Select-Object -Last 3 | Write-Output
