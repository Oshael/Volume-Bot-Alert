const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  RAW_RETENTION_MS, materializeBundleFundingRange,
} = require('../src/services/robinhood-bundle-funding-materializer');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const WALLET = `0x${'1'.repeat(40)}`;
const FUNDER = `0x${'2'.repeat(40)}`;
const ANCESTOR = `0x${'3'.repeat(40)}`;
const THIRD = `0x${'4'.repeat(40)}`;
const FUNDER_2 = `0x${'5'.repeat(40)}`;
const ANCESTOR_2 = `0x${'6'.repeat(40)}`;
const UNRELATED = `0x${'7'.repeat(40)}`;
const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function transfer(blockNumber, transactionIndex, fromAddress, toAddress, valueWei, suffix,
  blockTimestamp = String(Math.floor(NOW / 1000))) {
  return Object.freeze({ blockNumber: String(blockNumber), blockHash: HASH_A,
    blockTimestamp, transactionHash: `0x${suffix.repeat(64)}`,
    transactionIndex: String(transactionIndex), fromAddress, toAddress,
    valueWei: String(valueWei) });
}

function reader(transfers, hashes = [HASH_A, HASH_A], coverageAdjustment = 0) {
  const calls = [];
  return { calls,
    async checkpoint(block) { calls.push(['checkpoint', block]); return hashes.shift(); },
    async readBlocks(numbers) {
      calls.push(['blocks', numbers]);
      const wanted = new Set(numbers);
      return { blocksScanned: numbers.length + coverageAdjustment,
        transfers: transfers.filter(({ blockNumber }) => wanted.has(blockNumber)) };
    } };
}

function range(fromBlock, throughBlock, firstBuyBlock = throughBlock,
  firstBuyTransactionIndex = '5') {
  return { fromBlock: String(fromBlock), throughBlock: String(throughBlock), candidates: [{
    tokenAddress: `0x${'9'.repeat(40)}`, walletAddress: WALLET, launchBlock: '100',
    firstBuyBlock: String(firstBuyBlock), firstBuyTransactionIndex,
  }] };
}

describe('Robinhood bundle funding materializer', () => {
  it('selects causal direct and two-hop funding before the first buy', async () => {
    const transfers = [
      transfer(98, 0, THIRD, ANCESTOR, 1, '8'),
      transfer(99, 0, ANCESTOR, FUNDER, 2, '9'),
      transfer(99, 1, WALLET, FUNDER, 3, 'a'),
      transfer(100, 1, FUNDER, WALLET, 10, 'c'),
      transfer(101, 2, FUNDER, WALLET, 20, 'd'),
      transfer(101, 3, UNRELATED, THIRD, 30, 'e'),
      transfer(102, 3, ANCESTOR_2, FUNDER_2, 40, 'f'),
      transfer(102, 4, FUNDER_2, WALLET, 50, '1'),
      transfer(102, 5, UNRELATED, WALLET, 60, '2'),
    ];
    const archive = reader(transfers);
    const result = await materializeBundleFundingRange({
      range: range(98, 102), lookbackBlocks: 4, batchBlocks: 2,
    }, { reader: archive, now: () => NOW });
    assert.equal(result.blocksScanned, 5);
    assert.equal(result.nativeTransfersScanned, 9);
    assert.equal(result.relevantTransfers, 5);
    assert.equal(result.rawEvents.length, 5);
    assert.equal(result.edges.length, 4);
    assert.equal(result.causalEvidence.length, 5);
    assert.equal(result.causalEvidence.filter(({ hop }) => hop === 1).length, 3);
    assert.equal(result.causalEvidence.filter(({ hop }) => hop === 2).length, 2);
    assert.ok(result.causalEvidence.every(({ tokenAddress, candidateWallet }) => (
      tokenAddress === `0x${'9'.repeat(40)}` && candidateWallet === WALLET
    )));
    assert.deepEqual(archive.calls.filter(([type]) => type === 'blocks').map(([, blocks]) => blocks),
      [['98', '99'], ['100', '101'], ['102']]);
    const repeated = result.edges.find((edge) => (
      edge.fromAddress === FUNDER && edge.toAddress === WALLET
    ));
    assert.deepEqual({ count: repeated.transferCount, total: repeated.totalValueWei,
      first: repeated.firstBlockNumber, last: repeated.lastBlockNumber },
    { count: '2', total: '30', first: '100', last: '101' });
    const selectedHashes = new Set(result.rawEvents.map(({ transactionHash }) => transactionHash));
    assert.equal(selectedHashes.has(`0x${'8'.repeat(64)}`), false, 'third hop excluded');
    assert.equal(selectedHashes.has(`0x${'a'.repeat(64)}`), false, 'candidate cycle excluded');
    assert.equal(selectedHashes.has(`0x${'2'.repeat(64)}`), false, 'same tx as buy excluded');
  });

  it('retains old evidence in permanent edges but not in 30-day raw', async () => {
    const oldTimestamp = String(Math.floor((NOW - RAW_RETENTION_MS - 1_000) / 1000));
    const archive = reader([transfer(100, 0, FUNDER, WALLET, 10, 'c', oldTimestamp)]);
    const result = await materializeBundleFundingRange({
      range: range(100, 101, 101, '1'), lookbackBlocks: 10, batchBlocks: 2,
    }, { reader: archive, now: () => NOW });
    assert.equal(result.edges.length, 1);
    assert.equal(result.rawEvents.length, 0);
    assert.equal(result.causalEvidence.length, 1);
  });

  it('fails closed on checkpoint drift, incomplete coverage, or empty frozen scope', async () => {
    await assert.rejects(materializeBundleFundingRange({
      range: range(100, 100, 100, '1'), lookbackBlocks: 0,
    }, { reader: reader([], [HASH_A, HASH_B]) }),
    (error) => error.code === 'bundle_funding_checkpoint_changed');
    await assert.rejects(materializeBundleFundingRange({
      range: range(100, 100, 100, '1'), lookbackBlocks: 0,
    }, { reader: reader([], [HASH_A], -1) }), /incomplete block coverage/);
    await assert.rejects(materializeBundleFundingRange({
      range: { fromBlock: '100', throughBlock: '100', candidates: [] }, lookbackBlocks: 0,
    }, { reader: reader([]) }), /no frozen candidates/);
  });
});
