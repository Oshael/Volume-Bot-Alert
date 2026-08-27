const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodArchiveDeploymentDiscovery,
} = require('../src/services/robinhood-archive-deployment-discovery');
const {
  FACTORIES, PONS_TOKEN_LAUNCHED_TOPIC,
} = require('../src/services/robinhood-launchpad-creator-adapter');

const TOKEN = `0x${'a'.repeat(40)}`;
const CREATOR = `0x${'b'.repeat(40)}`;
const HINT_HASH = `0x${'c'.repeat(64)}`;
const DEPLOY_HASH = `0x${'d'.repeat(64)}`;
const BLOCK_HASH = `0x${'e'.repeat(64)}`;

function rpcForBlock(transactions = []) {
  const codeBlocks = [];
  return {
    codeBlocks,
    async request(method, params) {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x64' };
      if (method === 'eth_getCode') {
        const block = BigInt(params[1]);
        codeBlocks.push(block);
        return block >= 40n ? '0x6000' : '0x';
      }
      if (method === 'eth_getBlockByNumber') {
        return { number: '0x28', hash: BLOCK_HASH, transactions };
      }
      if (method === 'eth_getLogs') return [];
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe('Robinhood archive deployment discovery', () => {
  it('finds the first bytecode block and recovers a direct deployment', async () => {
    const rpcClient = rpcForBlock([{ hash: DEPLOY_HASH, from: CREATOR, to: null }]);
    rpcClient.requestBatch = async () => [{ contractAddress: TOKEN }];
    const discovery = createRobinhoodArchiveDeploymentDiscovery({
      rpcClient,
      blockCreationLookup: async () => { throw new Error('must not inspect internal calls'); },
    });

    assert.deepEqual(await discovery.discover({ tokenAddress: TOKEN, transactionHash: HINT_HASH }), {
      tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: DEPLOY_HASH,
    });
    assert.ok(rpcClient.codeBlocks.includes(39n));
    assert.ok(rpcClient.codeBlocks.includes(40n));
  });

  it('limits internal creation lookup to the exact first bytecode block', async () => {
    const rpcClient = rpcForBlock([]);
    let lookup;
    const discovery = createRobinhoodArchiveDeploymentDiscovery({
      rpcClient,
      blockCreationLookup: async (tokenAddress, blockNumber) => {
        lookup = { tokenAddress, blockNumber };
        return { tokenAddress: TOKEN, creatorAddress: CREATOR, transactionHash: DEPLOY_HASH };
      },
    });

    const result = await discovery.discover({ tokenAddress: TOKEN, transactionHash: HINT_HASH });

    assert.equal(result.transactionHash, DEPLOY_HASH);
    assert.deepEqual(lookup, { tokenAddress: TOKEN, blockNumber: '40' });
  });

  it('recovers a known launchpad deployment from canonical RPC logs', async () => {
    const factoryAddress = [...FACTORIES.keys()][0];
    const rpcClient = rpcForBlock([]);
    rpcClient.request = async (method, params) => {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return BigInt(params[1]) >= 40n ? '0x6000' : '0x';
      if (method === 'eth_getBlockByNumber') {
        return { number: '0x28', hash: BLOCK_HASH, transactions: [] };
      }
      if (method === 'eth_getLogs') return [{
        address: factoryAddress,
        topics: [
          PONS_TOKEN_LAUNCHED_TOPIC,
          `0x${'0'.repeat(24)}${TOKEN.slice(2)}`,
          `0x${'0'.repeat(24)}${CREATOR.slice(2)}`,
          `0x${'0'.repeat(64)}`,
        ],
        data: `0x${'0'.repeat(448)}`,
        transactionHash: DEPLOY_HASH,
        blockNumber: '0x28',
        blockHash: BLOCK_HASH,
      }];
      throw new Error(`unexpected method ${method}`);
    };
    const discovery = createRobinhoodArchiveDeploymentDiscovery({
      rpcClient,
      blockCreationLookup: async () => { throw new Error('must not use Blockscout'); },
    });

    assert.deepEqual(await discovery.discover({ tokenAddress: TOKEN, upperBlock: '100' }), {
      tokenAddress: TOKEN,
      creatorAddress: CREATOR,
      transactionHash: DEPLOY_HASH,
      blockNumber: '40',
      blockHash: BLOCK_HASH,
      factoryAddress,
      launchpadId: 'pons',
      source: 'launchpad_event',
    });
  });

  it('returns exact block evidence when creator discovery remains unavailable', async () => {
    const rpcClient = rpcForBlock([]);
    const throttled = Object.assign(new Error('rate limited'), {
      code: 'http_error', httpStatus: 429,
    });
    const discovery = createRobinhoodArchiveDeploymentDiscovery({
      rpcClient,
      blockCreationLookup: async () => { throw throttled; },
    });

    assert.deepEqual(await discovery.discover({ tokenAddress: TOKEN, upperBlock: '100' }), {
      tokenAddress: TOKEN, blockNumber: '40', source: 'rpc_code_transition',
    });
    assert.ok(rpcClient.codeBlocks.includes(39n));
    assert.ok(rpcClient.codeBlocks.includes(40n));
  });

  it('fails closed when the hint predates the contract bytecode', async () => {
    const rpcClient = {
      async request(method) {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x64' };
        if (method === 'eth_getCode') return '0x';
        throw new Error(`unexpected method ${method}`);
      },
    };
    const discovery = createRobinhoodArchiveDeploymentDiscovery({
      rpcClient, blockCreationLookup: async () => null,
    });
    await assert.rejects(
      () => discovery.discover({ tokenAddress: TOKEN, transactionHash: HINT_HASH }),
      (error) => error.code === 'archive_deployment_discovery_failed'
    );
  });

  it('fails closed when the archive RPC is not Robinhood Chain', async () => {
    const discovery = createRobinhoodArchiveDeploymentDiscovery({
      rpcClient: { async request() { return '0x1'; } },
      blockCreationLookup: async () => null,
    });
    await assert.rejects(
      () => discovery.discover({ tokenAddress: TOKEN, upperBlock: '100' }),
      /RPC is not Robinhood Chain/
    );
  });
});
