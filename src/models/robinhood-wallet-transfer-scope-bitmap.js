'use strict';
const { createHash } = require('node:crypto');
const MAX_DICTIONARY = 1000000;
const MAX_TOKENS = 500000;
function dictionaryIndex(dictionary) {
  if (!Array.isArray(dictionary) || dictionary.length > MAX_DICTIONARY) throw new Error('invalid scope dictionary');
  const addresses = new Map(); const ordinals = new Set(); let size = 0;
  for (const { token_address: token, ordinal } of dictionary) {
    if (!/^0x[0-9a-f]{40}$/.test(token) || !Number.isInteger(ordinal) || ordinal < 0
      || ordinal >= MAX_DICTIONARY || addresses.has(token) || ordinals.has(ordinal)) {
      throw new Error('invalid scope dictionary entry');
    }
    addresses.set(token, ordinal); ordinals.add(ordinal); size = Math.max(size, ordinal + 1);
  }
  return { addresses, size };
}
function scopeHash(tokens) {
  if (!Array.isArray(tokens) || !tokens.length || tokens.length > MAX_TOKENS
    || tokens.some((token, i) => !/^0x[0-9a-f]{40}$/.test(token) || (i && tokens[i - 1] >= token))) {
    throw new Error('invalid normalized scope tokens');
  }
  return createHash('sha256').update(tokens.join('\n')).digest('hex');
}
function encodeScopeBitmap(tokens, dictionary) {
  const hash = scopeHash(tokens);
  const { addresses, size } = dictionaryIndex(dictionary);
  const bitmap = Buffer.alloc(Math.ceil(size / 8));
  for (const token of tokens) {
    const ordinal = addresses.get(token);
    if (ordinal == null) throw new Error('scope token missing from dictionary');
    bitmap[ordinal >> 3] |= 1 << (ordinal & 7);
  }
  return { bitmap, dictionarySize: size, tokenCount: tokens.length, scopeHash: hash };
}
function decodeScopeBitmap(scope, dictionary) {
  const { bitmap, dictionarySize: size, tokenCount, scopeHash: hash } = scope;
  if (!Buffer.isBuffer(bitmap) || !Number.isInteger(size) || size < 1 || size > MAX_DICTIONARY
    || bitmap.length !== Math.ceil(size / 8) || !Number.isInteger(tokenCount)
    || tokenCount < 1 || tokenCount > MAX_TOKENS || !/^[0-9a-f]{64}$/.test(hash)
    || (size % 8 && bitmap.at(-1) >= 2 ** (size % 8))) throw new Error('invalid scope bitmap');
  const { addresses } = dictionaryIndex(dictionary);
  const tokens = [...addresses].filter(([, id]) => id < size && (bitmap[id >> 3] & (1 << (id & 7))))
    .map(([token]) => token).sort();
  let bits = 0; for (let byte of bitmap) while (byte) { byte &= byte - 1; bits++; }
  if (bits !== tokenCount || tokens.length !== tokenCount || scopeHash(tokens) !== hash) {
    throw new Error('scope bitmap hash or membership mismatch');
  }
  return tokens;
}
// Fixed SQL aliases used by offline consumers; arrays remain authoritative during staging.
const SCOPE_TOKENS_SQL = `COALESCE(s.token_addresses,t.token_addresses,
  CASE WHEN t.scope_bitmap IS NOT NULL THEN ARRAY(
    SELECT d.token_address::text FROM robinhood_wallet_transfer_scope_dictionary d
    WHERE d.chain=t.chain AND CASE WHEN d.ordinal<t.dictionary_size
      THEN get_bit(t.scope_bitmap,d.ordinal)=1 ELSE false END ORDER BY d.token_address
  ) END)`;
module.exports = { encodeScopeBitmap, decodeScopeBitmap, SCOPE_TOKENS_SQL };
