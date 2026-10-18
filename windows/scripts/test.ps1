param([switch]$SelfContained)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $projectRoot
node (Join-Path $PSScriptRoot 'build-runtime.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Runtime generation failed' }
node --test (Join-Path $repoRoot 'tests/core.test.cjs') (Join-Path $repoRoot 'tests/runtime.test.cjs') (Join-Path $projectRoot 'tests/desktop.test.cjs') (Join-Path $projectRoot 'tests/worker.test.cjs') (Join-Path $projectRoot 'tests/companion.test.cjs')
if ($LASTEXITCODE -ne 0) { throw 'JavaScript tests failed' }
if ($SelfContained) { & (Join-Path $PSScriptRoot 'build.ps1') }
else { & (Join-Path $PSScriptRoot 'build.ps1') -FrameworkDependent }
dotnet run --project (Join-Path $projectRoot 'SmokeTests/SmokeTests.csproj') -c Release -- $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Windows transport/render tests failed' }
