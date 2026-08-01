$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression.FileSystem

[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$AppName = 'MIDI Voyager Windows'
$AppVersion = '__APP_VERSION__'
$AppExeName = 'MIDI Voyager Windows.exe'
$PayloadMarker = '__PAYLOAD_MARKER__'
$SetupPath = $env:MIDI_VOYAGER_SETUP_PATH
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\MIDI Voyager Windows'
$InstallParent = Split-Path -Parent $InstallDir
$StartMenuShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\MIDI Voyager Windows.lnk'
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MIDI Voyager Windows.lnk'
$SetupLog = Join-Path $env:TEMP 'MIDI Voyager Windows Setup.log'
$MidiExtensions = @('.mid', '.midi', '.kar', '.rmi', '.rmid', '.xmf')
$ProgId = 'MIDIVoyagerWindows.MIDI'

if (-not $SetupPath -or -not (Test-Path -LiteralPath $SetupPath -PathType Leaf)) {
    [System.Windows.Forms.MessageBox]::Show('Setup could not locate its installation payload.', $AppName, 'OK', 'Error') | Out-Null
    exit 1
}

function Extract-InstallerPayload([string] $Destination) {
    $TemporaryZip = Join-Path $env:TEMP ("midi-voyager-{0}.zip" -f [Guid]::NewGuid().ToString('N'))
    $InputStream = $null
    $OutputStream = $null
    try {
        $InputStream = [IO.File]::Open($SetupPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $ProbeLength = [Math]::Min($InputStream.Length, 16MB)
        $Probe = New-Object byte[] ([int] $ProbeLength)
        $ProbeRead = $InputStream.Read($Probe, 0, $Probe.Length)
        $ProbeText = [Text.Encoding]::GetEncoding(28591).GetString($Probe, 0, $ProbeRead)
        $MarkerIndex = $ProbeText.LastIndexOf($PayloadMarker, [StringComparison]::Ordinal)
        if ($MarkerIndex -lt 0) { throw 'The embedded setup payload is missing or damaged.' }

        $InputStream.Position = $MarkerIndex + $PayloadMarker.Length
        $OutputStream = [IO.File]::Open($TemporaryZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $InputStream.CopyTo($OutputStream)
        $OutputStream.Dispose(); $OutputStream = $null
        $InputStream.Dispose(); $InputStream = $null
        [IO.Compression.ZipFile]::ExtractToDirectory($TemporaryZip, $Destination)
    } finally {
        if ($OutputStream) { $OutputStream.Dispose() }
        if ($InputStream) { $InputStream.Dispose() }
        Remove-Item -LiteralPath $TemporaryZip -Force -ErrorAction SilentlyContinue
    }
}

function New-AppShortcut([string] $ShortcutPath, [string] $ExecutablePath) {
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = $ExecutablePath
    $Shortcut.WorkingDirectory = $InstallDir
    $Shortcut.IconLocation = "$ExecutablePath,0"
    $Shortcut.Description = 'Play, visualise and edit MIDI files'
    $Shortcut.Save()
}

function Set-RegistryDefault([string] $Path, [string] $Value) {
    New-Item -Path $Path -Force | Out-Null
    Set-Item -Path $Path -Value $Value
}

function Register-MidiVoyager([string] $ExecutablePath) {
    $Classes = 'HKCU:\Software\Classes'
    $ApplicationKey = Join-Path $Classes "Applications\$AppExeName"
    New-Item -Path $ApplicationKey -Force | Out-Null
    New-ItemProperty -Path $ApplicationKey -Name 'FriendlyAppName' -Value $AppName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $ApplicationKey -Name 'ApplicationIcon' -Value "$ExecutablePath,0" -PropertyType String -Force | Out-Null
    Set-RegistryDefault (Join-Path $ApplicationKey 'shell\open\command') ('"{0}" "%1"' -f $ExecutablePath)
    $SupportedTypes = Join-Path $ApplicationKey 'SupportedTypes'
    New-Item -Path $SupportedTypes -Force | Out-Null
    foreach ($Extension in $MidiExtensions) {
        New-ItemProperty -Path $SupportedTypes -Name $Extension -Value '' -PropertyType String -Force | Out-Null
    }

    $ProgIdKey = Join-Path $Classes $ProgId
    Set-RegistryDefault $ProgIdKey 'MIDI sequence'
    Set-RegistryDefault (Join-Path $ProgIdKey 'DefaultIcon') "$ExecutablePath,0"
    Set-RegistryDefault (Join-Path $ProgIdKey 'shell\open\command') ('"{0}" "%1"' -f $ExecutablePath)
    foreach ($Extension in $MidiExtensions) {
        $OpenWithKey = Join-Path $Classes "$Extension\OpenWithProgids"
        New-Item -Path $OpenWithKey -Force | Out-Null
        New-ItemProperty -Path $OpenWithKey -Name $ProgId -Value '' -PropertyType String -Force | Out-Null
    }

    $Capabilities = 'HKCU:\Software\MIDI Voyager Windows\Capabilities'
    New-Item -Path $Capabilities -Force | Out-Null
    New-ItemProperty -Path $Capabilities -Name 'ApplicationName' -Value $AppName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $Capabilities -Name 'ApplicationDescription' -Value 'Play, visualise, mix and export MIDI files.' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $Capabilities -Name 'ApplicationIcon' -Value "$ExecutablePath,0" -PropertyType String -Force | Out-Null
    $Associations = Join-Path $Capabilities 'FileAssociations'
    New-Item -Path $Associations -Force | Out-Null
    foreach ($Extension in $MidiExtensions) {
        New-ItemProperty -Path $Associations -Name $Extension -Value $ProgId -PropertyType String -Force | Out-Null
    }
    New-Item -Path 'HKCU:\Software\RegisteredApplications' -Force | Out-Null
    New-ItemProperty -Path 'HKCU:\Software\RegisteredApplications' -Name $AppName -Value 'Software\MIDI Voyager Windows\Capabilities' -PropertyType String -Force | Out-Null
}

function Register-Uninstaller([string] $ExecutablePath) {
    $UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MIDIVoyagerWindows'
    $Uninstaller = Join-Path $InstallDir 'Uninstall.ps1'
    $SizeBytes = (Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    New-Item -Path $UninstallKey -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'DisplayName' -Value $AppName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'DisplayVersion' -Value $AppVersion -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'DisplayIcon' -Value "$ExecutablePath,0" -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'Publisher' -Value 'MIDI Voyager' -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'InstallLocation' -Value $InstallDir -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'UninstallString' -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $Uninstaller) -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'QuietUninstallString' -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}" -Silent' -f $Uninstaller) -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'EstimatedSize' -Value ([int] ($SizeBytes / 1KB)) -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $UninstallKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
}

function Notify-ShellAssociationsChanged {
    if (-not ('MidiVoyager.ShellNotify' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace MidiVoyager {
    public static class ShellNotify {
        [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
    }
}
'@
    }
    [MidiVoyager.ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}

$Form = New-Object System.Windows.Forms.Form
$Form.Text = "$AppName Setup"
$Form.ClientSize = New-Object System.Drawing.Size(620, 380)
$Form.StartPosition = 'CenterScreen'
$Form.FormBorderStyle = 'FixedDialog'
$Form.MaximizeBox = $false
$Form.MinimizeBox = $true
$Form.BackColor = [Drawing.Color]::FromArgb(11, 17, 27)
$Form.ForeColor = [Drawing.Color]::FromArgb(234, 245, 255)
$Form.Font = New-Object Drawing.Font('Segoe UI', 9)
try { $Form.Icon = [Drawing.Icon]::ExtractAssociatedIcon($SetupPath) } catch { }

$Header = New-Object Windows.Forms.Panel
$Header.Location = New-Object Drawing.Point(0, 0)
$Header.Size = New-Object Drawing.Size(620, 112)
$Header.BackColor = [Drawing.Color]::FromArgb(8, 28, 52)
$Form.Controls.Add($Header)

$IconBox = New-Object Windows.Forms.PictureBox
$IconBox.Location = New-Object Drawing.Point(24, 18)
$IconBox.Size = New-Object Drawing.Size(76, 76)
$IconBox.SizeMode = 'Zoom'
try { $IconBox.Image = ([Drawing.Icon]::ExtractAssociatedIcon($SetupPath)).ToBitmap() } catch { }
$Header.Controls.Add($IconBox)

$Title = New-Object Windows.Forms.Label
$Title.Text = 'Install MIDI Voyager Windows'
$Title.Location = New-Object Drawing.Point(116, 27)
$Title.AutoSize = $true
$Title.Font = New-Object Drawing.Font('Segoe UI Semibold', 18)
$Header.Controls.Add($Title)

$Subtitle = New-Object Windows.Forms.Label
$Subtitle.Text = "Version $AppVersion  |  64-bit Windows"
$Subtitle.Location = New-Object Drawing.Point(119, 66)
$Subtitle.AutoSize = $true
$Subtitle.ForeColor = [Drawing.Color]::FromArgb(112, 220, 255)
$Header.Controls.Add($Subtitle)

$Description = New-Object Windows.Forms.Label
$Description.Text = 'Setup installs the app for your Windows account and registers it in Open with for MIDI files. Administrator permission is not required.'
$Description.Location = New-Object Drawing.Point(26, 132)
$Description.Size = New-Object Drawing.Size(565, 44)
$Description.ForeColor = [Drawing.Color]::FromArgb(160, 180, 200)
$Form.Controls.Add($Description)

$PathTitle = New-Object Windows.Forms.Label
$PathTitle.Text = 'Install location'
$PathTitle.Location = New-Object Drawing.Point(26, 182)
$PathTitle.AutoSize = $true
$PathTitle.Font = New-Object Drawing.Font('Segoe UI Semibold', 9)
$Form.Controls.Add($PathTitle)

$PathLabel = New-Object Windows.Forms.TextBox
$PathLabel.Text = $InstallDir
$PathLabel.Location = New-Object Drawing.Point(27, 204)
$PathLabel.Size = New-Object Drawing.Size(564, 24)
$PathLabel.ReadOnly = $true
$PathLabel.BackColor = [Drawing.Color]::FromArgb(17, 24, 36)
$PathLabel.ForeColor = [Drawing.Color]::FromArgb(220, 235, 247)
$PathLabel.BorderStyle = 'FixedSingle'
$Form.Controls.Add($PathLabel)

$DesktopOption = New-Object Windows.Forms.CheckBox
$DesktopOption.Text = 'Create a desktop shortcut'
$DesktopOption.Location = New-Object Drawing.Point(28, 244)
$DesktopOption.AutoSize = $true
$DesktopOption.Checked = $true
$Form.Controls.Add($DesktopOption)

$LaunchOption = New-Object Windows.Forms.CheckBox
$LaunchOption.Text = 'Launch MIDI Voyager Windows after setup'
$LaunchOption.Location = New-Object Drawing.Point(28, 272)
$LaunchOption.AutoSize = $true
$LaunchOption.Checked = $true
$Form.Controls.Add($LaunchOption)

$Status = New-Object Windows.Forms.Label
$Status.Text = 'Ready to install'
$Status.Location = New-Object Drawing.Point(28, 306)
$Status.AutoSize = $true
$Status.ForeColor = [Drawing.Color]::FromArgb(112, 220, 255)
$Form.Controls.Add($Status)

$Progress = New-Object Windows.Forms.ProgressBar
$Progress.Location = New-Object Drawing.Point(28, 329)
$Progress.Size = New-Object Drawing.Size(382, 19)
$Progress.Style = 'Blocks'
$Form.Controls.Add($Progress)

$CancelButton = New-Object Windows.Forms.Button
$CancelButton.Text = 'Cancel'
$CancelButton.Location = New-Object Drawing.Point(420, 323)
$CancelButton.Size = New-Object Drawing.Size(80, 30)
$CancelButton.DialogResult = 'Cancel'
$Form.Controls.Add($CancelButton)

$InstallButton = New-Object Windows.Forms.Button
$InstallButton.Text = 'Install'
$InstallButton.Location = New-Object Drawing.Point(510, 323)
$InstallButton.Size = New-Object Drawing.Size(80, 30)
$InstallButton.BackColor = [Drawing.Color]::FromArgb(43, 170, 235)
$InstallButton.FlatStyle = 'Flat'
$Form.Controls.Add($InstallButton)
$Form.AcceptButton = $InstallButton
$Form.CancelButton = $CancelButton

$InstallButton.Add_Click({
    $Staging = Join-Path $env:TEMP ("MIDI Voyager Windows install {0}" -f [Guid]::NewGuid().ToString('N'))
    try {
        if (Get-Process -Name 'MIDI Voyager Windows' -ErrorAction SilentlyContinue) {
            [Windows.Forms.MessageBox]::Show('Close MIDI Voyager Windows before installing this update.', $AppName, 'OK', 'Information') | Out-Null
            return
        }
        $InstallButton.Enabled = $false
        $CancelButton.Enabled = $false
        $DesktopOption.Enabled = $false
        $LaunchOption.Enabled = $false
        $Progress.Style = 'Marquee'
        $Status.Text = 'Extracting application files...'
        [Windows.Forms.Application]::DoEvents()

        New-Item -ItemType Directory -Path $Staging -Force | Out-Null
        Extract-InstallerPayload $Staging
        New-Item -ItemType Directory -Path $InstallParent -Force | Out-Null
        if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
        Move-Item -LiteralPath $Staging -Destination $InstallDir

        $ExecutablePath = Join-Path $InstallDir $AppExeName
        if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) { throw 'The installed application executable was not found.' }
        $Status.Text = 'Creating shortcuts and MIDI file registration...'
        [Windows.Forms.Application]::DoEvents()
        Register-MidiVoyager $ExecutablePath
        Register-Uninstaller $ExecutablePath
        New-AppShortcut $StartMenuShortcut $ExecutablePath
        if ($DesktopOption.Checked) { New-AppShortcut $DesktopShortcut $ExecutablePath }
        elseif (Test-Path -LiteralPath $DesktopShortcut) { Remove-Item -LiteralPath $DesktopShortcut -Force }
        Notify-ShellAssociationsChanged

        $Progress.Style = 'Blocks'; $Progress.Value = 100
        $Status.Text = 'Installation complete'
        [Windows.Forms.MessageBox]::Show("$AppName $AppVersion was installed successfully.", $AppName, 'OK', 'Information') | Out-Null
        if ($LaunchOption.Checked) { Start-Process -FilePath $ExecutablePath -WorkingDirectory $InstallDir }
        $Form.DialogResult = 'OK'
        $Form.Close()
    } catch {
        "$(Get-Date -Format o)`r`n$($_.Exception.ToString())" | Set-Content -LiteralPath $SetupLog -Encoding UTF8
        $Progress.Style = 'Blocks'; $Progress.Value = 0
        $Status.Text = 'Installation failed'
        [Windows.Forms.MessageBox]::Show("Setup could not finish.`r`n`r`n$($_.Exception.Message)`r`n`r`nDetails were saved to:`r`n$SetupLog", $AppName, 'OK', 'Error') | Out-Null
        $InstallButton.Enabled = $true
        $CancelButton.Enabled = $true
        $DesktopOption.Enabled = $true
        $LaunchOption.Enabled = $true
    } finally {
        if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue }
    }
})

[void] $Form.ShowDialog()
