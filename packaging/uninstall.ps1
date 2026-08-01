param([switch] $Silent)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms

$AppName = 'MIDI Voyager Windows'
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MIDI Voyager Windows.lnk'
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MIDI Voyager Windows.lnk'
$MidiExtensions = @('.mid', '.midi', '.kar', '.rmi', '.rmid', '.xmf')
$ProgId = 'MIDIVoyagerWindows.MIDI'

if (-not $Silent) {
    $Answer = [Windows.Forms.MessageBox]::Show('Remove MIDI Voyager Windows from this computer?', $AppName, 'YesNo', 'Question')
    if ($Answer -ne 'Yes') { exit 0 }
}

Get-Process -Name 'MIDI Voyager Windows' | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Remove-Item -LiteralPath $StartMenuShortcut -Force
Remove-Item -LiteralPath $DesktopShortcut -Force

$Classes = 'HKCU:\Software\Classes'
Remove-Item -LiteralPath (Join-Path $Classes 'Applications\MIDI Voyager Windows.exe') -Recurse -Force
Remove-Item -LiteralPath (Join-Path $Classes $ProgId) -Recurse -Force
foreach ($Extension in $MidiExtensions) {
    $OpenWithKey = Join-Path $Classes "$Extension\OpenWithProgids"
    Remove-ItemProperty -LiteralPath $OpenWithKey -Name $ProgId -Force
}
Remove-Item -LiteralPath 'HKCU:\Software\MIDI Voyager Windows' -Recurse -Force
Remove-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' -Name $AppName -Force
Remove-Item -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MIDIVoyagerWindows' -Recurse -Force

try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MidiVoyagerUninstallNotify {
    [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
    [MidiVoyagerUninstallNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch { }

if (-not $Silent) {
    [Windows.Forms.MessageBox]::Show('MIDI Voyager Windows was removed. Your personal settings were left in place.', $AppName, 'OK', 'Information') | Out-Null
}

$CleanupScript = Join-Path $env:TEMP ("midi-voyager-uninstall-{0}.cmd" -f [Guid]::NewGuid().ToString('N'))
$EscapedInstallDir = $InstallDir.Replace('%', '%%')
$CleanupCommands = @(
    '@echo off',
    'timeout /t 2 /nobreak >nul',
    ('rmdir /s /q "{0}"' -f $EscapedInstallDir),
    'del /f /q "%~f0"'
) -join "`r`n"
[IO.File]::WriteAllText($CleanupScript, $CleanupCommands, [Text.Encoding]::ASCII)
Start-Process -FilePath $env:ComSpec -ArgumentList ("/d /c `"{0}`"" -f $CleanupScript) -WindowStyle Hidden
