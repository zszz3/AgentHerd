#requires -Version 7.4
# Internal candidate only. Run in a fresh GitHub-hosted Windows job with the matching
# checkout, its installed dependencies, Node 24, and a job timeout. Never use an owner profile.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateNotNullOrEmpty()][string] $Installer)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Requires a disposable GitHub-hosted Windows Actions runner'
}
$setup = Get-Item -LiteralPath $Installer
if ($setup.PSIsContainer -or $setup.Extension -ne '.exe') { throw 'Expected an Inno Setup executable' }

# The pet has the same title. Check a visible, resizable main window of the exact PID we start.
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class CandidateWindow {
    delegate bool Visitor(IntPtr window, IntPtr data);
    [DllImport("user32")] static extern bool EnumWindows(Visitor visit, IntPtr data);
    [DllImport("user32")] static extern int GetWindowThreadProcessId(IntPtr w, out int pid);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr w);
    [DllImport("user32")] static extern bool IsIconic(IntPtr w);
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder title, int count);
    [DllImport("user32")] static extern int GetWindowLong(IntPtr w, int index);
    struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32")] static extern bool GetWindowRect(IntPtr w, out Rect rect);
    public static bool Ready(int appPid) {
        bool found = false;
        EnumWindows((w, unused) => {
            int pid; GetWindowThreadProcessId(w, out pid);
            var title = new StringBuilder(256);
            Rect r;
            found = pid == appPid && IsWindowVisible(w) && !IsIconic(w) &&
                GetWindowText(w, title, 256) != 0 && title.ToString() == "AgentHerd" &&
                (GetWindowLong(w, -16) & 0x40000) != 0 && GetWindowRect(w, out r) &&
                r.Right-r.Left >= 860 && r.Bottom-r.Top >= 560;
            return !found;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$tempParent = (Get-Item -LiteralPath $env:RUNNER_TEMP).FullName
$name = 'candidate-smoke-' + [guid]::NewGuid()
$tmp = (New-Item -ItemType Directory -Path (Join-Path $tempParent $name)).FullName
$install = Join-Path $tmp 'installed'
$exe = Join-Path $install 'AgentHerd.exe'
$herd = Join-Path $tmp 'herd'
$app = $null
$installed = $false
try {
    # Pass overrides only to the candidate and its children, not to the runner shell.
    $roaming = (New-Item -ItemType Directory -Path (Join-Path $tmp 'roaming')).FullName
    $envOverrides = @{
        APPDATA = $roaming; AGENTHERD_HOME = $herd; AGENTHERD_HOST_ENTRY = $null
        AGENTHERD_AGENTS = $null; AGENTHERD_DWS = $null; ELECTRON_RENDERER_URL = $null
    }
    $silent = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
    $argsSetup = "/CURRENTUSER $silent /NOICONS /NOCLOSEAPPLICATIONS /NORESTARTAPPLICATIONS /DIR=`"$install`""
    $result = Start-Process -FilePath $setup.FullName -ArgumentList $argsSetup -Environment $envOverrides -WorkingDirectory $tmp -PassThru -Wait
    if ($result.ExitCode -ne 0) { throw "Setup failed (exit $($result.ExitCode))" }
    $installed = $true
    if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Setup did not install AgentHerd.exe in the requested directory' }

    # The taskbar and Task Manager take the name and icon from the exe, so neither may be Electron's.
    $info = (Get-Item -LiteralPath $exe).VersionInfo
    if ($info.FileDescription -ne 'AgentHerd' -or $info.ProductName -ne 'AgentHerd') {
        throw "AgentHerd.exe describes itself as '$($info.FileDescription)' / '$($info.ProductName)'"
    }
    $desktopPackage = Join-Path $PSScriptRoot '..\apps\desktop\package.json'
    $electronExe = & node -e "console.log(require('node:module').createRequire(process.argv[1])('electron'))" $desktopPackage |
        Select-Object -Last 1
    if ($LASTEXITCODE -ne 0 -or !$electronExe -or !(Test-Path -LiteralPath $electronExe -PathType Leaf)) {
        throw 'Cannot find the Electron binary to compare icons'
    }
    Add-Type -AssemblyName System.Drawing
    $iconOf = {
        param($file)
        $stream = [IO.MemoryStream]::new()
        [Drawing.Icon]::ExtractAssociatedIcon($file).ToBitmap().Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        [Convert]::ToBase64String($stream.ToArray())
    }
    if ((& $iconOf $exe) -eq (& $iconOf $electronExe)) { throw "AgentHerd.exe still has Electron's icon" }

    # Chromium can resolve its default user data via Windows known folders rather than APPDATA.
    $appOut = Join-Path $tmp 'desktop.out.log'
    $appErr = Join-Path $tmp 'desktop.err.log'
    $app = Start-Process -FilePath $exe -ArgumentList "--user-data-dir=`"$roaming\chromium`"" -Environment $envOverrides -WorkingDirectory $install -RedirectStandardOutput $appOut -RedirectStandardError $appErr -PassThru
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $lastProbe = 'No visible AgentHerd main window'
    do {
        if ($app.HasExited) { throw "Installed desktop exited early (code $($app.ExitCode))" }
        if ([CandidateWindow]::Ready($app.Id)) {
            $lastProbe = & node (Join-Path $PSScriptRoot 'windows-desktop-probe.mjs') $herd 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0) { break }
        }
        if ($clock.Elapsed.TotalSeconds -ge 120) {
            # The installed app logs only to its streams and the host log; show both.
            foreach ($log in @($appOut, $appErr) + @(Get-ChildItem -LiteralPath $tmp -Recurse -Filter 'host*.log' -ErrorAction SilentlyContinue | ForEach-Object FullName)) {
                if (Test-Path -LiteralPath $log) { Write-Host "--- $log"; Get-Content -LiteralPath $log -Tail 40 | Write-Host }
            }
            Get-ChildItem -Force -LiteralPath $HOME -Filter '.agentherd-location*' | ForEach-Object { Write-Host "profile file $($_.Name) $($_.Length)" }
            throw "Installed main window or matching host.status() did not become ready: $lastProbe"
        }
        Start-Sleep -Milliseconds 750
    } while ($true)
    Write-Host 'Visible installed main window and matching host.status() observed'
    & node (Join-Path $PSScriptRoot 'windows-candidate-probe.mjs') $herd (Join-Path $install 'resources')
    if ($LASTEXITCODE -ne 0 -or $app.HasExited) { throw 'Installed candidate probe failed' }
    & node (Join-Path $PSScriptRoot 'windows-dws-handoff.mjs') (Join-Path $install 'resources\dws\dws.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Installed DingTalk CLI did not produce a verified authorization handoff' }
} finally {
    try {
        if ($null -ne $app -and !$app.HasExited) {
            # Closing the main window hides it in the tray. End only this run's process tree.
            $app.Kill($true)
            if (!$app.WaitForExit(10000)) { throw 'Candidate process tree did not exit' }
        }
        if (Test-Path -LiteralPath $install -PathType Container) {
            $uninstallers = @(Get-ChildItem -LiteralPath $install -File -Filter 'unins*.exe')
            if ($uninstallers.Count -eq 1) {
                $result = Start-Process -FilePath $uninstallers[0].FullName -ArgumentList $silent -Environment $envOverrides -WorkingDirectory $tmp -PassThru -Wait
                if ($result.ExitCode -ne 0) { throw "Uninstaller failed (exit $($result.ExitCode))" }
                foreach ($path in $exe, $uninstallers[0].FullName, (Join-Path $install 'resources\dws\dws.exe')) {
                    if (Test-Path -LiteralPath $path) { throw 'Uninstaller left installed files behind' }
                }
            } elseif ($installed -or $uninstallers.Count -gt 1) { throw 'Expected exactly one Inno uninstaller in the install directory' }
        }
    } finally {
        if ($tmp -ne (Join-Path $tempParent $name)) { throw 'Unexpected cleanup path' }
        # Chromium may briefly hold handles after its process tree exits.
        foreach ($attempt in 1..10) {
            try { Remove-Item -LiteralPath $tmp -Recurse -Force; break }
            catch { if ($attempt -eq 10) { throw }; Start-Sleep -Milliseconds 500 }
        }
    }
}
Write-Host 'Observed per-user silent install, installed resources, main window, local host status, disconnected DingTalk status, silent uninstall and temporary-directory cleanup.'
Write-Host 'Not tested: signing or SmartScreen reputation, agent sessions, DingTalk login, organization access, reads or writes. Only the CLI handoff was checked; no browser was opened and no account was authorized.'
