'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  buildCanary, main, parseArgs,
} = require('../src/utils/audit-robinhood-canonical-wallet-transfer-canary');

const HASH = `0x${'a'.repeat(64)}`;

function source(created, label) {
  return {
    async assertChain() { created.push(`${label}-chain`); },
    async getSafeHead(confirmations) {
      return { head: '220', safeHead: '218', confirmations };
    },
    async readGlobalRange(input) {
      return {
        ...input, transfers: [], checkpoint: { number: input.toBlock, hash: HASH },
        telemetry: { observedLogs: 0, ignoredMalformedLogs: 0, requests: 1 },
      };
    },
  };
}

describe('Robinhood canonical wallet-transfer canary CLI', () => {
  it('defaults to the wallet-transfer confirmation boundary', () => {
    assert.deepEqual(parseArgs([]), {
      blocks: 64, minTransfers: 100, confirmations: 2,
    });
    assert.deepEqual(parseArgs([
      '--blocks=200', '--min-transfers=1', '--confirmations=4',
    ]), { blocks: 200, minTransfers: 1, confirmations: 4 });
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
  });

  it('uses wallet-transfer readiness with distinct legacy and canonical readers', async () => {
    const created = [];
    const legacy = source(created, 'legacy');
    const canonical = source(created, 'canonical');
    const canary = await buildCanary({ confirmations: 2 }, {
      database: 'database', env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      rpcClientFactory: () => 'rpc-client',
      readerFactory: ({ rpcClient }) => { created.push(rpcClient); return legacy; },
      canonicalReaderFactory: ({ database }) => { created.push(database); return canonical; },
      readiness: { async inspect() { return { ready: true, blockers: [] }; } },
    });
    const report = await canary.inspect({ blocks: 1, minTransfers: 0, confirmations: 2 });
    assert.equal(report.approved, true);
    assert.deepEqual(created, [
      'rpc-client', 'legacy-chain', 'database', 'canonical-chain',
    ]);
  });

  it('prints the read-only comparison report', async () => {
    const lines = [];
    const report = await main([], {
      options: { blocks: 1, minTransfers: 0, confirmations: 2 },
      canary: { async inspect() { return { mode: 'read-only', approved: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
