'use strict';

const DEFAULTS = Object.freeze({ batchSize: 500, leaseMs: 60_000, maxAttempts: 5 });

function comparable(row) {
  return {
    blockHash: row.block_hash,
    blockNumber: String(row.block_number),
    transactionIndex: String(row.transaction_index),
    address: row.address,
    topics: row.topics,
    data: row.data,
  };
}
function legacyComparable(row) {
  if (!row.legacy_block_hash) return null;
  return {
    blockHash: row.legacy_block_hash,
    blockNumber: String(row.legacy_block_number),
    transactionIndex: String(row.legacy_transaction_index),
    address: row.legacy_address,
    topics: row.legacy_topics,
    data: row.legacy_data,
  };
}
function compareShadowRow(row) {
  const legacy = legacyComparable(row);
  if (!legacy) return { result: 'canonical_only', differences: [] };
  const canonical = comparable(row);
  const differences = Object.keys(canonical).filter((key) => (
    JSON.stringify(canonical[key]) !== JSON.stringify(legacy[key])
  ));
  return { result: differences.length ? 'divergent' : 'matched', differences };
}
function identity(row) {
  return { domain: row.domain, blockHash: row.block_hash, logIndex: row.log_index };
}

function createRobinhoodChainDomainShadowRunner(deps = {}) {
  const repository = deps.repository;
  if (typeof repository?.claimShadow !== 'function') throw new Error('domain outbox repository is required');
  const options = { ...DEFAULTS, ...(deps.options || {}) };
  const domain = String(options.domain || '').toLowerCase();
  const owner = String(options.owner || `robinhood-chain-${domain}-shadow:${process.pid}`);

  async function runOnce() {
    const reclaimed = options.reclaim === false ? 0 : await repository.reclaimExpiredLeases();
    const rows = await repository.claimShadow({
      domain, owner, limit: options.batchSize, leaseMs: options.leaseMs,
    });
    const complete = []; const blocked = [];
    let matched = 0; let canonicalOnly = 0;
    for (const row of rows) {
      const comparison = compareShadowRow(row);
      if (comparison.result === 'divergent') {
        blocked.push({ ...identity(row), error: { code: 'shadow_divergent', ...comparison } });
      } else {
        complete.push(identity(row));
        if (comparison.result === 'matched') matched += 1;
        else canonicalOnly += 1;
      }
    }
    const settled = await repository.settle({
      owner, complete, blocked, maxAttempts: options.maxAttempts,
    });
    return {
      domain, reclaimed, claimed: rows.length, matched, canonicalOnly,
      divergent: blocked.length,
      throughBlock: rows.length ? String(rows[rows.length - 1].block_number) : null,
      ...settled,
    };
  }

  return Object.freeze({ owner, runOnce });
}

module.exports = {
  createRobinhoodChainDomainShadowRunner,
  __private: { compareShadowRow },
};
