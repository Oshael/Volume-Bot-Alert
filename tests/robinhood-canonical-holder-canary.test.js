'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  compareTransfers, createRobinhoodCanonicalHolderCanary,
} = require('../src/services/robinhood-canonical-holder-canary');
const {
  buildCanary, main, parseArgs,
} = require('../src/utils/audit-robinhood-canonical-holder-canary');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const FROM = `0x${'2'.repeat(40)}`;
const TO = `0x${'3'.repeat(40)}`;

function transfer(index, overrides = {}) {
  return {
    blockNumber: '200', blockHash: HASH,
    transactionHash: `0x${index.toString(16).padStart(64, '0')}`,
    transactionIndex: index, logIndex: index, tokenAddress: TOKEN,
    fromWallet: FROM, toWallet: TO, amountRaw: String(index + 1), ...overrides,
  };
}

function source(transfers, overrides = {}) {
  return {
    async getSafeHead(confirmations) {
      return { head: '220', safeHead: '208', confirmations };
    },
    async readGlobalRange(input) {
      return {
        ...input, transfers, checkpoint: { number: input.toBlock, hash: HASH },
        telemetry: { observedLogs: transfers.length, ignoredMalformedLogs: 0, requests: 1 },
        ...overrides,
      };
    },
  };
}

function canary(legacy, canonical, ready = true) {
  return createRobinhoodCanonicalHolderCanary({
    readiness: { async inspect() { return { ready, blockers: ready ? [] : [{ code: 'gap' }] }; } },
    legacySource: legacy, canonicalSource: canonical,
  });
}

describe('Robinhood canonical holder canary', () => {
  it('approves identical transfers in a closed common range', async () => {
    const transfers = [transfer(1), transfer(2), transfer(3)];
    const report = await canary(source(transfers), source(transfers)).inspect({
      blocks: 16, minTransfers: 3, confirmations: 12,
    });
    assert.equal(report.approved, true);
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.range, {
      from_block: '193', to_block: '208', blocks: 16, confirmations: 12,
    });
    assert.deepEqual(report.parity, {
      legacy: 3, canonical: 3, matched: 3,
      missing_canonical: 0, missing_legacy: 0, divergent: 0, order_divergent: false,
      samples: { missing_canonical: [], missing_legacy: [], divergent: [] },
    });
  });

  it('reports both missing directions and deterministic field drift', () => {
    const left = [transfer(1), transfer(2), transfer(3)];
    const right = [transfer(1), transfer(2, { amountRaw: '99' }), transfer(4)];
    assert.deepEqual(compareTransfers(left, right), {
      legacy: 3, canonical: 3, matched: 1,
      missing_canonical: 1, missing_legacy: 1, divergent: 1, order_divergent: false,
      samples: {
        missing_canonical: [`${left[2].transactionHash}:3`],
        missing_legacy: [`${right[2].transactionHash}:4`],
        divergent: [{ identity: `${left[1].transactionHash}:2`, fields: ['amountRaw'] }],
      },
    });
  });

  it('rejects the same transfers in a different causal order', async () => {
    const first = transfer(1);
    const second = transfer(2);
    const report = await canary(source([first, second]), source([second, first])).inspect({
      blocks: 16, minTransfers: 2, confirmations: 12,
    });
    assert.equal(report.parity.order_divergent, true);
    assert.deepEqual(report.blockers, [{ code: 'transfer_order_divergent' }]);
  });

  it('blocks sparse, incomplete or divergent evidence', async () => {
    const legacy = source([transfer(1), transfer(2)]);
    const canonical = source([transfer(1, { amountRaw: '7' }), transfer(3)], {
      checkpoint: { number: '208', hash: `0x${'b'.repeat(64)}` },
      telemetry: { observedLogs: 3, ignoredMalformedLogs: 0, requests: 0 },
    });
    const report = await canary(legacy, canonical).inspect({
      blocks: 16, minTransfers: 3, confirmations: 12,
    });
    assert.deepEqual(report.blockers.map(({ code }) => code), [
      'checkpoint_divergent', 'raw_log_count_divergent', 'insufficient_transfer_samples',
      'canonical_transfers_missing', 'legacy_transfers_missing', 'transfer_fields_divergent',
    ]);
  });

  it('does not touch either source when preflight is blocked', async () => {
    const unavailable = {
      async getSafeHead() { throw new Error('must not read'); },
      async readGlobalRange() { throw new Error('must not read'); },
    };
    const report = await canary(unavailable, unavailable, false).inspect();
    assert.equal(report.approved, false);
    assert.equal(report.blockers[0].code, 'preflight_not_ready');
    assert.equal(report.range, null);
  });

  it('parses bounded arguments and prints one report', async () => {
    assert.deepEqual(parseArgs(['--blocks=32', '--min-transfers=5', '--confirmations=8']), {
      blocks: 32, minTransfers: 5, confirmations: 8,
    });
    assert.throws(() => parseArgs(['--blocks=0']), /between 1 and 1000/);
    const lines = [];
    const report = await main([], {
      options: { blocks: 1, minTransfers: 0, confirmations: 0 },
      canary: { async inspect() { return { approved: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.equal(report.approved, true);
    assert.deepEqual(JSON.parse(lines[0]), report);
  });

  it('builds distinct RPC and canonical readers for the comparison', async () => {
    const created = [];
    const legacy = source([transfer(1)]);
    const canonical = source([transfer(1)]);
    legacy.assertChain = async () => created.push('legacy-chain');
    canonical.assertChain = async () => created.push('canonical-chain');
    const built = await buildCanary({ confirmations: 12 }, {
      database: 'database', env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      rpcClientFactory: () => 'rpc-client',
      readerFactory: ({ rpcClient }) => { created.push(rpcClient); return legacy; },
      canonicalReaderFactory: ({ database }) => { created.push(database); return canonical; },
      readiness: { async inspect() { return { ready: true, blockers: [] }; } },
    });
    const report = await built.inspect({ blocks: 1, minTransfers: 1, confirmations: 12 });
    assert.equal(report.approved, true);
    assert.deepEqual(created, [
      'rpc-client', 'legacy-chain', 'database', 'canonical-chain',
    ]);
  });
});
