param()
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
try {
  $protected=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
  [Console]::Write([Text.Encoding]::UTF8.GetString($plain))
} catch { [Console]::Error.WriteLine('This vault can only be imported on Windows under the original Windows account.'); exit 1 }
