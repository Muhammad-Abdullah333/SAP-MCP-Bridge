# When Claude Desktop or Codex cannot be connected, the app still installs, every client's
# settings stay exactly as they were, and the installer says why and what to do: exit code
# 10 and %TEMP%\sap-mcp-bridge-install-error.log for a silent install. When neither client
# is found it says how to connect one later. /MERGETASKS=!clients installs without touching
# the clients at all.
param([Parameter(Mandatory=$true)][string]$SetupExe)
. (Join-Path $PSScriptRoot 'installer-harness.ps1')
$SetupExe=(Resolve-Path -LiteralPath $SetupExe).Path
$box=New-Isolation 'clients'
$errorLog=Join-Path ([IO.Path]::GetTempPath()) 'sap-mcp-bridge-install-error.log'
$started=Get-Date
try {
  $claude=Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
  $codex=Join-Path $env:CODEX_HOME 'config.toml'
  New-Item -ItemType Directory -Force -Path (Split-Path $claude) | Out-Null
  [IO.File]::WriteAllText($claude,'{"mcpServers":{"other":{"command":"keep"}}}')
  [IO.File]::WriteAllText($codex,'[deliberately invalid')
  $claudeBefore=(Get-FileHash -LiteralPath $claude).Hash; $codexBefore=(Get-FileHash -LiteralPath $codex).Hash

  # --- one client cannot be connected --------------------------------------------------
  $code=Invoke-Setup $SetupExe $box
  if($code -ne 10){ throw "Expected exit code 10 for a failed client setup, got $code" }
  if(!(Test-Path -LiteralPath (Join-Path $box.Install 'desktop\SAP MCP Connection Manager.exe'))) { throw 'The app was not installed' }
  if((Get-FileHash -LiteralPath $claude).Hash -ne $claudeBefore) { throw 'Claude configuration was not restored' }
  if((Get-FileHash -LiteralPath $codex).Hash -ne $codexBefore) { throw 'The invalid Codex configuration was changed' }
  if(!(Test-Path -LiteralPath $errorLog) -or (Get-Item -LiteralPath $errorLog).LastWriteTime -lt $started) { throw 'No install error log was written' }
  $text=[IO.File]::ReadAllText($errorLog)
  if($text -notmatch "Codex's settings file \(config\.toml\) contains a mistake") { throw "The install error log does not say what is wrong: $text" }
  if($text -notmatch 'Claude Desktop: Not changed, because setup failed for another client') { throw "The install error log does not explain the other client: $text" }
  $report=Get-Content -Raw -LiteralPath (Join-Path $box.Data 'client-setup.json') | ConvertFrom-Json
  if(!($report.clients | Where-Object { $_.client -eq 'ChatGPT/Codex' -and $_.advice -match 'config\.toml' })) { throw 'client-setup.json carries no advice for the manager' }
  Write-Output 'PASS: a client that cannot be connected leaves every client setting unchanged, still installs the app, returns exit code 10, and says what is wrong and how to fix it.'

  # --- the clients task switched off ------------------------------------------------------
  [IO.File]::WriteAllText($claude,'{"mcpServers":{"other":{"command":"keep"}}}')
  $claudeBefore=(Get-FileHash -LiteralPath $claude).Hash
  $code=Invoke-Setup $SetupExe $box @('/MERGETASKS="!clients"')
  if($code -ne 0){ throw "Install without client setup returned $code" }
  if((Get-FileHash -LiteralPath $claude).Hash -ne $claudeBefore -or (Get-FileHash -LiteralPath $codex).Hash -ne $codexBefore) { throw '/MERGETASKS=!clients still changed client settings' }
  Write-Output 'PASS: /MERGETASKS=!clients installs without touching Claude Desktop or Codex.'

  # --- neither client on this computer ----------------------------------------------------
  # Detection also looks on PATH and in Program Files; point both somewhere empty.
  Remove-Item -LiteralPath $claude,$codex -Force
  $env:PATH=Join-Path $env:SystemRoot 'System32'
  $env:ProgramFiles=Join-Path $box.Root 'programs'
  $code=Invoke-Setup $SetupExe $box @('/MERGETASKS="clients"')
  if($code -ne 0){ throw "Install with no client present returned $code" }
  if((Test-Path -LiteralPath $claude) -or (Test-Path -LiteralPath $codex)) { throw 'Client settings were created although no client is installed' }
  if(!(Select-String -LiteralPath $LastSetupLog -SimpleMatch 'Claude Desktop and Codex were not found on this computer' -Quiet)) { throw 'Setup did not say that no client was found' }
  Write-Output 'PASS: with neither client installed, setup succeeds and says how to connect one later.'
  Invoke-Uninstall $box
} finally {
  if((Test-Path -LiteralPath $errorLog) -and (Get-Item -LiteralPath $errorLog).LastWriteTime -ge $started) { Remove-Item -LiteralPath $errorLog -Force }
  Close-Isolation $box
}
