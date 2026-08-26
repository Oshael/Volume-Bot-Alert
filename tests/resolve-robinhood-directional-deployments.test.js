process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, main, parseArgs, resolveBatch,
  __private: { buildRuntime },
} = require('../src/utils/resolve-robinhood-directional-deployments');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const CREATOR = `0x${'c'.repeat(40)}`;
const HASH = `0x${'d'.repeat(64)}`;

describe('Robinhood directional deployment resolver', () => {
  it('passes the requested timeout to the Blockscout client without truncating it', () => {
    let clientOptions;
    buildRuntime({ timeoutMs: 30_000 }, {
      env: {
        RH_NODE_RPC_URL: 'https://rpc.example',
        ROBINHOOD_BLOCKSCOUT_API_KEY: 'proapi_test',
      },
      database: {},
      rpcClientFactory: () => ({ async request() {} }),
      blockscoutFactory: (options) => {
        clientOptions = options;
        return {};
      },
    });
    assert.equal(clientOptions.timeoutMs, 30_000);
  });

  it('plans without requiring RPC configuration and validates bounds', async () => {
    assert.deepEqual(parseArgs(['--run-id=1']), {
      confirm: false, runId: '1', limit: 1000, batchSize: 10,
      concurrency: 4, timeoutMs: 30000,
    });
    assert.throws(() => parseArgs([]), /--run-id is required/);
    assert.throws(() => parseArgs(['--run-id=1', '--batch-size=11']), /between 1 and 10/);
    const report = await main(['--run-id=1'], {
      logger: { log() {} }, env: {},
      gaps: { async plan() { return { unresolved: 2, verifiable: 1, unsupported: 1 }; } },
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.plan.verifiable, 1);
  });

  it('persists verified deployments and records invalid hints without aborting the batch', async () => {
    const calls = { verified: [], failed: [] };
    const result = await resolveBatch({
      sleep: async () => {},
      blockscout: {
        async getContractCreators() {
          return [
            { tokenAddress: TOKEN_A, creatorAddress: CREATOR, transactionHash: HASH },
            { tokenAddress: TOKEN_B, creatorAddress: null, transactionHash: null },
          ];
        },
      },
      verifier: {
        async verifyDirectDeployment(hint) {
          return { ...hint, source: 'rpc_direct', factoryAddress: null, blockNumber: '100' };
        },
      },
      attributions: {
        async recordVerifiedDirectDeployments(items) { calls.verified.push(...items); },
        async recordDirectVerificationFailure(item) { calls.failed.push(item); },
      },
    }, [
      { tokenAddress: TOKEN_A, creatorAddress: CREATOR },
      { tokenAddress: TOKEN_B, creatorAddress: CREATOR },
    ], { concurrency: 2 });
    assert.deepEqual(result, {
      verified: 1, failed: 1, retries: 0, splits: 0, providerFailures: 0,
    });
    assert.equal(calls.verified[0].blockNumber, '100');
    assert.deepEqual(calls.failed, [{
      tokenAddress: TOKEN_B, error: 'blockscout_deployment_hint_incomplete',
    }]);
  });

  it('runs a confirmed bounded selection through the supplied runtime', async () => {
    const runtime = {
      gaps: {
        async plan() { return { unresolved: 1, verifiable: 1, unsupported: 0 }; },
        async listVerificationCandidates() {
          return [{ tokenAddress: TOKEN_A, creatorAddress: CREATOR }];
        },
      },
      blockscout: {
        async getContractCreators() {
          return [{ tokenAddress: TOKEN_A, creatorAddress: CREATOR, transactionHash: HASH }];
        },
      },
      verifier: {
        async verifyDirectDeployment(hint) {
          return { ...hint, source: 'rpc_direct', factoryAddress: null, blockNumber: '100' };
        },
      },
      attributions: {
        async recordVerifiedDirectDeployments() {},
        async recordDirectVerificationFailure() {},
      },
      sleep: async () => {},
    };
    const report = await main(['--run-id=1', CONFIRM_FLAG], {
      runtime, logger: { log() {} },
    });
    assert.deepEqual(report.summary, {
      candidates: 1, verified: 1, failed: 0, retries: 0,
      splits: 0, providerFailures: 0,
    });
  });

  it('splits timed-out batches and isolates a provider failure to one token', async () => {
    const failed = [];
    const error = Object.assign(new Error('timed out'), {
      code: 'timeout', retryable: true, requestRetriesUsed: 2,
    });
    const result = await resolveBatch({
      sleep: async () => {},
      blockscout: {
        async getContractCreators(tokens) {
          if (tokens.length > 1 || tokens[0] === TOKEN_B) throw error;
          return [{ tokenAddress: TOKEN_A, creatorAddress: CREATOR, transactionHash: HASH }];
        },
      },
      verifier: {
        async verifyDirectDeployment(hint) {
          return { ...hint, source: 'rpc_direct', factoryAddress: null, blockNumber: '100' };
        },
      },
      attributions: {
        async recordVerifiedDirectDeployments() {},
        async recordDirectVerificationFailure(item) { failed.push(item); },
      },
    }, [
      { tokenAddress: TOKEN_A, creatorAddress: CREATOR },
      { tokenAddress: TOKEN_B, creatorAddress: CREATOR },
    ], { concurrency: 2 });
    assert.deepEqual(result, {
      verified: 1, failed: 1, retries: 2, splits: 1, providerFailures: 1,
    });
    assert.deepEqual(failed, [{ tokenAddress: TOKEN_B, error: 'timeout' }]);
  });
});
