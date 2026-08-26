const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderDeploymentVerifier,
} = require('../src/services/robinhood-holder-deployment-verifier');

const TOKEN = `0x${'a'.repeat(40)}`;
const CREATOR = `0x${'b'.repeat(40)}`;
const TX_HASH = `0x${'c'.repeat(64)}`;
const BLOCK_HASH = `0x${'d'.repeat(64)}`;
const FACTORY = `0x${'e'.repeat(40)}`;

function evidence(overrides = {}) {
  return {
    transaction: {
      hash: TX_HASH, from: CREATOR, to: null,
      blockNumber: '0x64', blockHash: BLOCK_HASH,
      ...overrides.transaction,
    },
    receipt: {
      transactionHash: TX_HASH, contractAddress: TOKEN, status: '0x1',
      blockNumber: '0x64', blockHash: BLOCK_HASH,
      ...overrides.receipt,
    },
    block: { number: '0x64', hash: BLOCK_HASH, ...overrides.block },
  };
}

function rpcFor(values, calls = []) {
  return {
    request: async (method, params = []) => {
      calls.push([method, params]);
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getTransactionByHash') return values.transaction;
      if (method === 'eth_getTransactionReceipt') return values.receipt;
      if (method === 'eth_getBlockByNumber') return values.block;
      if (method === 'trace_transaction') return values.trace;
      if (method === 'debug_traceTransaction') return values.debugTrace;
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe('Robinhood holder deployment verifier', () => {
  it('promotes a Blockscout hint only after direct RPC evidence is canonical', async () => {
    const calls = [];
    const verifier = createRobinhoodHolderDeploymentVerifier({
      rpcClient: rpcFor(evidence(), calls),
    });
    const hint = { tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: TX_HASH };

    assert.deepEqual(await verifier.verifyDirectDeployment(hint), {
      ...hint, source: 'rpc_direct', factoryAddress: null, blockNumber: '100',
    });
    await verifier.verifyDirectDeployment(hint);

    assert.equal(calls.filter(([method]) => method === 'eth_chainId').length, 1);
    assert.deepEqual(calls[3], ['eth_getBlockByNumber', ['0x64', false]]);
  });

  it('promotes an internal factory creation only after RPC trace evidence', async () => {
    const calls = [];
    const values = evidence({
      transaction: { to: FACTORY },
      receipt: { contractAddress: null },
    });
    values.trace = [{
      type: 'create', action: { from: FACTORY }, result: { address: TOKEN },
    }];
    const verifier = createRobinhoodHolderDeploymentVerifier({
      rpcClient: rpcFor(values, calls),
    });

    assert.deepEqual(await verifier.verifyDirectDeployment({
      tokenAddress: TOKEN, creatorAddress: FACTORY, transactionHash: TX_HASH,
    }), {
      tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: TX_HASH,
      source: 'rpc_trace', factoryAddress: FACTORY, blockNumber: '100',
    });
    assert.ok(calls.some(([method]) => method === 'trace_transaction'));
  });

  it('falls back to recursive callTracer evidence for CREATE2', async () => {
    const values = evidence({
      transaction: { to: FACTORY }, receipt: { contractAddress: null },
    });
    values.trace = [];
    values.debugTrace = {
      type: 'CALL', calls: [{ type: 'CREATE2', from: FACTORY, to: TOKEN }],
    };
    const verifier = createRobinhoodHolderDeploymentVerifier({ rpcClient: rpcFor(values) });
    const result = await verifier.verifyDirectDeployment({
      tokenAddress: TOKEN, creatorAddress: FACTORY, transactionHash: TX_HASH,
    });
    assert.equal(result.source, 'rpc_trace');
    assert.equal(result.factoryAddress, FACTORY);
  });

  it('rejects failed, indirect, mismatched, and non-canonical evidence', async () => {
    const cases = [
      evidence({ receipt: { status: '0x0' } }),
      evidence({ transaction: { to: `0x${'e'.repeat(40)}` } }),
      evidence({ receipt: { contractAddress: `0x${'e'.repeat(40)}` } }),
      evidence({ receipt: { contractAddress: null } }),
      evidence({ block: { hash: `0x${'e'.repeat(64)}` } }),
    ];
    for (const values of cases) {
      const verifier = createRobinhoodHolderDeploymentVerifier({ rpcClient: rpcFor(values) });
      await assert.rejects(
        () => verifier.verifyDirectDeployment({
          tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: TX_HASH,
        }),
        (error) => error.code === 'holder_deployment_evidence_invalid'
      );
    }
  });

  it('fails configuration on a non-Robinhood RPC', async () => {
    const verifier = createRobinhoodHolderDeploymentVerifier({
      rpcClient: { request: async () => '0x1' },
    });
    await assert.rejects(
      () => verifier.verifyDirectDeployment({
        tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: TX_HASH,
      }),
      (error) => error.code === 'configuration_error'
    );
  });
});
