param([Parameter(Mandatory=$true)][string]$Install)
$ErrorActionPreference='Stop'
$info=[Diagnostics.ProcessStartInfo]::new()
$info.FileName=Join-Path $Install 'runtime\node.exe'
$entry=Join-Path $Install 'vendor\node_modules\abap-adt-mcp\dist\index.js'
$info.Arguments='"'+$entry+'"'
$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
$info.EnvironmentVariables['SAP_SYSTEMS']='{"TEST":{"url":"https://example.invalid","client":"100","user":"test","password":"fixture-only","authType":"basic","default":true,"policy":{"readOnly":true}}}'
$info.EnvironmentVariables['MCP_TOOLSETS']='core'
$process=[Diagnostics.Process]::new();$process.StartInfo=$info
try {
  [void]$process.Start()
  $stderr=$process.StandardError.ReadToEndAsync()
  $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"bridge-test","version":"1.0.0"}}}')
  function Read-Reply([int]$Id) {
    for($n=0;$n -lt 20;$n++) {
      $line=$process.StandardOutput.ReadLineAsync()
      if(!$line.Wait(15000)){throw 'Bundled MCP response timed out.'}
      if($null -eq $line.Result){throw 'Bundled MCP exited before responding.'}
      $reply=$line.Result | ConvertFrom-Json
      if($reply.id -eq $Id){if($reply.error){throw $reply.error.message};return $reply.result}
    }
    throw 'Expected MCP response was not received.'
  }
  $initialized=Read-Reply 1
  if(!$initialized.serverInfo){throw 'Missing MCP server information.'}
  $process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
  $process.StandardInput.WriteLine('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
  $catalog=Read-Reply 2
  $profile=@($catalog.tools | Where-Object {$_.name -eq 'systemProfile'})
  if($profile.Count -ne 1){throw 'The packaged MCP does not expose systemProfile.'}
  if(!$profile[0].inputSchema.properties.destination){throw 'Unexpected systemProfile destination schema.'}
  Write-Output "PASS: actual packaged MCP initializes and exposes $($catalog.tools.Count) core tools including systemProfile. No SAP request was sent."
} finally { if($process.Id -and !$process.HasExited){$process.Kill();$process.WaitForExit()};$process.Dispose() }
