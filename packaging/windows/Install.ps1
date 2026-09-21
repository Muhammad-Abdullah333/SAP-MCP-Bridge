param([string]$Payload = (Join-Path $PSScriptRoot 'payload.zip'), [switch]$ShowSuccess, [switch]$Launch)
$ErrorActionPreference = 'Stop'
$install = Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'
$stage = Join-Path $env:TEMP ('sap-mcp-bridge-install-' + [Guid]::NewGuid().ToString('N'))
$old = $null
$placed = $false
$marker = Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge\update-rollback.json'
$markerBytes = if(Test-Path -LiteralPath $marker) { [IO.File]::ReadAllBytes($marker) } else { $null }
$markerChanged = $false
$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SAP MCP Connection Manager.lnk'
$shortcutBytes = if(Test-Path -LiteralPath $shortcutPath) { [IO.File]::ReadAllBytes($shortcutPath) } else { $null }
try {
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar)) { throw 'The Windows archive tool (tar.exe) is unavailable.' }
  & $tar -xf $Payload -C $stage
  if ($LASTEXITCODE -ne 0) { throw 'The installer payload could not be extracted.' }
  $payloadApp = Join-Path $stage 'app'
  foreach ($required in @('runtime\node.exe','src\manager.js','src\host.js','src\configure-cli.js','vendor\node_modules\abap-adt-mcp\dist\index.js','desktop\SAP MCP Connection Manager.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $payloadApp $required))) { throw "Installer payload is incomplete: $required" }
  }
  $managerLock = Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge\manager.lock'
  if (Test-Path -LiteralPath $managerLock) {
    try {
      $raw = Get-Content -Raw -LiteralPath $managerLock
      $managerPid = if ($raw.Trim().StartsWith('{')) { [int](ConvertFrom-Json $raw).pid } else { [int]$raw }
      $running = Get-Process -Id $managerPid -ErrorAction SilentlyContinue
      if ($running -and $running.Path -and $running.Path.StartsWith($install + '\',[StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $managerPid -Force
        [void]$running.WaitForExit(5000)
      }
    } catch {}
    Remove-Item -LiteralPath $managerLock -Force -ErrorAction SilentlyContinue
  }
  $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'))
  if ([IO.Path]::GetFullPath($install) -ne $expected) { throw 'Unexpected installation directory.' }
  if (Test-Path -LiteralPath $install) {
    $old = $install + '.old-' + [Guid]::NewGuid().ToString('N')
    Move-Item -LiteralPath $install -Destination $old
  }
  New-Item -ItemType Directory -Path (Split-Path $install) -Force | Out-Null
  Move-Item -LiteralPath $payloadApp -Destination $install
  $placed = $true
  $shortcutDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  New-Item -ItemType Directory -Path $shortcutDir -Force | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut((Join-Path $shortcutDir 'SAP MCP Connection Manager.lnk'))
  $shortcut.TargetPath = Join-Path $install 'desktop\SAP MCP Connection Manager.exe'
  $shortcut.Arguments = ''
  $shortcut.WorkingDirectory = $install
  $shortcut.Description = 'SAP MCP Connection Manager — manage Bridge connections and certificates'
  $shortcut.IconLocation = (Join-Path $install 'assets\bridge.ico') + ',0'
  $shortcut.Save()
  if($old) {
    $data = Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge'
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    $markerChanged = $true
    @{previous=$old;current=$install;installedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
  }
  # Client configuration is the final fallible step; it rolls itself back on failure.
  & (Join-Path $install 'runtime\node.exe') (Join-Path $install 'src\configure-cli.js') --transactional | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Client setup failed. Client settings and the previous application have been restored where possible. See client-setup.json in the Bridge data folder.' }
} catch {
  if ($placed -and (Test-Path -LiteralPath $install)) {
      $failed = $install + '.failed-' + [Guid]::NewGuid().ToString('N')
      Move-Item -LiteralPath $install -Destination $failed
  }
  if ($old -and (Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $install)) { Move-Item -LiteralPath $old -Destination $install }
  if ($null -ne $shortcutBytes) { [IO.File]::WriteAllBytes($shortcutPath,$shortcutBytes) } elseif(Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
  if ($markerChanged) { if($null -ne $markerBytes) { [IO.File]::WriteAllBytes($marker,$markerBytes) } elseif(Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force } }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if ([IO.Path]::GetFullPath($stage).StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
# Installing always opens the manager. An upgrade stops a running one as part of its
# work, so reopening it hands back what the installer just took away rather than
# imposing a window. $old is set only when an existing installation was moved aside,
# which is used for the wording rather than for whether to open anything.
$firstInstall = $null -eq $old
if($ShowSuccess) {
  Add-Type -AssemblyName System.Windows.Forms
  $message = if($firstInstall -and $Launch) { "SAP MCP Bridge successfully installed!`n`nOpening SAP MCP Connection Manager now. You can start it any time from the Windows Start menu." }
             elseif($firstInstall) { "SAP MCP Bridge successfully installed!`n`nOpen SAP MCP Connection Manager from the Windows Start menu when you are ready." }
             else { "SAP MCP Bridge successfully updated!`n`nOpen SAP MCP Connection Manager from the Windows Start menu when you are ready." }
  [void][Windows.Forms.MessageBox]::Show($message,'Installation complete',[Windows.Forms.MessageBoxButtons]::OK,[Windows.Forms.MessageBoxIcon]::Information)
}
if($Launch) {
  $app = Join-Path $install 'desktop\SAP MCP Connection Manager.exe'
  # Failing to open the window is not a failed installation, so this never throws.
  if(Test-Path -LiteralPath $app) { try { Start-Process -FilePath $app | Out-Null } catch {} }
}
