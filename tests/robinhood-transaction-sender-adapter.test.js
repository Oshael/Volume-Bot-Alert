const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  indexBlockSenders,
  resolveSenders,
} = require('../src/services/robinhood-transaction-sender-adapter');

const SIGNER_A = `0x${'a'.repeat(40)}`;
const SIGNER_B = `0x${'b'.repeat(40)}`;
const TX_1 = `0x${'1'.repeat(64)}`;
const TX_2 = `0x${'2'.repeat(64)}`;
const TX_3 = `0x${'3'.repeat(64)}`;

// block 0x64 = 100, timestamp 0x60000000 -> a fixed UTC instant.
function fullBlock(transactions, overrides = {}) {
  return {
    number: '0x64',
    timestamp: '0x60000000',
    hash: `0x${'f'.repeat(64)}`,
    transactions,
    ...overrides,
  };
}

describe('robinhood transaction sender adapter', () => {
  it('indexes signers by hash and derives onchain block time', () => {
    const { blockNumber, blockTime, senders } = indexBlockSenders(fullBlock([
      { hash: TX_1, from: SIGNER_A },
      { hash: TX_2, from: SIGNER_B },
    ]));

    assert.equal(blockNumber, 100n);
    assert.equal(blockTime, new Date(0x60000000 * 1000).toISOString());
    assert.equal(senders.get(TX_1), SIGNER_A);
    assert.equal(senders.get(TX_2), SIGNER_B);
  });

  it('normalizes checksummed hashes and addresses to lowercase', () => {
    const mixedHash = `0x${'AbCdEf'.repeat(10)}${'1234'}`; // 64 hex chars, mixed case
    const { senders } = indexBlockSenders(fullBlock([
      { hash: mixedHash, from: '0xAbCdEf0123456789abcdef0123456789ABCDef01' },
    ]));

    const lowerHash = mixedHash.toLowerCase();
    assert.equal(senders.get(lowerHash), '0xabcdef0123456789abcdef0123456789abcdef01');
    // the checksummed form is not a distinct key
    assert.equal(senders.has(mixedHash), false);
  });

  it('rejects a block fetched without full transactions (hash-only array)', () => {
    assert.throws(
      () => indexBlockSenders(fullBlock([TX_1, TX_2])),
      /hashes, not full transactions/
    );
  });

  it('rejects malformed transactions and non-array transaction fields', () => {
    assert.throws(
      () => indexBlockSenders(fullBlock([{ hash: TX_1 }])),
      /transaction\.from must be a 20-byte hex address/
    );
    assert.throws(
      () => indexBlockSenders(fullBlock(undefined)),
      /block\.transactions must be an array/
    );
  });

  it('guards against a wrong or reorged block via expectedBlockNumber', () => {
    assert.throws(
      () => indexBlockSenders(fullBlock([{ hash: TX_1, from: SIGNER_A }]), { expectedBlockNumber: 101 }),
      /does not match expected 101/
    );
    // matching expectation passes
    assert.doesNotThrow(() => indexBlockSenders(
      fullBlock([{ hash: TX_1, from: SIGNER_A }]),
      { expectedBlockNumber: '0x64' }
    ));
  });

  it('resolves requested hashes and reports the ones absent from the block', () => {
    const block = fullBlock([
      { hash: TX_1, from: SIGNER_A },
      { hash: TX_2, from: SIGNER_B },
    ]);
    const { resolved, missing } = resolveSenders(block, [TX_1, TX_3]);

    assert.equal(resolved.get(TX_1), SIGNER_A);
    assert.equal(resolved.has(TX_3), false);
    assert.deepEqual(missing, [TX_3]);
  });

  it('throws when the same hash carries conflicting signers in one block', () => {
    assert.throws(
      () => indexBlockSenders(fullBlock([
        { hash: TX_1, from: SIGNER_A },
        { hash: TX_1, from: SIGNER_B },
      ])),
      /conflicting senders/
    );
  });
});
