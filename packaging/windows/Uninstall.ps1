$ErrorActionPreference = 'Stop'
$install = Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'
$shortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SAP MCP Desktop Bridge.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
if ([IO.Path]::GetFullPath($install) -ne [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'))) { throw 'Unexpected install directory' }
$newShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SAP MCP Connection Manager.lnk'
if (Test-Path -LiteralPath $newShortcut) { Remove-Item -LiteralPath $newShortcut -Force }
if (Test-Path -LiteralPath $install) { Remove-Item -LiteralPath $install -Recurse -Force }
Write-Host 'SAP MCP Desktop Bridge was removed. Saved connections and credentials were kept.'
