const { normalizeTokenAddress } = require('../utils/token-identity');

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw discoveryError(`${label} is invalid`);
  }
  return BigInt(raw);
}

function blockTag(value) { return `0x${BigInt(value).toString(16)}`; }

function discoveryError(message) {
  return Object.assign(new Error(message), { code: 'archive_deployment_discovery_failed' });
}

function hasCode(value) {
  const code = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(code)) throw discoveryError('eth_getCode returned invalid bytecode');
  return code !== '0x';
}

async function findFirstCodeBlock(rpcClient, tokenAddress, upperBlock) {
  let low = 0n;
  let high = quantity(upperBlock, 'upperBlock');
  if (!hasCode(await rpcClient.request('eth_getCode', [tokenAddress, blockTag(high)]))) {
    throw discoveryError('token bytecode is absent at the creation hint block');
  }
  while (low < high) {
    const middle = (low + high) / 2n;
    if (hasCode(await rpcClient.request('eth_getCode', [tokenAddress, blockTag(middle)]))) {
      high = middle;
    } else {
      low = middle + 1n;
    }
  }
  return low;
}

async function loadReceipts(rpcClient, transactions) {
  const requests = transactions.map((transaction) => ({
    method: 'eth_getTransactionReceipt', params: [transaction.hash],
  }));
  if (requests.length === 0) return [];
  if (typeof rpcClient.requestBatch === 'function') {
    const receipts = [];
    for (let offset = 0; offset < requests.length; offset += 100) {
      receipts.push(...await rpcClient.requestBatch(requests.slice(offset, offset + 100)));
    }
    return receipts;
  }
  return Promise.all(requests.map(({ method, params }) => rpcClient.request(method, params)));
}

async function findDirectCreation(rpcClient, tokenAddress, deploymentBlock) {
  const block = await rpcClient.request(
    'eth_getBlockByNumber', [blockTag(deploymentBlock), true]
  );
  if (quantity(block?.number, 'block.number') !== deploymentBlock
      || !Array.isArray(block?.transactions)) {
    throw discoveryError('deployment block response is incomplete');
  }
  const transactions = block.transactions.filter((transaction) => transaction?.to === null);
  const receipts = await loadReceipts(rpcClient, transactions);
  for (let index = 0; index < transactions.length; index += 1) {
    let contractAddress = null;
    try {
      contractAddress = normalizeTokenAddress('robinhood', receipts[index]?.contractAddress);
    } catch (_) {}
    if (contractAddress !== tokenAddress) continue;
    const transactionHash = String(transactions[index]?.hash ?? '').trim().toLowerCase();
    const creatorAddress = normalizeTokenAddress('robinhood', transactions[index]?.from);
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
      throw discoveryError('direct deployment transaction hash is invalid');
    }
    return Object.freeze({ tokenAddress, creatorAddress, transactionHash });
  }
  return null;
}

function createRobinhoodArchiveDeploymentDiscovery(options = {}) {
  const rpcClient = options.rpcClient;
  const blockCreationLookup = options.blockCreationLookup;
  if (typeof rpcClient?.request !== 'function') {
    throw new TypeError('archive deployment discovery RPC client is required');
  }
  if (typeof blockCreationLookup !== 'function') {
    throw new TypeError('archive deployment block creation lookup is required');
  }

  async function discover(input = {}) {
    const tokenAddress = normalizeTokenAddress('robinhood', input.tokenAddress);
    const transactionHash = String(input.transactionHash ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
      throw discoveryError('creation hint transaction hash is invalid');
    }
    const receipt = await rpcClient.request('eth_getTransactionReceipt', [transactionHash]);
    const upperBlock = quantity(receipt?.blockNumber, 'creation hint receipt.blockNumber');
    const deploymentBlock = await findFirstCodeBlock(rpcClient, tokenAddress, upperBlock);
    const direct = await findDirectCreation(rpcClient, tokenAddress, deploymentBlock);
    if (direct) return direct;
    const internal = await blockCreationLookup(tokenAddress, deploymentBlock.toString());
    if (!internal) throw discoveryError('exact deployment block has no contract creation evidence');
    return internal;
  }

  return Object.freeze({ discover });
}

module.exports = {
  createRobinhoodArchiveDeploymentDiscovery,
  __private: { findDirectCreation, findFirstCodeBlock, hasCode },
};
