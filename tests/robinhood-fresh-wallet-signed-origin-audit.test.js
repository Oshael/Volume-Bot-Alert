const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodFreshWalletSignedOriginAudit,
} = require('../src/services/robinhood-fresh-wallet-signed-origin-audit');
const {
  parseArgs,
} = require('../src/utils/audit-robinhood-fresh-wallet-signed-origins');

const HASH = `0x${'a'.repeat(64)}`;
const RULE_VERSION = 'rh_fresh_signed_v1';

function candidate(index) {
  return { tokenAddress: `0x${String(index).padStart(40, '0')}`,
    walletAddress: `0x${String(index + 10).padStart(40, '0')}`,
    transactionHash: HASH, transactionIndex: '5', blockNumber: '100',
    blockHash: HASH, blockTime: '2026-08-30T12:00:00.000Z' };
}

function evidence(item, cutoffNonce = '0') {
  return { ruleVersion: RULE_VERSION, source: 'robinhood-pc-archive', sourceKind: 'seed',
    observedAt: '2026-08-30T12:05:00.000Z',
    firstBuy: { walletAddress: item.walletAddress, transactionHash: item.transactionHash,
      blockNumber: item.blockNumber, blockHash: item.blockHash,
      blockTime: item.blockTime, nonce: '5' },
    cutoff: { targetAt: '2026-08-29T12:00:00.000Z', number: '50', hash: HASH,
      blockTime: '2026-08-29T11:59:59.000Z', nonce: cutoffNonce },
    nextBlock: { number: '51', hash: HASH, blockTime: '2026-08-29T12:00:00.000Z' } };
}

function repository(candidates, origins) {
  return { async loadCoverage() { return { originBlock: '0', throughBlock: '200' }; },
    async sampleCandidates(limit) { return candidates.slice(0, limit); },
    async loadOrigins(wallets) {
      return new Map(wallets.filter((wallet) => origins[wallet])
        .map((wallet) => [wallet, origins[wallet]]));
    } };
}

describe('Robinhood FRESH signed-origin operational audit', () => {
  it('approves only a sufficient sample with exact Archive equivalence', async () => {
    const items = [candidate(1), candidate(2)];
    const origins = Object.fromEntries(items.map((item) => [item.walletAddress,
      { blockNumber: '100', transactionIndex: '5', nonce: '0' }]));
    const progress = [];
    const result = await runRobinhoodFreshWalletSignedOriginAudit({
      repository: repository(items, origins),
      archiveSource: { async readEvidenceBatch(batch) {
        return batch.map((item) => evidence(item));
      } },
    }, { sampleCount: 2, minimumSamples: 2, batchSize: 1,
      onProgress: (value) => progress.push(value) });
    assert.deepEqual(result, { approved: true, requestedSamples: 2, minimumSamples: 2,
      auditedSamples: 2, equivalent: 2, mismatched: 0, unavailable: 0,
      coverage: { originBlock: '0', throughBlock: '200' }, details: [] });
    assert.deepEqual(progress, [{ audited: 1, requested: 2 }, { audited: 2, requested: 2 }]);
  });

  it('fails closed for mismatched, unavailable, and undersized evidence', async () => {
    const items = [candidate(1), candidate(2), candidate(3)];
    const origins = {
      [items[0].walletAddress]: { blockNumber: '100', transactionIndex: '5', nonce: '0' },
      [items[1].walletAddress]: { blockNumber: '40', transactionIndex: '1', nonce: '0' },
    };
    const result = await runRobinhoodFreshWalletSignedOriginAudit({
      repository: repository(items, origins),
      archiveSource: { async readEvidenceBatch(batch) {
        return batch.map((item) => evidence(item));
      } },
    }, { sampleCount: 4, minimumSamples: 4, batchSize: 3 });
    assert.equal(result.approved, false);
    assert.equal(result.equivalent, 1);
    assert.equal(result.mismatched, 1);
    assert.equal(result.unavailable, 1);
    assert.equal(result.details[0].status, 'mismatched');
    assert.equal(result.details[1].reason, 'signed_origin_missing');
  });

  it('validates bounded CLI arguments', () => {
    assert.deepEqual(parseArgs(['--samples=250', '--minimum-samples=50',
      '--batch-size=25', '--timeout-ms=30000']), {
      sampleCount: 250, minimumSamples: 50, batchSize: 25, timeoutMs: 30000,
    });
    assert.throws(() => parseArgs(['--apply']), /unexpected argument/);
  });
});
