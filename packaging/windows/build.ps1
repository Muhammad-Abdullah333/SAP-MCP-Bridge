# Builds the Windows installer. By default the runtime and the MCP server come from
# build\base-payload, and Inno Setup from build\tools\inno, both filled by
# packaging\fetch-base.py from their public sources.
param(
 [string]$BasePackage = (Join-Path $PSScriptRoot '..\..\build\base-payload'),
 [string]$Python = 'python',
 [string]$Output = (Join-Path $PSScriptRoot '..\..\dist'),
 [string]$Iscc = (Join-Path $PSScriptRoot '..\..\build\tools\inno\ISCC.exe'),
 # Faster compression and a larger installer, for local test builds. Never for a release.
 [switch]$Quick
)
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path $Output | Out-Null
$Output=(Resolve-Path -LiteralPath $Output).Path
$BasePackage=(Resolve-Path -LiteralPath $BasePackage).Path
if(!(Test-Path -LiteralPath $Iscc)){throw "Inno Setup compiler not found at $Iscc. Run packaging\fetch-base.py first."}
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version=(Get-Content -Raw -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json).version
$clock=[Diagnostics.Stopwatch]::StartNew()
function Step([string]$Name){ Write-Host ('{0,5:N0}s  {1}' -f $clock.Elapsed.TotalSeconds,$Name) }
& $Python (Join-Path $project 'packaging\build-desktop.py') --platform win32-x64 --base $BasePackage --output $Output
if($LASTEXITCODE -ne 0){throw 'Payload creation failed.'}
Step 'payload built'
$work=Join-Path $project "build\desktop-win32-x64-$version"
$payload=Join-Path $work 'payload.zip'
# The installer is built from the payload's own files, so the content fingerprint of
# payload.zip (packaging\payload-digest.py) describes exactly what gets installed.
$stage=Join-Path $work 'stage'
if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Recurse -Force}
New-Item -ItemType Directory -Path $stage | Out-Null
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $payload -C $stage
if($LASTEXITCODE -ne 0){throw 'The payload could not be unpacked.'}
Step 'payload unpacked'
$compression=if($Quick){'/DCompression=lzma2/fast'}else{'/DCompression=lzma2/max'}
$name="SAP-MCP-Desktop-Bridge-$version-Windows-Setup"
& $Iscc /Q $compression "/DAppVersion=$version" "/DPayloadDir=$(Join-Path $stage 'app')" "/DProjectDir=$project" "/O$Output" "/F$name" (Join-Path $PSScriptRoot 'installer.iss')
if($LASTEXITCODE -ne 0){throw 'Installer compilation failed.'}
Step 'installer compiled'
Remove-Item -LiteralPath $stage -Recurse -Force
Get-Item -LiteralPath (Join-Path $Output "$name.exe") | Select-Object Name,Length
