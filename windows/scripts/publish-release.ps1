$ErrorActionPreference='Stop'
$env:GCM_INTERACTIVE='never'
$repoRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$credentialLines=@('protocol=https','host=github.com','') | git credential fill 2>$null
if($LASTEXITCODE -ne 0){throw 'Existing GitHub credential unavailable'}
$credential=@{}
foreach($line in $credentialLines){if($line -match '^([^=]+)=(.*)$'){$credential[$matches[1]]=$matches[2]}}
if(-not $credential.password){throw 'Existing GitHub credential unavailable'}
$headers=@{Authorization=('Bearer '+$credential.password);Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'}
try {
 $api='https://api.github.com/repos/NIkoloj/betterbitrix'
 $commit=(git rev-parse HEAD).Trim()
 $webVersion=[regex]::Match([IO.File]::ReadAllText((Join-Path $repoRoot 'BetterBitrix.meta.js')), '(?m)^// @version\s+(\S+)').Groups[1].Value
 $portableVersion=([xml](Get-Content -LiteralPath (Join-Path $repoRoot 'windows/Directory.Build.props') -Raw)).Project.PropertyGroup.Version
 $tag='v'+$webVersion
 $release=$null
 try {$release=Invoke-RestMethod ($api+'/releases/tags/'+$tag) -Headers $headers} catch {if([int]$_.Exception.Response.StatusCode -ne 404){throw}}
 if(-not $release){
  $body=@{tag_name=$tag;target_commitish=$commit;name="BetterBitrix $webVersion / Windows Portable $portableVersion";body=[IO.File]::ReadAllText((Join-Path $repoRoot 'RELEASE_NOTES.md'));draft=$true;prerelease=$false} | ConvertTo-Json
  $release=Invoke-RestMethod ($api+'/releases') -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
 }
 $paths=@("windows/.build/BetterBitrixPortable-$portableVersion-win-x64.zip","windows/.build/BetterBitrixPortable-$portableVersion-win-x64.zip.sha256",'BetterBitrix.user.js','BetterBitrix.meta.js','windows/companion/BetterBitrixPortable.user.js','windows/companion/BetterBitrixPortable.meta.js')
 foreach($relative in $paths){
  $path=Join-Path $repoRoot $relative
  $name=[IO.Path]::GetFileName($path)
  $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  $existing=$release.assets | Where-Object name -eq $name | Select-Object -First 1
  if($existing){if($existing.digest -ne ('sha256:'+$hash)){throw ('Existing release asset differs: '+$name)}; continue}
  $url=$release.upload_url.Split('{')[0]+'?name='+[Uri]::EscapeDataString($name)
  $asset=Invoke-RestMethod $url -Method Post -Headers $headers -ContentType 'application/octet-stream' -InFile $path -TimeoutSec 600
  if($asset.digest -and $asset.digest -ne ('sha256:'+$hash)){throw ('Uploaded asset digest mismatch: '+$name)}
  Write-Output ('Uploaded and verified: '+$name+' ('+$asset.size+' bytes)')
 }
 if($release.draft){$release=Invoke-RestMethod ($api+'/releases/'+$release.id) -Method Patch -Headers $headers -ContentType 'application/json' -Body '{"draft":false}'}
 Write-Output ('Release published: '+$release.html_url)
} finally {$headers.Clear();$credential.Clear();$credentialLines=$null}