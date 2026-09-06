process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, listCandidates, main, parseArgs, repairCandidate,
  __private: { buildRuntime },
} = require('../src/utils/repair-robinhood-bundle-redistribution-creators');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const TX_HASH = `0x${'c'.repeat(64)}`;

describe('Robinhood redistribution creator repair', () => {
  it('selects only exact code transitions blocked on creator evidence', async () => {
    let query;
    const candidates = await listCandidates({
      async query(sql, params) {
        query = { sql, params };
        return { rows: [{ token_address: TOKEN_A, attribution_block: '50' }] };
      },
    }, 20);
    assert.match(query.sql, /creator_unavailable/);
    assert.match(query.sql, /source='rpc_code_transition'/);
    assert.deepEqual(query.params, [20]);
    assert.deepEqual(candidates, [{ tokenAddress: TOKEN_A, blockNumber: '50' }]);
  });

  it('is read-only by default and requires an explicit confirmation pair', async () => {
    assert.deepEqual(parseArgs([]), {
      apply: false, limit: 100, concurrency: 2, timeoutMs: 60000,
    });
    assert.deepEqual(parseArgs([
      '--apply', CONFIRM_FLAG, '--limit=5', '--concurrency=4', '--timeout-ms=5000',
    ]), { apply: true, limit: 5, concurrency: 4, timeoutMs: 5000 });
    assert.throws(() => parseArgs(['--apply']), /requires/);
    const report = await main([], {
      database: {}, logger: { log() {} },
      listCandidates: async () => [{ tokenAddress: TOKEN_A, blockNumber: '50' }],
    });
    assert.equal(report.mode, 'read-only');
  });

  it('requires only the archive RPC and never configures Blockscout', () => {
    assert.throws(() => buildRuntime({ timeoutMs: 5000 }, { env: {} }), /ARCHIVE_RPC_URL/);
    let clientOptions;
    buildRuntime({ timeoutMs: 5000 }, {
      env: { ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive.example' }, database: {},
      rpcClientFactory(options) { clientOptions = options; return { request() {} }; },
      sourceFactory: () => ({}), verifierFactory: () => ({}), attributionFactory: () => ({}),
    });
    assert.equal(clientOptions.providers[0].url, 'http://archive.example');
    assert.equal(JSON.stringify(clientOptions).includes('blockscout'), false);
  });

  it('prefers canonical direct evidence and falls back to exact block traces', async () => {
    const saved = [];
    const runtime = {
      source: { async readRange(block) {
        return new Map([[block, { deployments: block === '50' ? [{
          tokenAddress: TOKEN_A, creatorAddress: TOKEN_B, transactionHash: TX_HASH,
          source: 'rpc_direct', factoryAddress: null, blockNumber: '50',
        }] : [] }]]);
      } },
      verifier: { async verifyBlockTraceDeployment(candidate) {
        return { ...candidate, creatorAddress: TOKEN_A, transactionHash: TX_HASH,
          source: 'rpc_trace', factoryAddress: TOKEN_B };
      } },
      attributions: { async recordVerifiedDirectDeployments(items) { saved.push(...items); } },
    };
    assert.equal((await repairCandidate(runtime, {
      tokenAddress: TOKEN_A, blockNumber: '50',
    })).source, 'rpc_direct');
    assert.equal((await repairCandidate(runtime, {
      tokenAddress: TOKEN_B, blockNumber: '60',
    })).source, 'rpc_trace');
    assert.equal(saved.length, 2);
  });

  it('isolates unresolved tokens and requeues only repaired ones', async () => {
    let requeued;
    const report = await main([], {
      options: { apply: true, limit: 2, concurrency: 2, timeoutMs: 5000 }, database: {},
      logger: { log() {} },
      listCandidates: async () => [
        { tokenAddress: TOKEN_A, blockNumber: '50' },
        { tokenAddress: TOKEN_B, blockNumber: '60' },
      ],
      runtime: {
        source: { async readRange(block) {
          if (block === '60') throw Object.assign(new Error('trace absent'), { code: 'evidence_gap' });
          return new Map([[block, { deployments: [{ tokenAddress: TOKEN_A,
            transactionHash: TX_HASH, source: 'rpc_direct' }] }]]);
        } },
        verifier: {},
        attributions: { async recordVerifiedDirectDeployments() {} },
      },
      async requeue(_database, tokens) { requeued = tokens; return tokens.length; },
    });
    assert.deepEqual(requeued, [TOKEN_A]);
    assert.equal(report.repaired, 1);
    assert.equal(report.unresolved, 1);
  });
});
