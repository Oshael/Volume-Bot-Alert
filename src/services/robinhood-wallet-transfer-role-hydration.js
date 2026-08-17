const { MAX_ADDRESSES } = require('../models/robinhood-wallet-endpoint-role');
const {
  EVIDENCE_SOURCE, RESOLVER_VERSION,
} = require('./robinhood-wallet-endpoint-role-backfill');
const {
  MAX_ROLE_PROBES,
} = require('./robinhood-wallet-transfer-endpoint-roles');

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

function requireMethods(value, names, label) {
  if (!names.every((name) => typeof value?.[name] === 'function')) {
    throw new TypeError(`${label} is required`);
  }
}

function endpoint(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error('transfer endpoint must be a 20-byte address');
  }
  return normalized;
}

function isExcluded(value) {
  return value === ZERO_ADDRESS || value === DEAD_ADDRESS || /^0x0{39}[1-9a]$/.test(value);
}

function endpointAddresses(transfers) {
  if (!Array.isArray(transfers)) throw new TypeError('transfers must be a list');
  const addresses = new Set();
  for (const transfer of transfers) {
    for (const value of [transfer.fromWallet, transfer.toWallet]) {
      const address = endpoint(value);
      if (!isExcluded(address)) addresses.add(address);
    }
  }
  if (addresses.size > MAX_ADDRESSES) {
    throw new RangeError(`endpoint addresses exceed ${MAX_ADDRESSES}`);
  }
  return [...addresses];
}

function knownAddresses(values) {
  if (values == null) return new Set();
  if (!Array.isArray(values) && !(values instanceof Set)) {
    throw new TypeError('known endpoint addresses must be a list');
  }
  return new Set([...values].map(endpoint));
}

function isCovered(role, block) {
  return role && BigInt(block) >= BigInt(role.observedFromBlock)
    && BigInt(block) <= BigInt(role.observedThroughBlock);
}

function unresolvedTransfers(transfers, roles, known = new Set()) {
  const byAddress = new Map(roles.map((role) => [role.endpointAddress, role]));
  const unresolved = new Map();
  for (const transfer of transfers) {
    const blockNumber = BigInt(transfer.blockNumber).toString();
    for (const value of [transfer.fromWallet, transfer.toWallet]) {
      const address = endpoint(value);
      if (known.has(address) || isExcluded(address)
          || isCovered(byAddress.get(address), blockNumber)) continue;
      unresolved.set(`${address}:${blockNumber}`, Object.freeze({
        blockNumber, blockHash: transfer.blockHash,
        fromWallet: address, toWallet: ZERO_ADDRESS,
      }));
    }
  }
  return [...unresolved.values()];
}

function evidenceKey(item) {
  return `${item.endpointAddress}:${BigInt(item.evidenceBlock)}`;
}

function assertCompleteEvidence(planned, evidence) {
  const expected = new Set(planned.map(({ fromWallet, blockNumber }) => (
    `${fromWallet}:${BigInt(blockNumber)}`
  )));
  const actual = new Set(evidence.map(evidenceKey));
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
    throw new Error('archive endpoint role hydration returned incomplete evidence');
  }
}

function chunks(values, size) {
  const result = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function mergeResolvedAddresses(contracts, wallets, result) {
  for (const address of result.walletAddresses || []) {
    if (!contracts.has(address)) wallets.add(address);
  }
  for (const address of result.contractAddresses || []) {
    contracts.add(address);
    wallets.delete(address);
  }
}

function createRobinhoodWalletTransferRoleHydrator(deps = {}) {
  requireMethods(deps.repository, ['loadRoles', 'upsertEvidence'], 'endpoint role repository');
  requireMethods(deps.reader, ['resolveRoles'], 'archive endpoint role reader');

  async function hydrate(input = {}) {
    const transfers = input.transfers || [];
    const addresses = endpointAddresses(transfers);
    const known = knownAddresses(input.knownAddresses);
    const unknownAddresses = addresses.filter((address) => !known.has(address));
    const roles = await deps.repository.loadRoles(unknownAddresses);
    const planned = unresolvedTransfers(transfers, roles, known);
    const knownSkipped = addresses.length - unknownAddresses.length;
    if (!planned.length) {
      return Object.freeze({
        probes: 0, resolved: 0, persisted: 0, knownSkipped,
        contractAddresses: Object.freeze([]), walletAddresses: Object.freeze([]),
      });
    }
    const plans = chunks(planned, MAX_ROLE_PROBES);
    const contractAddresses = new Set();
    const walletAddresses = new Set();
    let resolved = 0;
    let persisted = 0;
    let batches = 0;
    for (const plan of plans) {
      const result = await deps.reader.resolveRoles({ transfers: plan });
      const observations = result.observations || [];
      assertCompleteEvidence(plan, observations);
      const evidence = observations.map((item) => ({
        ...item, evidenceSource: EVIDENCE_SOURCE, resolverVersion: RESOLVER_VERSION,
      }));
      resolved += evidence.length;
      batches += Number(result.telemetry?.batches || 0);
      mergeResolvedAddresses(contractAddresses, walletAddresses, result);
      if (input.commit === true) {
        persisted += (await deps.repository.upsertEvidence(evidence)).length;
      }
    }
    return Object.freeze({
      probes: planned.length, resolved, persisted, knownSkipped,
      contractAddresses: Object.freeze([...contractAddresses].sort()),
      walletAddresses: Object.freeze([...walletAddresses].sort()),
      telemetry: Object.freeze({
        probes: planned.length, batches,
        endpoints: contractAddresses.size + walletAddresses.size,
        chunks: plans.length,
      }),
    });
  }

  return Object.freeze({ hydrate });
}

module.exports = {
  createRobinhoodWalletTransferRoleHydrator,
  __private: {
    chunks, endpointAddresses, isCovered, knownAddresses, unresolvedTransfers,
  },
};
