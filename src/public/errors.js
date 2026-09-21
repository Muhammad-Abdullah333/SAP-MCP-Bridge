'use strict';
function explainError(message) {
  const text = String(message || 'Unexpected error');
  const rules = [
    // null keeps the original message: it already names the exact entry that is wrong,
    // and generic advice would hide the one fact the user needs in order to fix it.
    [/^(Allowed|Denied) (packages|tables|tools|transports):/i, null, 'guide-policy'],
    [/safety level between/i, null, 'guide-policy'],
    [
      /Enter the passphrase used to create this backup/i,
      'Enter the passphrase used to create this backup, then choose Import encrypted backup.',
      'guide-backup',
    ],
    [
      /passphrase.*(12|at least)/i,
      'Choose a backup passphrase of at least 12 characters, then export again.',
      'guide-backup',
    ],
    [
      /Unauthorized request/i,
      'The local Bridge session could not be verified. Close and reopen the manager, then retry.',
      'guide-troubleshooting',
    ],
    [
      /password.*required|credentials are missing|password is missing/i,
      'Enter the SAP password for this connection and save it. For SSO, select the matching authentication method.',
      'guide-login',
    ],
    [
      /401|unauthorized|incorrect.*password|invalid.*credentials|authentication failed/i,
      'SAP did not accept the sign-in. Check the username, password and SAP client; ask Basis whether the account is locked or expired.',
      'guide-login',
    ],
    [
      /403|forbidden|not authorized|authorization failed/i,
      'SAP refused this operation. Your account may lack the required ADT or object permissions. Ask SAP Basis to check authorizations.',
      'guide-login',
    ],
    [
      /certificate.*(file|upload|X.509|512|private key)|Choose a .*pem|public CA certificate|invalid.*certificate/i,
      'Choose a valid public X.509 certificate (.pem, .crt or .cer). Renaming another file does not convert it. Private keys are not accepted.',
      'guide-tls',
    ],
    [
      /TLS|SSL|CERT_|self.signed|certificate|unable to verify|issuer/i,
      'The secure connection could not be verified. Check the HTTPS host, certificate validity and trusted CA chain with Basis. Keep TLS verification enabled.',
      'guide-tls',
    ],
    [
      /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timed out|ECONNRESET|network|fetch failed/i,
      'The server could not be reached or did not respond in time. Check the HTTPS address, VPN, firewall and SAP availability. SSO may require completing browser sign-in.',
      'guide-url',
    ],
    [
      /policy:|policyDenied/i,
      'A configured safety policy blocked this operation. Review the policy with its owner; retrying the same request will not override it.',
      'guide-policy',
    ],
    [
      /secure storage|keychain|DPAPI/i,
      'Bridge could not access secure credential storage. Use the Windows/macOS account that saved the connection and check operating-system access prompts.',
      'guide-login',
    ],
    [
      /passphrase|decrypt|backup|authenticate data/i,
      'The backup could not be processed. Use the original backup passphrase and an intact encrypted Bridge backup file.',
      'guide-backup',
    ],
    [
      /configuration|TOML|JSON|MCP|launcher|spawn|EPERM|ENOENT/i,
      'Check the installed MCP client, its configuration and file permissions. Review Logs for details, then follow the client setup steps.',
      'guide-clients',
    ],
  ];
  const found = rules.find(([pattern]) => pattern.test(text));
  return {
    message: found
      ? (found[1] ?? text)
      : 'The operation could not be completed. Review Logs for the technical details and follow the Setup Guide.',
    section: found ? found[2] : 'guide-troubleshooting',
  };
}
