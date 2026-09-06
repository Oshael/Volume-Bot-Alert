'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  compareTransfers, createRobinhoodCanonicalBundleFundingCanary,
} = require('../src/services/robinhood-canonical-bundle-funding-canary');
const {
  buildCanary, main, parseArgs,
} = require('../src/utils/audit-robinhood-canonical-bundle-funding-canary');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const WALLET = `0x${'1'.repeat(40)}`;
const FUNDER = `0x${'2'.repeat(40)}`;

function transfer(overrides = {}) {
  return {
    transactionHash: TX, transactionIndex: '0', fromAddress: FUNDER,
    toAddress: WALLET, valueWei: '10', blockNumber: '199',
    blockHash: HASH, blockTimestamp: '1788566500', ...overrides,
  };
}

function readiness(ready = true) {
  return { async inspect() { return {
    ready, blockers: ready ? [] : [{ code: 'capture_lag_exceeded' }],
    capture: { checkpoint_block: '200', node_head: '202' },
    handoff: { journal_start_block: '100' },
  }; } };
}

function reader(items = [transfer()], overrides = {}) {
  return {
    async assertChain() { return '4663'; },
    async checkpoint() { return HASH; },
    async readBlocks(numbers) {
      return { blocksScanned: numbers.length, transfers: items };
    },
    ...overrides,
  };
}

describe('Robinhood canonical bundle-funding canary', () => {
  it('compares stable native transfer identities and fields', () => {
    const report = compareTransfers(
      [transfer(), transfer({ transactionHash: `0x${'c'.repeat(64)}` })],
      [transfer(), transfer({ transactionHash: `0x${'d'.repeat(64)}` })]
    );
    assert.deepEqual({
      matched: report.matched, missingCanonical: report.missing_canonical,
      missingLegacy: report.missing_legacy,
    }, { matched: 1, missingCanonical: 1, missingLegacy: 1 });
    assert.deepEqual(compareTransfers(
      [transfer()], [transfer({ valueWei: '11' })]
    ).samples.divergent[0].fields, ['valueWei']);
  });

  it('approves matching sources over the latest bounded range', async () => {
    const canary = createRobinhoodCanonicalBundleFundingCanary({
      readiness: readiness(), legacyReader: reader(), canonicalReader: reader(),
    });
    const report = await canary.inspect({ blocks: 2, minTransfers: 1 });
    assert.equal(report.approved, true);
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.range, {
      from_block: '199', to_block: '200', blocks: 2, confirmations: 2,
    });
    assert.deepEqual(report.checkpoints, { legacy: HASH, canonical: HASH, stable: true });
    assert.equal(report.parity.matched, 1);
  });

  it('fails closed on source errors without hiding the healthy source', async () => {
    const failing = reader([], { async readBlocks() {
      throw Object.assign(new Error('value missing'), { code: 'canonical_gap' });
    } });
    const canary = createRobinhoodCanonicalBundleFundingCanary({
      readiness: readiness(), legacyReader: reader(), canonicalReader: failing,
    });
    const report = await canary.inspect({ blocks: 2 });
    assert.equal(report.approved, false);
    assert.deepEqual(report.blockers, [{ code: 'canonical_source_error', detail: {
      code: 'canonical_gap', message: 'value missing',
    } }]);
    assert.equal(report.parity, null);
  });

  it('blocks checkpoint drift, divergence and transfer differences', async () => {
    let calls = 0;
    const drifting = reader([transfer({ valueWei: '11' })], {
      async checkpoint() { calls += 1; return calls === 1 ? HASH : `0x${'e'.repeat(64)}`; },
    });
    const canary = createRobinhoodCanonicalBundleFundingCanary({
      readiness: readiness(), legacyReader: reader(), canonicalReader: drifting,
    });
    const report = await canary.inspect({ blocks: 2 });
    assert.deepEqual(report.blockers.map(({ code }) => code), [
      'canonical_checkpoint_changed', 'checkpoint_divergent', 'transfer_fields_divergent',
    ]);
  });

  it('does not touch either source while preflight is blocked', async () => {
    let reads = 0;
    const source = reader([], { async assertChain() { reads += 1; } });
    const canary = createRobinhoodCanonicalBundleFundingCanary({
      readiness: readiness(false), legacyReader: source, canonicalReader: source,
    });
    const report = await canary.inspect();
    assert.equal(report.blockers[0].code, 'preflight_not_ready');
    assert.equal(reads, 0);
  });

  it('parses CLI bounds, builds both readers and prints JSON', async () => {
    assert.deepEqual(parseArgs(['--blocks=50', '--min-transfers=2']), {
      blocks: 50, minTransfers: 2,
    });
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const built = buildCanary({
      env: { ROBINHOOD_RPC_URL: 'http://rpc' }, database: {},
      clientFactory: () => ({ request() {}, requestBatch() {} }),
      readiness: readiness(), legacyReader: reader(), canonicalReader: reader(),
    });
    assert.equal(typeof built.inspect, 'function');
    const lines = [];
    const report = await main([], {
      options: {}, canary: { async inspect() { return { approved: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
