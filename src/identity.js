'use strict';
const crypto = require('crypto');
function validId(id) {
  return (
    typeof id === 'string' && /^[A-Za-z0-9_.-]+$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id)
  );
}
function key(id) {
  if (!validId(id)) throw new Error('Use letters, numbers, dots, underscores or hyphens for the connection name.');
  return /^[A-Z0-9_-]{1,32}$/.test(id)
    ? id
    : 'X' + crypto.createHash('sha256').update(id.toUpperCase()).digest('hex').toUpperCase();
}
module.exports = { validId, key };
