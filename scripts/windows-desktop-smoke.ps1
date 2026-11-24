# Run only in a disposable Windows Actions checkout: this deletes the installed Electron binary.
#requires -Version 7
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Requires a disposable Windows Actions runner' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $repo
$pkg = node -p "require('fs').realpathSync('apps/desktop/node_modules/electron')"
if ($LASTEXITCODE -ne 0 -or !$pkg.StartsWith("$repo\node_modules\", [StringComparison]::OrdinalIgnoreCase) -or
    (Get-Content -LiteralPath "$pkg/package.json" -Raw | ConvertFrom-Json).name -ne 'electron') {
    throw "Not the checkout's Electron package: $pkg"
}
foreach ($name in 'path.txt', 'dist') {
    $path = Join-Path $pkg $name
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    if (Test-Path -LiteralPath $path) { throw "Failed to remove $path" }
}

# Main and pet both use the title AgentHerd. Only the main window is resizable and
# at least 860 x 560. Enumerate all visible top-level windows, not MainWindowTitle.
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class SmokeWindow {
    delegate bool Visitor(IntPtr window, IntPtr data);
    [DllImport("user32")] static extern bool EnumWindows(Visitor visit, IntPtr data);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr w);
    [DllImport("user32")] static extern bool IsIconic(IntPtr w);
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder title, int count);
    [DllImport("user32")] static extern int GetWindowThreadProcessId(IntPtr w, out int pid);
    [DllImport("user32")] static extern int GetWindowLong(IntPtr w, int index);
    struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32")] static extern bool GetWindowRect(IntPtr w, out Rect rect);
    public static bool Ready(string exe) {
        bool found = false;
        EnumWindows((w, unused) => {
            var title = new StringBuilder(256);
            Rect rect;
            if (!IsWindowVisible(w) || IsIconic(w) || GetWindowText(w, title, 256) == 0 ||
                title.ToString() != "AgentHerd" || (GetWindowLong(w, -16) & 0x40000) == 0 ||
                !GetWindowRect(w, out rect) || rect.Right-rect.Left < 860 || rect.Bottom-rect.Top < 560) return true;
            int pid;
            GetWindowThreadProcessId(w, out pid);
            try {
                using (var p = Process.GetProcessById(pid))
                    found = string.Equals(p.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase);
            } catch (ArgumentException) {} // Window owner exited during enumeration.
            return !found;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$tmp = (New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ('desktop-smoke-' + [guid]::NewGuid()))).FullName
$app = $null
try {
    $env:AGENTHERD_HOME = Join-Path $tmp 'herd'
    # Electron stores its Chromium profile under appData, separately from AGENTHERD_HOME.
    $env:APPDATA = (New-Item -ItemType Directory -Path (Join-Path $tmp 'roaming')).FullName
    $app = Start-Process $env:ComSpec -ArgumentList '/d /c pnpm --filter @agentherd/desktop start' -PassThru -NoNewWindow
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $lastProbe = 'No visible AgentHerd main window'
    while ($clock.Elapsed.TotalSeconds -lt 240) {
        if ($app.HasExited) { throw "Desktop start exited early (code $($app.ExitCode))" }
        if ([SmokeWindow]::Ready((Join-Path $pkg 'dist\electron.exe'))) {
            $lastProbe = node scripts/windows-desktop-probe.mjs $env:AGENTHERD_HOME
            if ($LASTEXITCODE -eq 0 -and !$app.HasExited) {
                Write-Host $lastProbe
                return
            }
        }
        Start-Sleep -Milliseconds 750
    }
    # The desktop logs little on its own; show what the host left behind.
    Get-ChildItem -LiteralPath $tmp -Recurse -Filter '*.log' -ErrorAction SilentlyContinue |
        ForEach-Object {
            Write-Host "--- $($_.FullName)"
            Get-Content -LiteralPath $_.FullName -Tail 50
        }
    throw "Desktop did not become ready within 240 s: $lastProbe"
} finally {
    if ($null -ne $app -and !$app.HasExited) {
        $app.Kill($true) # Only this launcher and its descendants, including the utility host.
        if (!$app.WaitForExit(10000)) { throw 'Desktop process tree did not exit' }
    }
    # Windows may hold Chromium files briefly after terminating the tree.
    foreach ($attempt in 1..10) {
        try { Remove-Item -LiteralPath $tmp -Force -Recurse; break }
        catch { if ($attempt -eq 10) { throw }; Start-Sleep -Milliseconds 500 }
    }
}
