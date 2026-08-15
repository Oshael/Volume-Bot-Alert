const RESOLVER_VERSION = 'rh_endpoint_v1';
const EVIDENCE_SOURCE = 'pc_archive';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function boundedLimit(value) {
  const parsed = value == null ? 100 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error('limit must be between 1 and 1000');
  }
  return parsed;
}

function assertDependencies(deps) {
  if (typeof deps.repository?.listUnresolvedCandidates !== 'function'
      || typeof deps.repository?.upsertEvidence !== 'function') {
    throw new TypeError('endpoint role repository is required');
  }
  if (typeof deps.reader?.resolveRoles !== 'function') {
    throw new TypeError('archive endpoint role reader is required');
  }
}

function asTransfers(candidates) {
  return candidates.map((candidate) => Object.freeze({
    blockNumber: candidate.blockNumber,
    blockHash: candidate.blockHash,
    fromWallet: candidate.endpointAddress,
    toWallet: ZERO_ADDRESS,
  }));
}

async function runRobinhoodWalletEndpointRoleBackfill(deps, input = {}) {
  assertDependencies(deps);
  const limit = boundedLimit(input.limit);
  const candidates = await deps.repository.listUnresolvedCandidates(limit);
  if (!candidates.length) {
    return Object.freeze({ status: 'caught-up', candidates: 0, persisted: 0 });
  }
  const resolved = await deps.reader.resolveRoles({ transfers: asTransfers(candidates) });
  const evidence = resolved.evidence.map((item) => ({
    ...item, evidenceSource: EVIDENCE_SOURCE, resolverVersion: RESOLVER_VERSION,
  }));
  const persisted = input.commit === true
    ? await deps.repository.upsertEvidence(evidence) : [];
  return Object.freeze({
    status: input.commit === true ? 'persisted' : 'dry-run',
    candidates: candidates.length, resolved: evidence.length,
    persisted: persisted.length,
    firstBlock: candidates[0].blockNumber,
    lastBlock: candidates[candidates.length - 1].blockNumber,
    roles: Object.freeze({
      wallets: resolved.walletAddresses.length,
      contracts: resolved.contractAddresses.length,
    }),
    telemetry: resolved.telemetry,
  });
}

module.exports = {
  EVIDENCE_SOURCE, RESOLVER_VERSION, runRobinhoodWalletEndpointRoleBackfill,
  __private: { asTransfers, boundedLimit },
};
