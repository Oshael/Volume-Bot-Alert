process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, listCandidates, main, parseArgs, recoverCandidate,
  __private: { buildRuntime },
} = require('../src/utils/recover-robinhood-holder-deployments');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const TOKEN_C = `0x${'c'.repeat(40)}`;

function candidate(tokenAddress, upperBlock = '100') {
  return { tokenAddress, upperBlock, createdAt: new Date(), attemptCount: 1 };
}

describe('Robinhood holder archive deployment recovery', () => {
  it('bounds journal lookups after limiting unresolved outbox tasks', async () => {
    let query;
    const rows = await listCandidates({
      async query(sql, params) {
        query = { sql, params };
        return { rows: [{
          token_address: TOKEN_A, upper_block: null,
          created_at: '2026-08-30T21:00:00.000Z', attempt_count: 3,
        }] };
      },
    }, 20);
    assert.match(query.sql, /WITH queued AS MATERIALIZED/);
    assert.match(query.sql, /LIMIT \$1::int[\s\S]+LEFT JOIN LATERAL/);
    assert.deepEqual(query.params, [20]);
    assert.equal(rows[0].upperBlock, null);
  });

  it('is read-only by default and validates bounded options', async () => {
    assert.deepEqual(parseArgs([]), {
      confirm: false, limit: 100, concurrency: 2, timeoutMs: 30000,
    });
    assert.deepEqual(parseArgs([
      CONFIRM_FLAG, '--limit=10', '--concurrency=4', '--timeout-ms=5000',
    ]), {
      confirm: true, limit: 10, concurrency: 4, timeoutMs: 5000,
    });
    assert.throws(() => parseArgs(['--concurrency=9']), /between 1 and 8/);
    const report = await main([], {
      logger: { log() {} },
      listCandidates: async () => [candidate(TOKEN_A)],
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.candidates, 1);
  });

  it('requires a dedicated archive URL only when applying', () => {
    assert.throws(
      () => buildRuntime({ timeoutMs: 30000 }, { env: { RH_NODE_RPC_URL: 'pruned' } }),
      /ROBINHOOD_ARCHIVE_RPC_URL is required/
    );
    let clientOptions;
    buildRuntime({ timeoutMs: 5000 }, {
      env: { ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive.example' },
      database: {},
      rpcClientFactory: (options) => { clientOptions = options; return { request() {} }; },
      attributionFactory: () => ({}),
      discoveryFactory: () => ({}),
      verifierFactory: () => ({}),
    });
    assert.deepEqual(clientOptions, {
      providers: [{
        name: 'robinhood-holder-deployment-archive', url: 'http://archive.example',
      }],
      timeoutMs: 5000,
      maxRetries: 1,
    });
  });

  it('uses the cached archive head when pending mint evidence is absent', async () => {
    let headRequests = 0;
    const runtime = buildRuntime({ timeoutMs: 5000 }, {
      env: { ROBINHOOD_ARCHIVE_RPC_URL: 'http://archive.example' },
      database: {},
      rpcClientFactory: () => ({
        async request(method) {
          assert.equal(method, 'eth_blockNumber');
          headRequests += 1;
          return '0xc8';
        },
      }),
      attributionFactory: () => ({
        async recordCodeTransitions() { return { attributed: 1 }; },
      }),
      discoveryFactory: () => ({
        async discover(input) {
          assert.equal(input.upperBlock, '200');
          return { tokenAddress: input.tokenAddress, blockNumber: '40', source: 'rpc_code_transition' };
        },
      }),
      verifierFactory: () => ({}),
    });

    const first = await recoverCandidate(runtime, candidate(TOKEN_A, null));
    const second = await recoverCandidate(runtime, candidate(TOKEN_B, null));

    assert.equal(first.status, 'recovered');
    assert.equal(second.status, 'recovered');
    assert.equal(headRequests, 1);
  });

  it('persists exact archive evidence and isolates individual failures', async () => {
    const saved = { transitions: [], deployments: [] };
    const report = await main([], {
      options: { confirm: true, limit: 3, concurrency: 2, timeoutMs: 30000 },
      logger: { log() {} },
      listCandidates: async () => [candidate(TOKEN_A), candidate(TOKEN_B), candidate(TOKEN_C)],
      runtime: {
        discovery: {
          async discover(input) {
            if (input.tokenAddress === TOKEN_A) {
              return { tokenAddress: TOKEN_A, blockNumber: '40', source: 'rpc_code_transition' };
            }
            if (input.tokenAddress === TOKEN_B) {
              return { tokenAddress: TOKEN_B, creatorAddress: TOKEN_A, transactionHash: `0x${'d'.repeat(64)}` };
            }
            throw Object.assign(new Error('history unavailable'), { code: 'archive_error' });
          },
        },
        verifier: {
          async verifyDirectDeployment(input) {
            return { ...input, blockNumber: '50', source: 'rpc_direct', factoryAddress: null };
          },
        },
        attributions: {
          async recordCodeTransitions(items) {
            saved.transitions.push(...items);
            return { attributed: items.length };
          },
          async recordVerifiedDirectDeployments(items) {
            saved.deployments.push(...items);
            return { attributed: items.length };
          },
        },
      },
    });

    assert.deepEqual(report, {
      mode: 'apply', candidates: 3, headFallbackCandidates: 0,
      recovered: 2, unchanged: 0, failed: 1,
      bySource: { rpc_code_transition: 1, rpc_direct: 1 },
      failures: [{
        status: 'failed', tokenAddress: TOKEN_C,
        error: 'archive_error:history unavailable',
      }],
    });
    assert.equal(saved.transitions[0].blockNumber, '40');
    assert.equal(saved.deployments[0].blockNumber, '50');
  });
});
