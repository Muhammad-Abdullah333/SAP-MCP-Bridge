# Secrets and vaults written by .NET's ProtectedData (what versions before 1.0.2 used, through
# PowerShell) must decrypt with src/dpapi.js, and what src/dpapi.js writes must decrypt with
# .NET, so an update keeps every saved password and a downgrade still reads new ones.
# ASCII only: Windows PowerShell 5.1 reads a BOM-less script as ANSI.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$source=Split-Path $PSScriptRoot
$root=Join-Path $env:TEMP ('bridge-dpapi-test-'+[Guid]::NewGuid().ToString('N'))
$env:LOCALAPPDATA=$root
$store=Join-Path $root 'SAP MCP Desktop Bridge\secrets'
New-Item -ItemType Directory -Force -Path $store | Out-Null
$u=[string][char]0x00FC
function Protect([string]$Text){[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($Text),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)}
function Unprotect([byte[]]$Data){[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($Data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))}
try {
  # Original-format vault (base64 of DPAPI bytes), as "Choose original vault" reads it.
  $vault=Join-Path $root 'connections.protected'
  [IO.File]::WriteAllText($vault,[Convert]::ToBase64String((Protect ('{"connections":[{"name":"Disabled.system","enabled":false,"config":{"url":"https://example.invalid","password":"fixture-only-'+$u+'","policy":{"readOnly":true}}}]}'))))
  # A saved secret exactly as windows-secret-store.ps1 wrote it.
  [IO.File]::WriteAllBytes((Join-Path $store 'OLD.bin'),(Protect ('{"password":"old-format-'+$u+'","gitPassword":"keep"}')))
  $check=Join-Path $root 'check.js'
  [IO.File]::WriteAllText($check,@'
const assert = require('assert');
const fs = require('fs');
const [src, vault] = process.argv.slice(2);
const legacy = require(src + '/legacy-vault.js');
const entries = legacy.decode(fs.readFileSync(vault, 'utf8'));
assert.equal(entries['Disabled.system'].enabled, false);
assert.equal(entries['Disabled.system'].password, 'fixture-only-\u00fc');
assert.throws(() => legacy.decode('bm90IGRwYXBp'), /Could not decrypt the legacy vault/);
const secrets = require(src + '/secrets.js');
assert.deepEqual(secrets.getSecret('OLD'), { password: 'old-format-\u00fc', gitPassword: 'keep' });
secrets.setSecret('NEW', { password: 'new-format-\u00fc' });
assert.equal(secrets.getSecret('MISSING'), null);
secrets.deleteSecret('OLD');
assert.equal(secrets.getSecret('OLD'), null);
'@)
  & node $check (Join-Path $source 'src') $vault
  if($LASTEXITCODE -ne 0){throw 'Node-side DPAPI checks failed.'}
  $written=Unprotect ([IO.File]::ReadAllBytes((Join-Path $store 'NEW.bin')))
  if(($written | ConvertFrom-Json).password -ne ('new-format-'+$u)){throw 'A secret written by src/dpapi.js does not decrypt with .NET.'}
  if(Get-ChildItem -LiteralPath $store -Filter '*.tmp'){throw 'A temporary secret file was left behind.'}
  Write-Output 'PASS: .NET-written secrets and original vaults decrypt in-process, in-process secrets decrypt with .NET, and nothing runs PowerShell.'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
