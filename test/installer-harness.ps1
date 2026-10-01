# Shared by the installer tests (dot-source it). Each test runs the real Setup.exe silently
# into its own folder under work\, with LOCALAPPDATA, APPDATA, USERPROFILE and CODEX_HOME
# pointed there too, so the client setup the installer runs only ever sees test files.
#
# Two things Inno Setup writes do not follow those variables: the Start menu shortcut and
# the Settings > Apps entry (HKCU). Both are saved before a test and put back afterwards,
# so running the tests on a machine with the Bridge installed leaves that installation as
# it was. ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
$ErrorActionPreference='Stop'
$script:Source=Split-Path $PSScriptRoot
$script:UninstallKey='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{617F7CBA-3930-4F96-865D-CB8035F2A406}_is1'
$script:Shortcuts=@('SAP MCP Connection Manager.lnk','SAP MCP Desktop Bridge.lnk') | ForEach-Object { Join-Path ([Environment]::GetFolderPath('Programs')) $_ }

function New-Isolation([string]$Name) {
  # Short on purpose: the deepest installed file is about 126 characters below the install
  # folder, and Windows refuses paths over 260 characters.
  $root=Join-Path $script:Source ('work\'+$Name+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
  $env:LOCALAPPDATA=Join-Path $root 'local'
  $env:APPDATA=Join-Path $root 'roaming'
  $env:USERPROFILE=Join-Path $root 'home'
  $env:CODEX_HOME=Join-Path $root 'codex'
  $env:SAP_MCP_BRIDGE_LEGACY_HOME=Join-Path $root 'home'
  $env:SAP_MCP_BRIDGE_NO_BROWSER='1'
  New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA,$env:APPDATA,$env:USERPROFILE,$env:CODEX_HOME | Out-Null
  [pscustomobject]@{
    Root=$root
    Install=Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'
    Data=Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge'
    Saved=Save-UserState $root
  }
}

function Save-UserState([string]$Root) {
  $saved=@{ Shortcuts=@{}; Key=$null }
  foreach($file in $script:Shortcuts){ if(Test-Path -LiteralPath $file){ $saved.Shortcuts[$file]=[IO.File]::ReadAllBytes($file) } }
  if(Test-Path -LiteralPath $script:UninstallKey) {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    $saved.Key=Join-Path $Root 'uninstall-key.reg'
    & reg.exe export ($script:UninstallKey -replace '^HKCU:','HKCU') $saved.Key /y | Out-Null
    if($LASTEXITCODE -ne 0){ throw 'Could not save the existing Settings > Apps entry; nothing was changed.' }
  }
  $saved
}

function Restore-UserState($Saved) {
  foreach($file in $script:Shortcuts) {
    if($Saved.Shortcuts.ContainsKey($file)) { [IO.File]::WriteAllBytes($file,$Saved.Shortcuts[$file]) }
    elseif(Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
  }
  if(Test-Path -LiteralPath $script:UninstallKey) { Remove-Item -LiteralPath $script:UninstallKey -Recurse -Force }
  if($Saved.Key) { & reg.exe import $Saved.Key 2>$null | Out-Null }
}

function Invoke-Setup([string]$SetupExe,$Box,[string[]]$Extra=@()) {
  # Written straight to work\setup-logs, which CI keeps even when a run is cancelled.
  $logs=Join-Path $script:Source 'work\setup-logs'
  New-Item -ItemType Directory -Force -Path $logs | Out-Null
  $log=Join-Path $logs ((Split-Path $Box.Root -Leaf)+'-setup-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.log')
  $arguments=@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="'+$Box.Install+'"'),('/LOG="'+$log+'"'))+$Extra
  $script:LastSetupLog=$log
  # A silent install takes well under a minute; one still running after five has hung.
  # Fail with the end of its log instead of waiting for the CI job to time out.
  $process=Start-Process -FilePath $SetupExe -ArgumentList $arguments -PassThru
  $null=$process.Handle  # keeps ExitCode readable once the process has ended
  if(!$process.WaitForExit(300000)) {
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like ([IO.Path]::GetFileNameWithoutExtension($SetupExe)+'*') } | Stop-Process -Force -ErrorAction SilentlyContinue
    $tail=if(Test-Path -LiteralPath $log){ (Get-Content -LiteralPath $log -Tail 25) -join "`n" } else { '(no setup log)' }
    throw "Setup did not finish within five minutes. End of its log:`n$tail"
  }
  $process.ExitCode
}

function Invoke-Uninstall($Box) {
  $uninstaller=Join-Path $Box.Install 'unins000.exe'
  if(!(Test-Path -LiteralPath $uninstaller)) { throw 'The installer did not register an uninstaller.' }
  $process=Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -PassThru
  if(!$process.WaitForExit(120000)) { throw 'The uninstaller did not finish within two minutes.' }
  # The uninstaller hands over to a copy of itself in %TEMP%, so wait for its work instead.
  foreach($attempt in 1..240) {
    if(!(Test-Path -LiteralPath $script:UninstallKey) -and !(Test-Path -LiteralPath $uninstaller)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'The uninstaller did not finish within two minutes.'
}

function Stop-Isolated($Box) {
  # Only ever stops processes started from this test's own install folder.
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($Box.Install+'\',[StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}

function Close-Isolation($Box) {
  Stop-Isolated $Box
  Start-Sleep -Milliseconds 500
  Restore-UserState $Box.Saved
  Remove-Item -LiteralPath $Box.Root -Recurse -Force -ErrorAction SilentlyContinue
}

function Protect-Text([string]$Text) {
  Add-Type -AssemblyName System.Security
  [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($Text),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
}

# Runs JavaScript with the installed runtime, from a file: Windows PowerShell 5.1 mangles
# double quotes in arguments to native programs.
function Invoke-InstalledNode($Box,[string]$Code,[string[]]$Arguments=@()) {
  $file=Join-Path $Box.Root ('check-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.js')
  [IO.File]::WriteAllText($file,$Code)
  $output=& (Join-Path $Box.Install 'runtime\node.exe') $file @Arguments
  if($LASTEXITCODE -ne 0){ throw "Installed runtime check failed: $output" }
  $output
}
