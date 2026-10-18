$ErrorActionPreference = 'Stop'
if (Get-Process -Name 'BetterBitrix.Desktop', 'BetterBitrix.NativeHost' -ErrorAction SilentlyContinue) { throw 'Close BetterBitrix and disconnect the extension first.' }
foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
    $keyPath = "HKCU:\Software\$browser\NativeMessagingHosts\com.betterbitrix.desktop"
    if (Test-Path -LiteralPath $keyPath) { Remove-Item -LiteralPath $keyPath }
}
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name BetterBitrix -ErrorAction SilentlyContinue
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'BetterBitrix.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
Write-Output 'Browser bridge and autostart removed. Remove the browser extension. Application files and local settings remain in LocalAppData/BetterBitrix; portal timer and browser data are preserved.'
