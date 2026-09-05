'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  compareDeployments, createRobinhoodCanonicalDirectCreatorCanary,
} = require('../src/services/robinhood-canonical-direct-creator-canary');
const { createRobinhoodCanonicalDirectCreatorSource } = require(
  '../src/models/robinhood-canonical-direct-creator-source'
);
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-direct-creator-canary');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const TOKEN = `0x${'c'.repeat(40)}`;
const CREATOR = `0x${'d'.repeat(40)}`;

function deployment(overrides = {}) {
  return {
    tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: TX,
    blockNumber: '199', blockHash: HASH, factoryAddress: null,
    launchpadId: null, source: 'rpc_direct', ...overrides,
  };
}

function readiness(ready = true) {
  return { async inspect() { return {
    ready, blockers: ready ? [] : [{ code: 'capture_lag_exceeded' }],
    direct_creator: { checkpoint_block: '200' },
    handoff: { journal_start_block: '100' },
  }; } };
}

function canonicalReader(blocks = [199n, 200n], deployments = [deployment()]) {
  return { async readRange() {
    return new Map(blocks.map((number) => [String(number), {
      blockNumber: String(number), blockHash: HASH,
      deployments: number === 199n ? deployments : [],
    }]));
  } };
}

function legacyBlock(number, deployments = number === 199n ? [deployment()] : []) {
  return { blockNumber: String(number), blockHash: HASH, deployments };
}

describe('Robinhood canonical direct-creator canary', () => {
  it('compares creator evidence by stable identity and deterministic fields', () => {
    const report = compareDeployments(
      [deployment(), deployment({ transactionHash: `0x${'e'.repeat(64)}` })],
      [deployment(), deployment({ transactionHash: `0x${'f'.repeat(64)}` })]
    );
    assert.deepEqual({
      legacy: report.legacy, canonical: report.canonical, matched: report.matched,
      missingCanonical: report.missing_canonical, missingLegacy: report.missing_legacy,
    }, { legacy: 2, canonical: 2, matched: 1, missingCanonical: 1, missingLegacy: 1 });
    const divergent = compareDeployments(
      [deployment()], [deployment({ creatorAddress: `0x${'1'.repeat(40)}` })]
    );
    assert.deepEqual(divergent.samples.divergent[0].fields, ['creatorAddress']);
  });

  it('approves a complete recent range with matching evidence', async () => {
    const legacyDirect = { ...deployment() };
    delete legacyDirect.blockNumber;
    delete legacyDirect.blockHash;
    const canary = createRobinhoodCanonicalDirectCreatorCanary({
      readiness: readiness(), canonicalReader: canonicalReader(),
      scanLegacyBlock: async (number) => legacyBlock(
        number, number === 199n ? [legacyDirect] : []
      ),
    });
    const report = await canary.inspect({ blocks: 2, minDeployments: 1, concurrency: 2 });
    assert.equal(report.approved, true);
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.range, {
      from_block: '199', to_block: '200', requested_blocks: 2, compared_blocks: 2,
    });
    assert.equal(report.parity.matched, 1);
    assert.equal(report.parity.block_hash_divergent, 0);
  });

  it('fails closed on quiet samples, missing blocks and legacy source errors', async () => {
    const canary = createRobinhoodCanonicalDirectCreatorCanary({
      readiness: readiness(), canonicalReader: canonicalReader([199n], []),
      scanLegacyBlock: async (number) => {
        if (number === 200n) throw new Error('receipt unavailable');
        return legacyBlock(number, []);
      },
    });
    const report = await canary.inspect({ blocks: 2, minDeployments: 1 });
    assert.equal(report.approved, false);
    assert.deepEqual(report.blockers.map(({ code }) => code), [
      'insufficient_deployment_samples', 'canonical_blocks_missing',
      'legacy_source_errors',
    ]);
  });

  it('does not read sources when preflight is blocked', async () => {
    let reads = 0;
    const canary = createRobinhoodCanonicalDirectCreatorCanary({
      readiness: readiness(false),
      canonicalReader: { async readRange() { reads += 1; } },
      scanLegacyBlock: async () => { reads += 1; },
    });
    const report = await canary.inspect();
    assert.equal(report.approved, false);
    assert.equal(report.blockers[0].code, 'preflight_not_ready');
    assert.equal(reads, 0);
  });

  it('loads canonical evidence inside a repeatable read-only snapshot', async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('SELECT node_head, checkpoint_block')) {
          return { rowCount: 1, rows: [{ node_head: '200', checkpoint_block: '200' }] };
        }
        if (sql.includes('SELECT block_number, block_hash')) {
          return { rows: [{
            block_number: '199', block_hash: HASH, block_timestamp: '2026-09-05T20:00:00Z',
          }] };
        }
        if (sql.includes('transaction.contract_address')) return { rows: [{
          block_number: '199', block_hash: HASH, transaction_hash: TX,
          from_address: CREATOR, contract_address: TOKEN,
        }] };
        if (sql.includes('event.transaction_hash')) return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const reader = createRobinhoodCanonicalDirectCreatorSource({
      database: { async getClient() { return client; } },
    });
    const blocks = await reader.readRange(199n, 199n);
    assert.equal(blocks.get('199').deployments[0].creatorAddress, CREATOR);
    assert.equal(blocks.get('199').deployments[0].blockHash, HASH);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.deepEqual(calls[2].params, ['robinhood', '199', '199']);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
    assert.equal(calls.at(-1).sql, 'RELEASE');
  });

  it('parses bounded CLI options and prints the report', async () => {
    assert.deepEqual(parseArgs([
      '--blocks=100', '--min-deployments=2', '--concurrency=8',
    ]), { blocks: 100, minDeployments: 2, concurrency: 8 });
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const lines = [];
    const report = await main([], {
      options: {}, canary: { async inspect() { return { approved: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
