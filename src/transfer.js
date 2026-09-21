'use strict';
const crypto = require('crypto'),
  fs = require('fs'),
  path = require('path');
const paths = require('./paths'),
  storage = require('./storage'),
  secrets = require('./secrets');
const { validId } = require('./identity');
const { validate } = require('./connections');
// An exported backup carries every saved SAP password, so its passphrase is the only
// thing between a copied file and all of them. Node's scrypt defaults (N=16384) are low
// for that, so derive at a higher cost and record the parameters in the envelope: a
// later release can raise them again without another format break.
const KDF = { N: 131072, r: 8, p: 1 };
const LEGACY_KDF = { N: 16384, r: 8, p: 1 }; // what version 1 got from Node's defaults
const MAX_KDF_MEMORY = 256 * 1024 * 1024;
function kdfMemory(params) {
  return 128 * params.r * (params.N + params.p + 2) + 256;
}
function derive(password, salt, params) {
  return crypto.scryptSync(password, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: kdfMemory(params) });
}
// Bind the cost to the ciphertext. Altering it already breaks decryption, because the key
// would differ, but this makes a tampered header fail on its own terms.
function aad(version, params) {
  return Buffer.from(version === 1 ? 'SAP-MCP-BACKUP-1' : `SAP-MCP-BACKUP-2:${params.N}:${params.r}:${params.p}`);
}
function readParams(envelope) {
  if (envelope.version === 1) return LEGACY_KDF;
  const params = envelope.params;
  if (!params || typeof params !== 'object') throw new Error('Invalid backup header.');
  const { N, r, p } = params;
  // Refuse an out-of-band cost: without this an envelope could name a work factor large
  // enough to exhaust memory on import, before the passphrase is ever checked.
  const sane =
    Number.isInteger(N) &&
    N >= 16384 &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= 32 &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= 16;
  if (!sane || kdfMemory({ N, r, p }) > MAX_KDF_MEMORY)
    throw new Error('Unsupported backup key-derivation parameters.');
  return { N, r, p };
}
function seal(payload, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024)
    throw new Error('Use an export passphrase of at least 12 characters.');
  const salt = crypto.randomBytes(16),
    iv = crypto.randomBytes(12),
    params = { ...KDF },
    key = derive(password, salt, params);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(2, params));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  key.fill(0);
  return {
    format: 'SAP-MCP-BACKUP',
    version: 2,
    kdf: 'scrypt',
    params,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}
