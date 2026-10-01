# Updating while the manager is open, and while Claude Desktop or Codex has the Bridge's MCP
# server running, must succeed: the installer closes those programs (they hold files it
# replaces) and does not reopen anything. Versions before 1.0.2 failed in this situation.
param([Parameter(Mandatory=$true)][string]$SetupExe)
. (Join-Path $PSScriptRoot 'installer-harness.ps1')
$SetupExe=(Resolve-Path -LiteralPath $SetupExe).Path
$box=New-Isolation 'upgrade'
try {
  $code=Invoke-Setup $SetupExe $box @('/MERGETASKS="!clients"')
  if($code -ne 0){ throw "First install returned $code" }
  $app=Join-Path $box.Install 'desktop\SAP MCP Connection Manager.exe'
  Start-Process -FilePath $app | Out-Null
  # What an MCP client keeps running: the bundled runtime, from the install folder.
  $host_=Start-Process -FilePath (Join-Path $box.Install 'runtime\node.exe') -ArgumentList '-e','setInterval(()=>{},1000)' -WindowStyle Hidden -PassThru
  $lock=Join-Path $box.Data 'manager.lock'
  foreach($attempt in 1..60) { if((Test-Path -LiteralPath $lock) -and ((Get-Content -Raw -LiteralPath $lock) -match '127\.0\.0\.1')) { break }; Start-Sleep -Milliseconds 500 }
  if(!((Test-Path -LiteralPath $lock) -and ((Get-Content -Raw -LiteralPath $lock) -match '127\.0\.0\.1'))) { throw 'The manager did not start' }
  Write-Output 'Manager and a stand-in MCP server are running from the install folder.'

  $code=Invoke-Setup $SetupExe $box @('/MERGETASKS="!clients"')
  if($code -ne 0){ throw "Upgrade over running programs returned $code" }
  Start-Sleep -Seconds 3
  if(!$host_.HasExited) { throw 'The running MCP server was not closed' }
  $left=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($box.Install+'\',[StringComparison]::OrdinalIgnoreCase) })
  if($left.Count) { throw "The upgrade reopened or left running: $($left.Path -join ', ')" }
  if(!(Test-Path -LiteralPath $app)) { throw 'The app is missing after the upgrade' }
  Write-Output 'PASS: an update closes the running manager and MCP server, installs, and opens nothing.'
  Invoke-Uninstall $box
} finally {
  Close-Isolation $box
}
