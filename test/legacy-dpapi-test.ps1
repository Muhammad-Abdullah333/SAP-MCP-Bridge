$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$fixture='{"connections":[{"name":"Disabled.system","enabled":false,"config":{"url":"https://example.invalid","password":"fixture-only","policy":{"readOnly":true}}}]}'
$encrypted=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($fixture),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$result=[Convert]::ToBase64String($encrypted) | & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -File (Join-Path $PSScriptRoot '..\src\import-vault.ps1')
if($LASTEXITCODE -ne 0){throw 'Vault helper failed.'}
$decoded=$result | ConvertFrom-Json
if($decoded.connections[0].enabled -ne $false -or $decoded.connections[0].config.password -ne 'fixture-only'){throw 'Vault roundtrip changed the fixture.'}
Write-Output 'PASS: original-format Windows DPAPI vault decrypts and retains disabled connection and secret.'
