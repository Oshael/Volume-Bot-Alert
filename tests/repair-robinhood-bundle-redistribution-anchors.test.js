'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  CONFIRM_FLAG, createArchiveResolver, listCandidates, main, parseArgs,
} = require('../src/utils/repair-robinhood-bundle-redistribution-anchors');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const HASH_A = `0x${'c'.repeat(64)}`;
const HASH_B = `0x${'d'.repeat(64)}`;
const TIME = '2026-09-20T12:00:00.000Z';

function candidate(overrides = {}) {
  return { tokenAddress: TOKEN_A,
    observation: { blockNumber: '10', blockHash: null }, eventThroughBlock: '20',
    requestedVersion: '3', source: null,
    holder: { blockNumber: '20', blockHash: HASH_B }, ...overrides };
}

describe('Robinhood redistribution anchor repair', () => {
  it('is read-only by default and requires the explicit confirmation pair', () => {
    assert.deepEqual(parseArgs([]), {
      apply: false, limit: 100, concurrency: 2, timeoutMs: 60000,
    });
    assert.deepEqual(parseArgs([
      '--apply', CONFIRM_FLAG, '--limit=5', '--concurrency=4', '--timeout-ms=5000',
    ]), { apply: true, limit: 5, concurrency: 4, timeoutMs: 5000 });
    assert.throws(() => parseArgs(['--apply']), /requires/);
  });

  it('selects only pending versions with incomplete durable lineage', async () => {
    let captured;
    const rows = [{ token_address: TOKEN_A, observation_from_block: '10',
      observation_from_hash: null, observation_from_time: null, event_through_block: '20',
      requested_version: '3', source_through_block: null, source_through_hash: null,
      source_through_time: null, source_requested_version: null, ledger_status: 'live',
      live_through_block: '20', live_through_hash: HASH_B }];
    const result = await listCandidates({ async query(sql, params) {
      captured = { sql, params }; return { rows };
    } }, 5);
    assert.match(captured.sql, /queue\.status='pending'/);
    assert.match(captured.sql, /source_requested_version IS DISTINCT FROM/);
    assert.match(captured.sql,
      /ORDER BY CASE[\s\S]*holder\.live_through_block >= queue\.event_through_block/);
    assert.equal(captured.params[2], 5);
    assert.equal(result[0].tokenAddress, TOKEN_A);
    assert.equal(result[0].holder.blockHash, HASH_B);
  });

  it('reports local and archive coverage without requiring RPC in dry-run', async () => {
    const local = new Map([
      ['10', { blockNumber: '10', blockHash: HASH_A, blockTime: TIME, source: 'postgres' }],
      ['20', { blockNumber: '20', blockHash: HASH_B, blockTime: TIME, source: 'postgres' }],
    ]);
    const report = await main([], { database: {}, logger: { log() {} },
      listCandidates: async () => [candidate()], loadLocalBlocks: async () => local,
      createArchiveResolver() { throw new Error('archive must remain lazy'); } });
    assert.deepEqual({ mode: report.mode, localReady: report.localReady,
      archiveRequired: report.archiveRequired, blocked: report.blocked },
    { mode: 'read-only', localReady: 1, archiveRequired: 0, blocked: 0 });
  });

  it('validates Archive chain, block number, hash and timestamp', async () => {
    const calls = [];
    const resolve = createArchiveResolver({ timeoutMs: 5000 }, {
      env: { ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive.example' },
      rpcClientFactory() { return { async request(method, params) {
        calls.push([method, params]);
        if (method === 'eth_chainId') return '0x1237';
        return { number: '0x32', hash: HASH_A, timestamp: '0x68cfe920' };
      } }; },
    });
    const block = await resolve('50', HASH_A);
    assert.equal(block.blockNumber, '50');
    assert.equal(block.source, 'archive');
    assert.deepEqual(calls.map(([method]) => method), ['eth_chainId', 'eth_getBlockByNumber']);
    await assert.rejects(resolve('50', HASH_B), /diverged/);
  });

  it('persists local repairs, leaves blocked candidates unresolved, and never opens Archive',
    async () => {
      const local = new Map([
        ['10', { blockNumber: '10', blockHash: HASH_A, blockTime: TIME, source: 'postgres' }],
        ['20', { blockNumber: '20', blockHash: HASH_B, blockTime: TIME, source: 'postgres' }],
      ]); const persisted = [];
      const report = await main([], { options: { apply: true, limit: 2,
        concurrency: 2, timeoutMs: 5000 }, database: {}, logger: { log() {} },
      listCandidates: async () => [candidate(), candidate({ tokenAddress: TOKEN_B, holder: null })],
      loadLocalBlocks: async () => local,
      async persistCandidate(_database, item, anchors) { persisted.push({ item, anchors }); return true; },
      createArchiveResolver() { throw new Error('archive must remain lazy'); } });
      assert.equal(report.repaired, 1);
      assert.equal(report.unresolved, 1);
      assert.equal(persisted[0].anchors.observation.source, 'postgres');
    });
});
