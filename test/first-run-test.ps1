param([Parameter(Mandatory=$true)][string]$Payload)
# Installing opens the manager. An upgrade stops a running one as part of its work, so it
# has to hand it back rather than leaving the person staring at nothing. This drives the
# real installer twice into one isolated location and closes anything it started.
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot
$root=Join-Path $source ('work\first-run-test-'+[Guid]::NewGuid().ToString('N'))
$env:LOCALAPPDATA=Join-Path $root 'local'
$env:APPDATA=Join-Path $root 'roaming'
$env:USERPROFILE=Join-Path $root 'home'
$env:CODEX_HOME=Join-Path $root 'codex'
$env:SAP_MCP_BRIDGE_LEGACY_HOME=Join-Path $root 'home'
$install=Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'
$data=Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge'
$app=Join-Path $install 'desktop\SAP MCP Connection Manager.exe'
New-Item -ItemType Directory -Force -Path $env:APPDATA,$env:CODEX_HOME,$env:USERPROFILE | Out-Null

function Get-Started {
  # Only ever looks at processes running from this test's own isolated install directory.
  Get-Process -Name 'SAP MCP Connection Manager' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($install,[StringComparison]::OrdinalIgnoreCase) }
}
function Stop-Started {
  Get-Started | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}
function Wait-Started {
  foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 500
    if (Get-Started) { return $true }
  }
  return $false
}

try {
  if (Test-Path -LiteralPath $install) { throw 'The isolated install directory should not exist yet' }

  # --- first install ------------------------------------------------------------
  & (Join-Path $source 'packaging\windows\Install.ps1') -Payload $Payload -Launch
  if ($LASTEXITCODE -ne 0) { throw 'First install failed' }
  if (!(Test-Path -LiteralPath $app)) { throw 'The application is missing after a first install' }
  if (!(Wait-Started)) { throw 'A first install did not open the manager' }
  Write-Output 'PASS: a first install opens the manager.'

  Stop-Started
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath (Join-Path $data 'manager.lock') -Force -ErrorAction SilentlyContinue

  # --- upgrade over it ----------------------------------------------------------
  & (Join-Path $source 'packaging\windows\Install.ps1') -Payload $Payload -Launch
  if ($LASTEXITCODE -ne 0) { throw 'Upgrade failed' }
  if (!(Wait-Started)) { throw 'An upgrade did not reopen the manager it had closed' }
  Write-Output 'PASS: an upgrade reopens the manager.'

  # --- without -Launch nothing is opened ----------------------------------------
  Stop-Started
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath (Join-Path $data 'manager.lock') -Force -ErrorAction SilentlyContinue
  & (Join-Path $source 'packaging\windows\Install.ps1') -Payload $Payload
  if ($LASTEXITCODE -ne 0) { throw 'Install without -Launch failed' }
  Start-Sleep -Seconds 5
  if (Get-Started) { throw 'The installer opened the manager without being asked to' }
  Write-Output 'PASS: without -Launch the installer opens nothing.'
}
finally {
  Stop-Started
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
