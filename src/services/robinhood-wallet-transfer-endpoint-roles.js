const MAX_ROLE_PROBES = 10_000;
const MAX_BATCH_SIZE = 100;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const PRECOMPILE_ADDRESSES = new Set(Array.from(
  { length: 10 }, (_, index) => `0x${String(index + 1).padStart(40, '0')}`
));

function address(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be a 20-byte address`);
  return normalized;
}

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}

function blockTag(value) {
  return `0x${quantity(value, 'blockNumber').toString(16)}`;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function addressSet(values, label) {
  if (values == null) return new Set();
  if (!Array.isArray(values) && !(values instanceof Set)) throw new TypeError(`${label} must be a list`);
  return new Set([...values].map((value) => address(value, label)));
}

function bytecodePresent(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(normalized)) throw new Error('eth_getCode returned invalid bytecode');
  return normalized.length > 2;
}

function probePlan(input) {
  if (!Array.isArray(input.transfers)) throw new TypeError('transfers must be a list');
  const excluded = new Set([ZERO_ADDRESS, DEAD_ADDRESS, ...PRECOMPILE_ADDRESSES]);
  for (const values of [
    input.poolAddresses, input.routerAddresses, input.contractAddresses, input.walletAddresses,
  ]) {
    for (const value of addressSet(values, 'known endpoint address')) excluded.add(value);
  }
  const probes = new Map();
  for (const transfer of input.transfers) {
    const blockNumber = quantity(transfer.blockNumber, 'transfer.blockNumber').toString();
    const blockHash = String(transfer.blockHash ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(blockHash)) {
      throw new Error('transfer.blockHash must be 32 bytes');
    }
    for (const value of [transfer.fromWallet, transfer.toWallet]) {
      const endpoint = address(value, 'transfer endpoint');
      if (!excluded.has(endpoint)) {
        probes.set(`${endpoint}:${blockNumber}`, { endpoint, blockNumber, blockHash });
      }
    }
  }
  if (probes.size > MAX_ROLE_PROBES) {
    throw new RangeError(`endpoint role probes exceed ${MAX_ROLE_PROBES}`);
  }
  return [...probes.values()].sort((left, right) => (
    BigInt(left.blockNumber) < BigInt(right.blockNumber) ? -1
      : BigInt(left.blockNumber) > BigInt(right.blockNumber) ? 1
        : left.endpoint.localeCompare(right.endpoint)
  ));
}

async function executeProbes(rpcClient, probes, batchSize) {
  const endpointState = new Map();
  const observations = [];
  let batches = 0;
  for (let offset = 0; offset < probes.length; offset += batchSize) {
    const batch = probes.slice(offset, offset + batchSize);
    const codes = await rpcClient.requestBatch(batch.map(({ endpoint, blockNumber }) => ({
      method: 'eth_getCode', params: [endpoint, blockTag(blockNumber)],
    })));
    batches += 1;
    if (!Array.isArray(codes) || codes.length !== batch.length) {
      throw new Error('endpoint role batch returned an invalid result count');
    }
    for (let index = 0; index < batch.length; index += 1) {
      const probe = batch[index];
      const hasCode = bytecodePresent(codes[index]);
      observations.push(Object.freeze({
        endpointAddress: probe.endpoint, endpointRole: hasCode ? 'contract' : 'wallet',
        evidenceBlock: probe.blockNumber, evidenceBlockHash: probe.blockHash,
      }));
      const current = endpointState.get(probe.endpoint);
      if (!current || (!current.hasCode && hasCode)) {
        endpointState.set(probe.endpoint, { ...probe, hasCode });
      }
    }
  }
  return { batches, endpointState, observations };
}

function createRobinhoodWalletTransferEndpointRoleReader(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.requestBatch !== 'function') {
    throw new TypeError('endpoint role RPC batch support is required');
  }
  const batchSize = boundedInteger(options.batchSize, 50, 1, MAX_BATCH_SIZE, 'batchSize');

  async function resolveRoles(input = {}) {
    const probes = probePlan(input);
    const resolved = await executeProbes(rpcClient, probes, batchSize);
    const contractAddresses = [];
    const walletAddresses = [];
    const evidence = [];
    for (const [endpoint, state] of resolved.endpointState) {
      const endpointRole = state.hasCode ? 'contract' : 'wallet';
      (state.hasCode ? contractAddresses : walletAddresses).push(endpoint);
      evidence.push(Object.freeze({
        endpointAddress: endpoint, endpointRole,
        evidenceBlock: state.blockNumber, evidenceBlockHash: state.blockHash,
      }));
    }
    contractAddresses.sort();
    walletAddresses.sort();
    evidence.sort((left, right) => left.endpointAddress.localeCompare(right.endpointAddress));
    return Object.freeze({
      contractAddresses: Object.freeze(contractAddresses),
      walletAddresses: Object.freeze(walletAddresses),
      evidence: Object.freeze(evidence),
      observations: Object.freeze(resolved.observations),
      telemetry: Object.freeze({
        probes: probes.length, batches: resolved.batches,
        endpoints: resolved.endpointState.size,
      }),
    });
  }

  return Object.freeze({ resolveRoles });
}

module.exports = {
  MAX_ROLE_PROBES,
  createRobinhoodWalletTransferEndpointRoleReader,
  __private: { bytecodePresent, probePlan },
};
