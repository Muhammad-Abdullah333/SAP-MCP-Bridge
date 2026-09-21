'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

function importCertificate(input) {
  if (!/\.(pem|crt|cer)$/i.test(String(input.name || ''))) throw new Error('Choose a .pem, .crt, or .cer certificate.');
  if (typeof input.content !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content))
    throw new Error('Invalid certificate upload.');
  const bytes = Buffer.from(input.content, 'base64');
  if (!bytes.length || bytes.length > 512 * 1024) throw new Error('Certificate must be between 1 byte and 512 KB.');
  const text = bytes.toString('utf8');
  if (/PRIVATE KEY/.test(text)) throw new Error('Choose a public CA certificate, not a private key.');
  let pem;
  try {
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    pem = blocks
      ? blocks.map(block => new crypto.X509Certificate(block).toString()).join('\n')
      : new crypto.X509Certificate(bytes).toString();
  } catch (_) {
    throw new Error('This file does not contain a valid X.509 certificate.');
  }
  const directory = path.join(paths.dataDir, 'certificates');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name =
    String(input.name)
      .replace(/\.[^.]*$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 60) || 'certificate';
  const digest = crypto.createHash('sha256').update(pem).digest('hex');
  const file = path.join(directory, `${name}-${digest.slice(0, 16)}.pem`);
  fs.writeFileSync(file, `${pem.trim()}\n`, { mode: 0o600, flag: 'w' });
  return { path: file, name: path.basename(file) };
}
module.exports = { importCertificate };
