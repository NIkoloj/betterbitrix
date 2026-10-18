param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,
    [switch]$AutoStart
)
$ErrorActionPreference = 'Stop'
# Run from the build's dist directory. No administrator rights are required.
$installRoot = Join-Path $env:LOCALAPPDATA 'BetterBitrix'
$sourceRoot = $PSScriptRoot
if (-not $ExtensionId) { $ExtensionId = (Get-Content -LiteralPath (Join-Path $sourceRoot 'extension/identity.json') -Raw | ConvertFrom-Json).id }
foreach ($name in @('Desktop', 'NativeHost')) {
    $source = Join-Path $sourceRoot $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing $source. Run windows/scripts/build.ps1 first and use dist/install.ps1." }
}
if (Get-Process -Name 'BetterBitrix.Desktop', 'BetterBitrix.NativeHost' -ErrorAction SilentlyContinue) { throw 'Close BetterBitrix and disconnect the extension before installing an update.' }
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
foreach ($name in @('Desktop', 'NativeHost')) {
    $destination = Join-Path $installRoot $name
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Copy-Item -Path (Join-Path $sourceRoot "$name/*") -Destination $destination -Recurse -Force
}
$hostPath = Join-Path $installRoot 'NativeHost/BetterBitrix.NativeHost.exe'
$manifestPath = Join-Path $installRoot 'NativeHost/com.betterbitrix.desktop.json'
$ExtensionId = $ExtensionId.ToLowerInvariant()
$manifest = @{ name = 'com.betterbitrix.desktop'; description = 'BetterBitrix desktop browser bridge'; path = $hostPath; type = 'stdio'; allowed_origins = @("chrome-extension://$ExtensionId/") }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
    $keyPath = "HKCU:\Software\$browser\NativeMessagingHosts\com.betterbitrix.desktop"
    New-Item -Path $keyPath -Force | Out-Null
    Set-Item -Path $keyPath -Value $manifestPath
}
$exePath = Join-Path $installRoot 'Desktop/BetterBitrix.Desktop.exe'
if ($AutoStart) {
    New-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Force | Out-Null
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name BetterBitrix -Value "`"$exePath`" --background"
}
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'BetterBitrix.lnk'))
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = Split-Path -Parent $exePath
$shortcut.Save()
Start-Process -FilePath $exePath -WindowStyle Hidden
Write-Output 'BetterBitrix installed. Keep the extension loaded and open your Bitrix tab. Click the extension icon to select the connected tab.'
