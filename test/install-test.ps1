# Upgrades an isolated 1.0.1-style installation with the real installer, silently, then
# uninstalls it. Checks: saved data untouched, passwords saved by the old PowerShell helper
# still decrypt in the new app, both clients connected with backups, the Start menu
# shortcut, the Settings > Apps entry, no scripts left in the app, earlier copies removed,
# the packaged MCP server starts, and uninstalling keeps the person's data.
param([Parameter(Mandatory=$true)][string]$SetupExe, [switch]$LegacyRegistration)
. (Join-Path $PSScriptRoot 'installer-harness.ps1')
$SetupExe=(Resolve-Path -LiteralPath $SetupExe).Path
$version=(Get-Content -Raw -LiteralPath (Join-Path $Source 'package.json') | ConvertFrom-Json).version
$box=New-Isolation 'install'
$install=$box.Install; $data=$box.Data
try {
  # --- what a 1.0.1 installation left behind ----------------------------------------
  New-Item -ItemType Directory -Force -Path $install,(Join-Path $data 'certificates'),(Join-Path $data 'secrets'),(Join-Path $env:APPDATA 'Claude') | Out-Null
  foreach($old in 'Launch Manager.vbs','SAP MCP Desktop Bridge.cmd','Uninstall.ps1','Rollback.ps1') { [IO.File]::WriteAllText((Join-Path $install $old),'earlier version') }
  $earlierCopy=$install+'.old-0123456789abcdef'
  New-Item -ItemType Directory -Force -Path (Join-Path $earlierCopy 'src') | Out-Null
  [IO.File]::WriteAllText((Join-Path $earlierCopy 'Launch Manager.vbs'),'earlier copy')
  [IO.File]::WriteAllText((Join-Path $data 'connections.json'),'[{"id":"DEV","url":"https://example.invalid","client":"100","user":"test","hasPassword":true,"enabled":true}]')
  [IO.File]::WriteAllText((Join-Path $data 'certificates\existing.pem'),'existing certificate sentinel')
  [IO.File]::WriteAllBytes((Join-Path $data 'secrets\DEV.bin'),(Protect-Text '{"password":"upgrade-test-only","gitPassword":"keep-test"}'))
  [IO.File]::WriteAllText((Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'),'{"mcpServers":{"other":{"command":"keep"}}}')
  [IO.File]::WriteAllText((Join-Path $env:CODEX_HOME 'config.toml'),"[mcp_servers.other]`ncommand = `"keep`"`n")
  if($LegacyRegistration) {
    $systems=Join-Path $box.Root 'legacy-systems.json'
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
    [IO.File]::AppendAllText((Join-Path $env:CODEX_HOME 'config.toml'),$legacy)
  }
  $before=@{}
  Get-ChildItem -LiteralPath $data -File -Recurse | ForEach-Object { $before[$_.FullName]=(Get-FileHash -LiteralPath $_.FullName).Hash }

  # --- upgrade ------------------------------------------------------------------------
  $code=Invoke-Setup $SetupExe $box
  if($code -ne 0){ throw "Silent install returned $code" }
  foreach($file in $before.Keys) { if((Get-FileHash -LiteralPath $file).Hash -ne $before[$file]) { throw "Existing data was modified: $file" } }
  $shortcutFile=Join-Path ([Environment]::GetFolderPath('Programs')) 'SAP MCP Connection Manager.lnk'
  if(!(Test-Path -LiteralPath $shortcutFile)) { throw 'Start menu shortcut missing' }
  $shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($shortcutFile)
  if($shortcut.TargetPath -ne (Join-Path $install 'desktop\SAP MCP Connection Manager.exe')) { throw "Shortcut target incorrect: $($shortcut.TargetPath)" }
  if($shortcut.IconLocation -notlike '*assets\bridge.ico,0') { throw 'Shortcut icon was not assigned' }
  if(Test-Path -LiteralPath (Join-Path $data 'manager.lock')) { throw 'A silent install launched the manager' }
  $report=Get-Content -Raw -LiteralPath (Join-Path $data 'client-setup.json') | ConvertFrom-Json
  if(@($report.clients | Where-Object status -eq configured).Count -ne 2) { throw 'Both test clients were not configured' }
  if(!(Get-ChildItem -LiteralPath (Join-Path $env:APPDATA 'Claude') -Filter '*.backup-*')) { throw 'Claude backup missing' }
  if(!(Get-ChildItem -LiteralPath $env:CODEX_HOME -Filter '*.backup-*')) { throw 'Codex backup missing' }
  $secret=Invoke-InstalledNode $box "process.stdout.write(JSON.stringify(require(process.argv[2]).getSecret('DEV')))" @((Join-Path $install 'src\secrets.js')) | ConvertFrom-Json
  if($secret.password -ne 'upgrade-test-only' -or $secret.gitPassword -ne 'keep-test') { throw 'A password saved by the earlier version did not decrypt' }
  $scripts=@(Get-ChildItem -LiteralPath $install -Recurse -File | Where-Object { @('.vbs','.cmd','.bat','.ps1','.psm1') -contains $_.Extension.ToLowerInvariant() })
  if($scripts.Count) { throw "Scripts in the installed app: $($scripts.FullName -join ', ')" }
  if(Test-Path -LiteralPath $earlierCopy) { throw 'The earlier copy kept by 1.0.1 was not removed' }
  $entry=Get-ItemProperty -LiteralPath $UninstallKey
  if($entry.DisplayVersion -ne $version -or $entry.DisplayName -ne 'SAP MCP Desktop Bridge' -or $entry.Publisher -ne 'Muhammad Abdullah') { throw 'Settings > Apps entry is wrong' }
  $exe=(Get-Item -LiteralPath (Join-Path $install 'desktop\SAP MCP Connection Manager.exe')).VersionInfo
  if($exe.OriginalFilename -ne 'SAP MCP Connection Manager.exe' -or $exe.CompanyName -ne 'Muhammad Abdullah') { throw 'The app executable does not carry its own details' }
  $setupInfo=(Get-Item -LiteralPath $SetupExe).VersionInfo
  # Inno Setup pads its version strings; Windows shows them trimmed.
  if($setupInfo.CompanyName.TrimEnd([char]0,' ') -ne 'Muhammad Abdullah') { throw 'The installer does not name its publisher' }
  Write-Output 'PASS: silent upgrade keeps data and old-format passwords, connects both clients with backups, adds shortcut and Settings > Apps entry, removes old scripts and earlier copies.'
  if($LegacyRegistration) {
    $text=Get-Content -Raw -LiteralPath (Join-Path $env:CODEX_HOME 'config.toml')
    if($text -notmatch '(?s)\[mcp_servers\.abap-adt-mcp\].*?enabled = false'){throw 'Duplicate registration was not disabled'}
    if($text -notmatch '(?s)\[mcp_servers\.SAP-Bridge\].*?host\.js'){throw 'Legacy registration did not adopt the Bridge launcher'}
    Write-Output 'PASS: the installer migrates the legacy registration to SAP-Bridge and disables the duplicate.'
  }
  & (Join-Path $PSScriptRoot 'mcp-runtime-test.ps1') -Install $install

  # --- uninstall ----------------------------------------------------------------------
  Invoke-Uninstall $box
  if(Test-Path -LiteralPath (Join-Path $install 'desktop')) { throw 'The uninstaller left the app in place' }
  if(Test-Path -LiteralPath $shortcutFile) { throw 'The uninstaller left the Start menu shortcut' }
  foreach($file in $before.Keys) { if((Get-FileHash -LiteralPath $file).Hash -ne $before[$file]) { throw "Uninstall changed saved data: $file" } }
  Write-Output 'PASS: uninstall removes the app, shortcut and Settings > Apps entry and keeps connections, certificates and passwords.'
} finally {
  Close-Isolation $box
}
