param([Parameter(Mandatory=$true)][ValidateSet('arm64','x64')][string]$Architecture,[Parameter(Mandatory=$true)][string]$BasePackage,[Parameter(Mandatory=$true)][string]$Python,[Parameter(Mandatory=$true)][string]$Output)
$project=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
& $Python (Join-Path $project 'packaging\build-desktop.py') --platform "darwin-$Architecture" --base $BasePackage --output $Output
if($LASTEXITCODE -ne 0){throw 'macOS package creation failed.'}
