# Is the combination currently free? A stale helper from a crashed host would
# hold it, and the plugin would then log "register failed ... 1409" at startup.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HotkeyProbe
{
    [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
'@
$ok = [HotkeyProbe]::RegisterHotKey([IntPtr]::Zero, 7, 3, 0x51)
$code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($ok) { [HotkeyProbe]::UnregisterHotKey([IntPtr]::Zero, 7) | Out-Null }
Write-Output "ctrl+alt+q free=$ok error=$code"
