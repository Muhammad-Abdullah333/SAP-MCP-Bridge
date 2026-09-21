$ErrorActionPreference='Stop'
Start-Sleep -Seconds 3
$data=Join-Path $env:LOCALAPPDATA 'SAP MCP Desktop Bridge'
$marker=Join-Path $data 'update-rollback.json'
$record=Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
$install=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\SAP MCP Desktop Bridge'))
$previous=[IO.Path]::GetFullPath($record.previous)
if (!$previous.StartsWith($install+'.old-',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $previous)) { throw 'Previous installation is unavailable or outside the expected application folder.' }
if ([IO.Path]::GetFullPath($record.current) -ne $install) { throw 'Unexpected current application path.' }
$replaced=$install+'.replaced-'+[Guid]::NewGuid().ToString('N')
Move-Item -LiteralPath $install -Destination $replaced
try { Move-Item -LiteralPath $previous -Destination $install } catch { Move-Item -LiteralPath $replaced -Destination $install; throw }
# Keep the current data and client configurations; launcher paths are stable.
$shortcutPath=Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SAP MCP Connection Manager.lnk'
$shell=New-Object -ComObject WScript.Shell
$link=$shell.CreateShortcut($shortcutPath)
$desktop=Join-Path $install 'desktop\SAP MCP Connection Manager.exe'
if(Test-Path -LiteralPath $desktop){$link.TargetPath=$desktop;$link.Arguments=''}else{$link.TargetPath=Join-Path $env:SystemRoot 'System32\wscript.exe';$link.Arguments='"'+(Join-Path $install 'Launch Manager.vbs')+'"'}
$link.WorkingDirectory=$install;$link.Save()
if(Test-Path -LiteralPath (Join-Path $install 'assets\bridge.ico')){$link.IconLocation=(Join-Path $install 'assets\bridge.ico')+',0';$link.Save()}
Remove-Item -LiteralPath $marker -Force
