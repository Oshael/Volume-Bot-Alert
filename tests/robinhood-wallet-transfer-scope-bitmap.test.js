const assert = require('node:assert/strict');
const { test } = require('node:test');
const { encodeScopeBitmap: encode, decodeScopeBitmap: decode } = require('../src/models/robinhood-wallet-transfer-scope-bitmap');
const tokens = [1, 2, 3].map((id) => `0x${id.toString(16).padStart(40, '0')}`);
const dictionary = tokens.map((token_address, i) => ({ token_address, ordinal: [0, 7, 8][i] }));
test('round trips exact historical membership across byte boundaries, removal and reentry', () => {
  for (const members of [tokens, [tokens[0], tokens[2]], tokens]) {
    const encoded = encode(members, dictionary);
    assert.deepEqual(decode(encoded, dictionary.toReversed()), members);
    assert.equal(encoded.dictionarySize, 9);
    assert.equal(encoded.bitmap.length, 2);
  }
  const extended = [...dictionary, { token_address: `0x${'f'.repeat(40)}`, ordinal: 999999 }];
  assert.deepEqual(decode(encode(tokens, dictionary), extended), tokens);
  const maximum = encode(tokens, extended);
  assert.equal(maximum.bitmap.length, 125000);
  assert.deepEqual(decode(maximum, extended), tokens);
});
test('rejects truncated/corrupt maps, missing dictionary members, padding and mismatched hashes', () => {
  const encoded = encode(tokens, dictionary);
  for (const change of [{ bitmap: Buffer.from([129]) }, { bitmap: Buffer.from([131, 1]) },
    { bitmap: Buffer.from([129, 3]) }, { tokenCount: 2 }, { scopeHash: '0'.repeat(64) },
    { dictionarySize: 1000001 }, { dictionarySize: 0 }]) {
    assert.throws(() => decode({ ...encoded, ...change }, dictionary), /scope bitmap/);
  }
  assert.throws(() => decode(encoded, dictionary.slice(1)), /membership mismatch/);
});
test('bounds normalized tokens and immutable dictionary identities before allocating maps', () => {
  for (const members of [[], [tokens[0], tokens[0]], tokens.toReversed(), ['invalid'], Array(500001).fill(tokens[0])]) {
    assert.throws(() => encode(members, dictionary), /scope tokens/);
  }
  for (const entries of [[...dictionary, dictionary[0]], [dictionary[0], { ...dictionary[1], ordinal: 0 }],
    [{ ...dictionary[0], ordinal: -1 }],
    [{ ...dictionary[0], ordinal: 1000000 }], [{ ...dictionary[0], ordinal: '0' }],
    [{ ...dictionary[0], token_address: 'invalid' }], Array(1000001).fill(dictionary[0])]) {
    assert.throws(() => encode(tokens, entries), /dictionary/);
  }
  assert.throws(() => encode(tokens, dictionary.slice(1)), /missing from dictionary/);
});