function unseal(envelope, password) {
  if (envelope?.format !== 'SAP-MCP-BACKUP' || ![1, 2].includes(envelope.version) || envelope.kdf !== 'scrypt')
    throw new Error('Unsupported encrypted backup format.');
  if (
    typeof password !== 'string' ||
    password.length > 1024 ||
    typeof envelope.data !== 'string' ||
    envelope.data.length > 32 * 1024 * 1024
  )
    throw new Error('Invalid backup or passphrase.');
  const salt = Buffer.from(envelope.salt || '', 'base64'),
    iv = Buffer.from(envelope.iv || '', 'base64'),
    tag = Buffer.from(envelope.tag || '', 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid backup header.');
  const params = readParams(envelope);
  const key = derive(password, salt, params);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(aad(envelope.version, params));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'),
    );
  } catch (_) {
    throw new Error('Incorrect passphrase or damaged backup. Nothing was imported.');
  } finally {
    key.fill(0);
  }
}
function createTransfer(store = storage, vault = secrets, dataDir = paths.dataDir) {
  function exportBackup(password) {
    const connections = JSON.parse(JSON.stringify(store.readConnections())),
      credentials = {},
      assets = {};
    for (const item of connections) {
      credentials[item.id] = vault.getSecret(item.id);
      for (const [holder, key] of [
        [item, 'ca'],
        ...['ca', 'cert', 'key', 'pfx'].map(key => [item.baseConfig?.tls, key]),
      ]) {
        if (holder === item.baseConfig?.tls && key === 'ca' && Object.hasOwn(item, 'ca')) continue;
        const value = holder?.[key];
        if (!value || typeof value !== 'string' || value.startsWith('${env:')) continue;
        if (!fs.existsSync(value))
          throw new Error(`A certificate file for ${item.id} is missing. Restore its path before exporting.`);
        const bytes = fs.readFileSync(value);
        if (bytes.length > 4 * 1024 * 1024) throw new Error('A certificate file exceeds 4 MB.');
        const id = crypto.createHash('sha256').update(bytes).digest('hex');
        assets[id] = { name: path.basename(value), content: bytes.toString('base64') };
        holder[key] = 'backup-asset:' + id;
      }
    }
    return seal({ connections, credentials, assets }, password);
  }
  function importBackup(envelope, password) {
    const payload = unseal(envelope, password);
    if (!Array.isArray(payload.connections) || !payload.credentials || !payload.assets)
      throw new Error('Invalid backup contents.');
    const all = store.readConnections(),
      seen = new Set(all.map(x => x.id.toUpperCase())),
      imported = [],
      skipped = [],
      written = [],
      warnings = [];
    // Validate every record before writing any credential or file.
    const pending = [];
    for (const original of payload.connections) {
      const item = JSON.parse(JSON.stringify(original));
      if (!validId(item.id)) throw new Error('Backup contains an invalid connection name.');
      if (seen.has(item.id.toUpperCase())) {
        skipped.push(item.id);
        continue;
      }
      seen.add(item.id.toUpperCase());
      for (const [holder, key] of [
        [item, 'ca'],
        ...['ca', 'cert', 'key', 'pfx'].map(key => [item.baseConfig?.tls, key]),
      ]) {
        if (typeof holder?.[key] !== 'string' || !holder[key].startsWith('backup-asset:')) continue;
        const id = holder[key].slice(13),
          asset = payload.assets[id];
        if (!/^[a-f0-9]{64}$/.test(id) || !asset || typeof asset.content !== 'string')
          throw new Error('Backup certificate is missing.');
        const bytes = Buffer.from(asset.content, 'base64');
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== id)
          throw new Error('Backup certificate checksum mismatch.');
        holder[key] = path.join(
          dataDir,
          'certificates',
          `${id}-${String(asset.name)
            .replace(/[^A-Za-z0-9_.-]/g, '_')
            .slice(-80)}`,
        );
        pending.push({ file: holder[key], bytes });
      }
      // A backup file is untrusted input even when its passphrase is known, because the
      // sender chose its contents. Hold every imported record to the same rules as the
      // connection form, so a backup cannot introduce an arbitrary sso2 launcher
      // executable, silently enable insecureTls, or store a malformed destination.
      // The certificate is not on disk yet, so its existence check is deferred; the path
      // itself was derived above from a checksum-verified asset.
      let checked;
      try {
        checked = validate({ ...item, ca: '' }, item);
      } catch (error) {
        throw new Error(`Backup connection ${item.id} was rejected: ${error.message} Nothing was imported.`);
      }
      checked.ca = item.ca;
      // Validation cannot reject an absolute launcher path, because the connection form
      // allows one as well. Name it instead, so importing someone else's backup cannot
      // quietly arrange for an external program to run on connect.
      if (checked.authType === 'sso2' && checked.sso2?.command)
        warnings.push(`${checked.id}: connecting runs an external ticket-provider program: ${checked.sso2.command}`);
      if (checked.insecureTls)
        warnings.push(`${checked.id}: TLS certificate verification is disabled for this connection.`);
      if (all.some(x => x.default && x.enabled !== false)) checked.default = false;
      all.push(checked);
      imported.push(checked.id);
    }
    let defaultSeen = false;
    for (const item of all) {
      if (item.default && item.enabled !== false && !defaultSeen) defaultSeen = true;
      else item.default = false;
    }
    try {
      for (const asset of pending) {
        fs.mkdirSync(path.dirname(asset.file), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(asset.file)) fs.writeFileSync(asset.file, asset.bytes, { mode: 0o600, flag: 'wx' });
      }
      for (const id of imported) {
        const previous = vault.getSecret(id);
        written.push({ id, previous });
        if (payload.credentials[id]) vault.setSecret(id, payload.credentials[id]);
      }
      store.writeConnections(all);
    } catch (error) {
      for (const { id, previous } of written.reverse()) {
        if (previous) vault.setSecret(id, previous);
        else vault.deleteSecret(id);
      }
      throw error;
    }
    return {
      imported,
      skipped,
      warnings,
      message: 'Existing connections were preserved. Imported certificate files are stored locally.',
    };
  }
  return { exportBackup, importBackup };
}
module.exports = { seal, unseal, createTransfer };
