param([string]$Configuration = 'Release', [switch]$FrameworkDependent)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:DOTNET_CLI_HOME = Join-Path $projectRoot '.build/dotnet-home'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
node (Join-Path $PSScriptRoot 'sync-identity.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Identity generation failed' }
node (Join-Path $PSScriptRoot 'build-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Runtime generation failed' }
$dist = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
function Publish-Project([string]$project) {
    $outputPath = [IO.Path]::GetFullPath((Join-Path $dist $project))
    $expectedRoot = [IO.Path]::GetFullPath($dist) + [IO.Path]::DirectorySeparatorChar
    if (-not $outputPath.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe build output path' }
    if (Test-Path -LiteralPath $outputPath) { Remove-Item -LiteralPath $outputPath -Recurse -Force }
    $publishArgs = @('publish', (Join-Path $projectRoot "$project/$project.csproj"), '-c', $Configuration, '-o', $outputPath, '-p:DebugType=None')
    if ($FrameworkDependent) {
        $publishArgs += @('--self-contained', 'false', '--configfile', (Join-Path $projectRoot 'NuGet.Config'))
    } else {
        $publishArgs += @('-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=true', '-p:EnableCompressionInSingleFile=true', '--configfile', (Join-Path $projectRoot 'Runtime.NuGet.Config'))
    }
    dotnet @publishArgs
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $project" }
}
Publish-Project 'Desktop'
$portableOut = Join-Path $dist 'Portable'
New-Item -ItemType Directory -Force -Path $portableOut | Out-Null
# Do not remove an existing user's portable data when rebuilding binaries.
$publishedFiles = @((Get-ChildItem -LiteralPath (Join-Path $dist 'Desktop') -File).Name)
foreach ($generatedName in @('BetterBitrix.Desktop.dll', 'BetterBitrix.Desktop.deps.json', 'BetterBitrix.Desktop.runtimeconfig.json', 'BetterBitrix.Shared.dll')) {
    if ($generatedName -notin $publishedFiles) {
        $staleFile = Join-Path $portableOut $generatedName
        if (Test-Path -LiteralPath $staleFile -PathType Leaf) { Remove-Item -LiteralPath $staleFile -Force }
    }
}
Get-ChildItem -LiteralPath (Join-Path $dist 'Desktop') -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $portableOut -Force
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'companion/BetterBitrixPortable.user.js') -Destination $portableOut -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination (Join-Path $portableOut 'README.md') -Force
$version = ([xml](Get-Content -LiteralPath (Join-Path $projectRoot 'Directory.Build.props') -Raw)).Project.PropertyGroup.Version
$archivePath = Join-Path $projectRoot ".build/BetterBitrixPortable-$version-win-x64.zip"
# The distributable contains no pairing tokens, cached user state, or legacy installer.
$portableFiles = $publishedFiles + @('BetterBitrixPortable.user.js', 'README.md')
$archiveInputs = $portableFiles | ForEach-Object { Join-Path $portableOut $_ }
Compress-Archive -LiteralPath $archiveInputs -DestinationPath $archivePath -Force
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($archivePath + '.sha256') -Value ($hash + '  ' + [IO.Path]::GetFileName($archivePath)) -Encoding ascii
Write-Output "Portable ready: $portableOut/BetterBitrix.Desktop.exe"
Write-Output "Archive ready: $archivePath"
