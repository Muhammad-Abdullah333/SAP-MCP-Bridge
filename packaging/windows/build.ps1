# Builds the Windows installers. By default the runtime and the MCP server come from
# build\base-payload, and Inno Setup from build\tools\inno, both filled by
# packaging\fetch-base.py from their public sources.
#
# Two editions, built from the same sources into the same install folder:
#   desktop  SAP-MCP-Desktop-Bridge-<version>-Windows-Setup.exe      (Electron window)
#   web      SAP-MCP-Desktop-Bridge-<version>-Windows-Web-Setup.exe  (opens in the default browser)
param(
 [string]$BasePackage = (Join-Path $PSScriptRoot '..\..\build\base-payload'),
 [string]$Python = 'python',
 [string]$Output = (Join-Path $PSScriptRoot '..\..\dist'),
 [string]$Iscc = (Join-Path $PSScriptRoot '..\..\build\tools\inno\ISCC.exe'),
 # Which installers to build; both unless one is named.
 [ValidateSet('desktop','web')][string[]]$Edition = @('desktop','web'),
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
$compression=if($Quick){'/DCompression=lzma2/fast'}else{'/DCompression=lzma2/max'}
foreach($ed in $Edition){
 & $Python (Join-Path $project 'packaging\build-desktop.py') --platform win32-x64 --edition $ed --base $BasePackage --output $Output
 if($LASTEXITCODE -ne 0){throw "Payload creation failed ($ed)."}
 Step "$ed payload built"
 $work=Join-Path $project "build\$ed-win32-x64-$version"
 $payload=Join-Path $work 'payload.zip'
 # The installer is built from the payload's own files, so the content fingerprint of
 # payload.zip (packaging\payload-digest.py) describes exactly what gets installed.
 $stage=Join-Path $work 'stage'
 if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Recurse -Force}
 New-Item -ItemType Directory -Path $stage | Out-Null
 & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $payload -C $stage
 if($LASTEXITCODE -ne 0){throw "The $ed payload could not be unpacked."}
 Step "$ed payload unpacked"
 $name=if($ed -eq 'web'){"SAP-MCP-Desktop-Bridge-$version-Windows-Web-Setup"}else{"SAP-MCP-Desktop-Bridge-$version-Windows-Setup"}
 $defines=@($compression,"/DAppVersion=$version","/DPayloadDir=$(Join-Path $stage 'app')","/DProjectDir=$project")
 if($ed -eq 'web'){$defines+='/DWebEdition'}
 & $Iscc /Q @defines "/O$Output" "/F$name" (Join-Path $PSScriptRoot 'installer.iss')
 if($LASTEXITCODE -ne 0){throw "Installer compilation failed ($ed)."}
 Step "$ed installer compiled"
 Remove-Item -LiteralPath $stage -Recurse -Force
 Get-Item -LiteralPath (Join-Path $Output "$name.exe") | Select-Object Name,Length
}
