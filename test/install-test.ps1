param([string]$Payload, [string]$SetupExe, [switch]$LegacyRegistration)
$ErrorActionPreference='Stop'
$source=Split-Path $PSScriptRoot
$root=Join-Path $source ('work\install-test-' + [Guid]::NewGuid().ToString('N'))
$env:LOCALAPPDATA=Join-Path $root 'local'
$env:APPDATA=Join-Path $root 'roaming'
$env:USERPROFILE=Join-Path $root 'home'
$env:CODEX_HOME=Join-Path $root 'codex'
$env:SAP_MCP_BRIDGE_LEGACY_HOME=Join-Path $root 'home'
$env:SAP_MCP_BRIDGE_NO_BROWSER='1'
$install=Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'
$data=Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge'
New-Item -ItemType Directory -Force -Path $install,(Join-Path $data 'certificates'),(Join-Path $data 'secrets'),(Join-Path $env:APPDATA 'Claude'),$env:CODEX_HOME | Out-Null
Set-Content -LiteralPath (Join-Path $install 'old-version.txt') -Value 'previous installation' -Encoding utf8
Set-Content -LiteralPath (Join-Path $data 'connections.json') -Value '[{"id":"DEV","url":"https://example.invalid","client":"100","user":"test","hasPassword":true,"enabled":true}]' -Encoding utf8
Set-Content -LiteralPath (Join-Path $data 'certificates\existing.pem') -Value 'existing certificate sentinel' -Encoding ascii
'{"password":"upgrade-test-only","gitPassword":"keep-test"}' | & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File (Join-Path $source 'src\windows-secret-store.ps1') -Action set -Id DEV -Store (Join-Path $data 'secrets') | Out-Null
Set-Content -LiteralPath (Join-Path $env:APPDATA 'Claude\claude_desktop_config.json') -Value '{"mcpServers":{"other":{"command":"keep"}}}' -Encoding utf8
Set-Content -LiteralPath (Join-Path $env:CODEX_HOME 'config.toml') -Value "[mcp_servers.other]`ncommand = `"keep`"" -Encoding utf8
if($LegacyRegistration) {
  $systems=Join-Path $root 'legacy-systems.json'
  [IO.File]::WriteAllText($systems,'{"DEV":{"url":"https://example.invalid","client":"100","user":"test","password":"fixture-only"}}')
  $legacy=@"
[mcp_servers.abap-adt]
command = "node"
args = ["C:/legacy/node_modules/abap-adt-mcp/dist/index.js"]
enabled = true
[mcp_servers.abap-adt.env]
SAP_SYSTEMS_FILE = '$systems'
[mcp_servers.abap-adt-mcp]
command = "node"
args = ['$install\src\host.js']
"@
  Add-Content -LiteralPath (Join-Path $env:CODEX_HOME 'config.toml') -Value $legacy -Encoding utf8
}
$before=@{}
Get-ChildItem -LiteralPath $data -File -Recurse | ForEach-Object { $before[$_.FullName]=(Get-FileHash -LiteralPath $_.FullName).Hash }
if ($SetupExe) {
  $installerProcess=Start-Process -FilePath $SetupExe -WindowStyle Hidden -Wait -PassThru
  if ($installerProcess.ExitCode -ne 0) { throw 'Isolated EXE installer failed' }
} else {
  & (Join-Path $source 'packaging\windows\Install.ps1') -Payload $Payload
  if ($LASTEXITCODE -ne 0) { throw 'Isolated installer failed' }
}
foreach($file in $before.Keys) { if ((Get-FileHash -LiteralPath $file).Hash -ne $before[$file]) { throw "Existing data was modified: $file" } }
$shortcutFile=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SAP MCP Connection Manager.lnk'
if (!(Test-Path -LiteralPath $shortcutFile)) { throw 'Searchable shortcut missing' }
$shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcutFile)
if ($shortcut.TargetPath -notlike '*desktop\SAP MCP Connection Manager.exe') { throw 'Shortcut target incorrect' }
if ($shortcut.IconLocation -notlike '*assets\bridge.ico,0') { throw 'New application icon was not assigned' }
if (Test-Path -LiteralPath (Join-Path $data 'manager.lock')) { throw 'Installer unexpectedly launched the manager' }
$report=Get-Content -Raw -LiteralPath (Join-Path $data 'client-setup.json') | ConvertFrom-Json
if (@($report.clients | Where-Object status -eq configured).Count -ne 2) { throw 'Both test clients were not configured' }
if (!(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'Claude') -Filter '*.backup-*')) { throw 'Claude backup missing' }
if (!(Get-ChildItem -LiteralPath $env:CODEX_HOME -Filter '*.backup-*')) { throw 'Codex backup missing' }
$secrets=& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File (Join-Path $install 'src\windows-secret-store.ps1') -Action get -Id DEV -Store (Join-Path $data 'secrets') | ConvertFrom-Json
if ($secrets.password -ne 'upgrade-test-only' -or $secrets.gitPassword -ne 'keep-test') { throw 'Upgrade secret preservation failed' }
[IO.File]::WriteAllText((Join-Path $source 'work\last-install-test.txt'),$root)
Write-Output 'PASS: quiet Windows upgrade, shortcut, both clients, backups, unchanged connections/certificates, and decryptable passwords.'
if($LegacyRegistration) {
  $text=Get-Content -Raw -LiteralPath (Join-Path $env:CODEX_HOME 'config.toml')
  if($text -notmatch '(?s)\[mcp_servers\.abap-adt-mcp\].*?enabled = false'){throw 'Duplicate registration was not disabled'}
  if($text -notmatch '(?s)\[mcp_servers\.SAP-Bridge\].*?host\.js'){throw 'Legacy registration did not adopt the Bridge launcher'}
  Write-Output 'PASS: actual installer migrates legacy registration to SAP-Bridge and disables duplicate while preserving saved data.'
}
