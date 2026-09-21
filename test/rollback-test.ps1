param([Parameter(Mandatory=$true)][string]$Payload)
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot
$root=Join-Path $source ('work\rollback-test-'+[Guid]::NewGuid().ToString('N'))
$env:LOCALAPPDATA=Join-Path $root 'local';$env:APPDATA=Join-Path $root 'roaming';$env:USERPROFILE=Join-Path $root 'home';$env:CODEX_HOME=Join-Path $root 'codex';$env:SAP_MCP_BRIDGE_LEGACY_HOME=Join-Path $root 'home'
$install=Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'
$claude=Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
$codex=Join-Path $env:CODEX_HOME 'config.toml'
New-Item -ItemType Directory -Force -Path $install,(Split-Path $claude),$env:CODEX_HOME | Out-Null
Set-Content -LiteralPath (Join-Path $install 'old-version.txt') -Value 'old release' -Encoding utf8
[IO.File]::WriteAllText($claude,'{"mcpServers":{"other":{"command":"keep"}}}')
[IO.File]::WriteAllText($codex,'[deliberately invalid')
$claudeBefore=[IO.File]::ReadAllBytes($claude);$codexBefore=[IO.File]::ReadAllBytes($codex)
$marker=Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge\update-rollback.json'
New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null
[IO.File]::WriteAllText($marker,'{"previous":"existing marker sentinel"}')
$markerBefore=[IO.File]::ReadAllText($marker)
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script=Join-Path $source 'packaging\windows\Install.ps1'
$process=Start-Process -FilePath $ps -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$script+'"'),'-Payload',('"'+$Payload+'"')) -WindowStyle Hidden -Wait -PassThru -RedirectStandardError (Join-Path $root 'failure.txt')
if($process.ExitCode -eq 0){throw 'Invalid client config incorrectly reported install success.'}
if(!(Test-Path -LiteralPath (Join-Path $install 'old-version.txt'))){throw 'Previous application was not restored.'}
if([Convert]::ToBase64String([IO.File]::ReadAllBytes($claude)) -ne [Convert]::ToBase64String($claudeBefore)){throw 'Claude configuration was not restored.'}
if([Convert]::ToBase64String([IO.File]::ReadAllBytes($codex)) -ne [Convert]::ToBase64String($codexBefore)){throw 'Manual configuration changed.'}
if(Test-Path -LiteralPath (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SAP MCP Connection Manager.lnk')){throw 'Failed fresh shortcut was not removed.'}
if([IO.File]::ReadAllText($marker) -ne $markerBefore){throw 'Previous rollback marker was not restored.'}
Write-Output 'PASS: forced client-configuration failure returned an error and restored application, both configurations and shortcut state.'
