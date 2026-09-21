param(
 [Parameter(Mandatory=$true)][string]$BasePackage,
 [Parameter(Mandatory=$true)][string]$Python,
 [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference='Stop'
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version=(Get-Content -Raw -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json).version
& $Python (Join-Path $project 'packaging\build-desktop.py') --platform win32-x64 --base $BasePackage --output $Output
if($LASTEXITCODE -ne 0){throw 'Payload creation failed.'}
$payload=Join-Path $project "build\desktop-win32-x64-$version\payload.zip"
$setupExe=Join-Path $Output "SAP-MCP-Desktop-Bridge-$version-Windows-Setup.exe"
$csc=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /optimize+ /out:$setupExe "/win32manifest:$(Join-Path $PSScriptRoot 'Setup.manifest')" "/win32icon:$(Join-Path $project 'assets\bridge.ico')" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/resource:$payload,payload.zip" "/resource:$(Join-Path $PSScriptRoot 'Install.ps1'),Install.ps1" (Join-Path $PSScriptRoot 'Bootstrapper.cs')
if($LASTEXITCODE -ne 0){throw 'Installer compilation failed.'}
Get-Item -LiteralPath $setupExe | Select-Object Name,Length
