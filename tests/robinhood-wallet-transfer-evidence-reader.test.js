const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTransferEvidenceReader,
} = require('../src/services/robinhood-wallet-transfer-evidence-reader');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;

function transfer(blockNumber, blockHash, logIndex) {
  return Object.freeze({
    blockNumber: String(blockNumber), blockHash,
    transactionHash: `0x${String(logIndex).padStart(64, 'd')}`,
    transactionIndex: logIndex, logIndex, tokenAddress: TOKEN,
    fromWallet: ALICE, toWallet: BOB, amountRaw: String(logIndex + 1),
  });
}

function captured(overrides = {}) {
  return Object.freeze({
    fromBlock: '100', toBlock: '102', nextBlock: '103', scopeTokens: 1,
    checkpoint: Object.freeze({ number: '102', hash: HASH_C }),
    transfers: Object.freeze([
      transfer(100, HASH_A, 1), transfer(101, HASH_B, 2), transfer(100, HASH_A, 3),
    ]),
    telemetry: Object.freeze({ requests: 1, splits: 0 }),
    ...overrides,
  });
}

function block(number, hash) {
  return {
    number: `0x${BigInt(number).toString(16)}`,
    hash,
    timestamp: `0x${(1_900_000_000n + BigInt(number)).toString(16)}`,
  };
}

function dependencies(result = captured(), overrideBlock = null) {
  const batches = [];
  const hashes = new Map([['100', HASH_A], ['101', HASH_B], ['102', HASH_C]]);
  return {
    batches,
    transferReader: { readGlobalRange: async () => result },
    rpcClient: {
      requestBatch: async (requests) => {
        batches.push(requests);
        return requests.map(({ params }) => {
          const number = BigInt(params[0]).toString();
          return overrideBlock?.(number) || block(number, hashes.get(number));
        });
      },
    },
  };
}

describe('Robinhood wallet transfer RPC evidence reader', () => {
  it('enriches ordered transfers and the checkpoint using bounded block batches', async () => {
    const deps = dependencies();
    const reader = createRobinhoodWalletTransferEvidenceReader({
      ...deps, blockBatchSize: 2,
    });

    const result = await reader.readRange({
      tokenAddresses: [TOKEN], fromBlock: '100', toBlock: '102',
    });

    assert.deepEqual(deps.batches.map((batch) => batch.map(({ params }) => params[0])), [
      ['0x64', '0x65'], ['0x66'],
    ]);
    assert.deepEqual(result.transfers.map(({ blockNumber, logIndex }) => (
      [blockNumber, logIndex]
    )), [['100', 1], ['101', 2], ['100', 3]]);
    assert.equal(result.transfers[0].blockTime, new Date(1_900_000_100_000).toISOString());
    assert.deepEqual(result.checkpoint, {
      number: '102', hash: HASH_C,
      blockTime: new Date(1_900_000_102_000).toISOString(),
    });
    assert.deepEqual(result.telemetry, {
      requests: 1, splits: 0, evidenceBatches: 2, evidenceBlocks: 3,
    });
  });

  it('fetches checkpoint evidence even when the range has no transfers', async () => {
    const deps = dependencies(captured({ transfers: Object.freeze([]) }));
    const result = await createRobinhoodWalletTransferEvidenceReader(deps).readRange({});

    assert.equal(deps.batches.length, 1);
    assert.equal(deps.batches[0].length, 1);
    assert.deepEqual(result.transfers, []);
    assert.equal(result.telemetry.evidenceBlocks, 1);
  });

  it('fails closed when a transfer block hash conflicts with canonical evidence', async () => {
    const deps = dependencies(captured(), (number) => (
      number === '100' ? block(number, HASH_B) : null
    ));
    await assert.rejects(
      createRobinhoodWalletTransferEvidenceReader(deps).readRange({}),
      /transfer block hash conflicts with RPC evidence/
    );
  });

  it('fails closed when the range checkpoint changes during evidence capture', async () => {
    const deps = dependencies(captured(), (number) => (
      number === '102' ? block(number, HASH_A) : null
    ));
    await assert.rejects(
      createRobinhoodWalletTransferEvidenceReader(deps).readRange({}),
      /checkpoint hash conflicts with RPC evidence/
    );
  });

  it('rejects malformed block identity, timestamp and batch responses', async () => {
    const cases = [
      { response: [{ ...block(102, HASH_C), number: '0x65' }], pattern: /requested number/ },
      { response: [{ ...block(102, HASH_C), timestamp: 'invalid' }], pattern: /timestamp/ },
      { response: [], pattern: /invalid result count/ },
    ];
    for (const testCase of cases) {
      const input = captured({ transfers: Object.freeze([]) });
      const reader = createRobinhoodWalletTransferEvidenceReader({
        transferReader: { readGlobalRange: async () => input },
        rpcClient: { requestBatch: async () => testCase.response },
      });
      await assert.rejects(reader.readRange({}), testCase.pattern);
    }
  });
});
