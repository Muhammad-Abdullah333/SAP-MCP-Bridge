# The two editions install into the same folder under the same Settings > Apps entry, so
# installing one over the other switches editions. Checks, desktop -> web -> desktop: the
# person's data is untouched, the Start menu shortcut follows the edition, Electron is
# removed for the web edition and comes back for the desktop one, and nothing is left running.
param(
  [Parameter(Mandatory=$true)][string]$DesktopSetup,
  [Parameter(Mandatory=$true)][string]$WebSetup
)
. (Join-Path $PSScriptRoot 'installer-harness.ps1')
$DesktopSetup=(Resolve-Path -LiteralPath $DesktopSetup).Path
$WebSetup=(Resolve-Path -LiteralPath $WebSetup).Path
$box=New-Isolation 'switch'
$install=$box.Install; $data=$box.Data
$electron=Join-Path $install 'desktop\SAP MCP Connection Manager.exe'
# The Start menu folder Inno Setup resolves can follow the isolated profile or stay the real
# one, depending on how Windows expands it for the overridden variables. The shortcut the
# last setup actually wrote is the one named in its log, so that is the one checked.
function Get-Target {
  $entry=Select-String -LiteralPath $script:LastSetupLog -Pattern 'Dest filename: (.+\.lnk)\s*$' | Select-Object -Last 1
  if(!$entry) { throw 'The setup log names no Start menu shortcut' }
  (New-Object -ComObject WScript.Shell).CreateShortcut($entry.Matches[0].Groups[1].Value.Trim())
}
try {
  New-Item -ItemType Directory -Force -Path (Join-Path $data 'certificates') | Out-Null
  [IO.File]::WriteAllText((Join-Path $data 'connections.json'),'[{"id":"DEV","url":"https://example.invalid","client":"100","user":"test","hasPassword":false,"enabled":true}]')
  [IO.File]::WriteAllText((Join-Path $data 'certificates\existing.pem'),'existing certificate sentinel')
  $before=@{}
  Get-ChildItem -LiteralPath $data -File -Recurse | ForEach-Object { $before[$_.FullName]=(Get-FileHash -LiteralPath $_.FullName).Hash }
  function Assert-DataKept([string]$When) {
    foreach($file in $before.Keys) { if((Get-FileHash -LiteralPath $file).Hash -ne $before[$file]) { throw "$When changed the person's data: $file" } }
  }

  $code=Invoke-Setup $DesktopSetup $box @('/MERGETASKS="!clients"')
  if($code -ne 0){ throw "Desktop install returned $code" }
  if(!(Test-Path -LiteralPath $electron)) { throw 'The desktop edition did not install its window' }
  if((Get-Target).TargetPath -ne $electron) { throw 'The desktop shortcut does not open the window' }

  $code=Invoke-Setup $WebSetup $box @('/MERGETASKS="!clients"')
  if($code -ne 0){ throw "Switching to the web edition returned $code" }
  Assert-DataKept 'Switching to the web edition'
  if(Test-Path -LiteralPath (Join-Path $install 'desktop')) { throw 'Switching to the web edition left Electron behind' }
  $target=Get-Target
  if($target.TargetPath -ne (Join-Path $install 'runtime\node.exe') -or $target.Arguments -notlike '*src\web.js*') { throw "The shortcut does not open the web edition: $($target.TargetPath) $($target.Arguments)" }
  Write-Output 'PASS: desktop -> web keeps the data, removes Electron and points the shortcut at the browser launcher.'

  $code=Invoke-Setup $DesktopSetup $box @('/MERGETASKS="!clients"')
  if($code -ne 0){ throw "Switching back to the desktop edition returned $code" }
  Assert-DataKept 'Switching back to the desktop edition'
  if(!(Test-Path -LiteralPath $electron)) { throw 'Switching back did not restore the window' }
  if((Get-Target).TargetPath -ne $electron) { throw 'The shortcut does not open the window again' }
  $left=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase) })
  if($left.Count) { throw "Switching left programs running: $($left.Path -join ', ')" }
  Write-Output 'PASS: web -> desktop keeps the data, restores the window and its shortcut, and leaves nothing running.'
  Invoke-Uninstall $box
} finally {
  Close-Isolation $box
}
