$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $projectRoot '.build/BetterBitrixPortable-0.3.2-win-x64.zip'
$probe = [Net.Sockets.TcpClient]::new()
try {
    if ($probe.ConnectAsync('127.0.0.1', 47653).Wait(500) -and $probe.Connected) { throw 'Close the existing local portable app before this isolated launch check.' }
} catch [AggregateException] { }
finally { $probe.Dispose() }
$launchRoot = Join-Path $projectRoot ('.build/portable-launch-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $archive -DestinationPath $launchRoot
$exePath = Join-Path $launchRoot 'BetterBitrix.Desktop.exe'
if ((Get-ChildItem -LiteralPath $launchRoot -File).Count -ne 3) { throw 'Self-contained distribution must contain EXE, userscript and README only.' }
$dataRoot = Join-Path $launchRoot 'data'
New-Item -ItemType Directory -Path $dataRoot | Out-Null
$cached = @{
    tokenHash = ('A' * 64); uid = 1178; uncertain = $false
    state = @{
        protocol = 1; uid = 1178; observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        timer = @{ status = 'running'; startedAt = [DateTimeOffset]::UtcNow.AddHours(-2).ToUnixTimeMilliseconds(); accumulatedMs = 1000; date = '2026-10-05'; task = @{id=129769; title='Portable smoke fixture'} }
        selected = @{id=129769;title='Portable smoke fixture'}; dailyUrl='https://zoom.us/j/123'
    }
}
$sessionFile = Join-Path $dataRoot 'session.json'
$cached | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $sessionFile -Encoding utf8NoBOM
$beforeHash = (Get-FileHash -LiteralPath $sessionFile -Algorithm SHA256).Hash
function Read-Startup {
    $runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
    try { if ($runKey) { return $runKey.GetValue('BetterBitrixPortable') } } finally { if ($runKey) {$runKey.Dispose()} }
}
$startupBefore = Read-Startup
$launchInfo = [Diagnostics.ProcessStartInfo]::new($exePath, '--background')
$launchInfo.UseShellExecute = $false
$launchInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$launchInfo.WorkingDirectory = $launchRoot
$launchInfo.Environment['DOTNET_ROOT'] = Join-Path $launchRoot 'no-installed-dotnet'
$launchInfo.Environment['DOTNET_MULTILEVEL_LOOKUP'] = '0'
$launchInfo.Environment['DOTNET_BUNDLE_EXTRACT_BASE_DIR'] = Join-Path $launchRoot '.runtime'
$launchInfo.Environment['PATH'] = [Environment]::GetFolderPath('System')
for ($iteration = 1; $iteration -le 2; $iteration++) {
    $child = [Diagnostics.Process]::Start($launchInfo)
    try {
        $until = [DateTime]::UtcNow.AddSeconds(20)
        $response = $null
        while (-not $response) {
            if ($child.HasExited) { throw "Portable EXE exited unexpectedly: $($child.ExitCode)" }
            if ([DateTime]::UtcNow -gt $until) { throw 'Portable EXE did not start its loopback bridge.' }
            try { $response = Invoke-WebRequest -Uri 'http://127.0.0.1:47653/BetterBitrixPortable.user.js' -TimeoutSec 2 }
            catch { Start-Sleep -Milliseconds 200 }
        }
        if ($response.Content -notmatch '// ==UserScript==' -or $response.Content -notmatch 'GM_xmlhttpRequest') { throw 'Portable EXE did not serve its embedded bridge.' }
        $ownerId = (Get-NetTCPConnection -State Listen -LocalPort 47653).OwningProcess
        if ($ownerId -ne $child.Id) { throw 'Response came from a different process.' }
        if ($child.MainWindowHandle -ne [IntPtr]::Zero) { throw 'Background portable launch showed a window.' }
        if ((Get-FileHash -LiteralPath $sessionFile -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Cached timer changed while browser was closed.' }
        if ((Read-Startup) -ne $startupBefore) { throw 'Portable launch changed the Windows startup setting.' }
        Write-Output "PASS isolated portable EXE launch $iteration with no installed runtime path, no visible window, cached timer intact and no startup registration"
    } finally {
        # Terminate only the process just created by this test; never an existing user app.
        if (-not $child.HasExited) { $child.Kill();$child.WaitForExit() }
        $child.Dispose()
    }
}
