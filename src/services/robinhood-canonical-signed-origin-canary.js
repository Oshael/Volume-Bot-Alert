'use strict';

const DEFAULT_BLOCKS = 64;
const DEFAULT_MIN_TRANSACTIONS = 100;
const BLOCK_FIELDS = Object.freeze(['number', 'hash', 'blockTime', 'transactionCount']);
const ORIGIN_FIELDS = Object.freeze([
  'walletAddress', 'transactionHash', 'transactionIndex', 'nonce',
  'blockNumber', 'blockHash', 'blockTime', 'coverageOriginBlock', 'sourceStream',
]);

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function compareRows(leftRows, rightRows, fields, identity) {
  const left = new Map(leftRows.map((row) => [identity(row), row]));
  const right = new Map(rightRows.map((row) => [identity(row), row]));
  const missingCanonical = [];
  const missingLegacy = [];
  const divergent = [];
  let matched = 0;
  for (const [key, row] of left) {
    const candidate = right.get(key);
    if (!candidate) missingCanonical.push(key);
    else {
      const differences = fields.filter((field) => String(row[field]) !== String(candidate[field]));
      if (differences.length) divergent.push({ identity: key, fields: differences });
      else matched += 1;
    }
  }
  for (const key of right.keys()) if (!left.has(key)) missingLegacy.push(key);
  return {
    legacy: left.size, canonical: right.size, matched,
    missing_canonical: missingCanonical.length, missing_legacy: missingLegacy.length,
    divergent: divergent.length,
    samples: { missing_canonical: missingCanonical.slice(0, 10),
      missing_legacy: missingLegacy.slice(0, 10), divergent: divergent.slice(0, 10) },
  };
}

function createRobinhoodCanonicalSignedOriginCanary(options = {}) {
  const { readiness, legacySource, canonicalSource } = options;
  if (typeof readiness?.inspect !== 'function') throw new TypeError('signed-origin readiness is required');
  if (typeof legacySource?.readBlocks !== 'function'
      || typeof canonicalSource?.readBlocks !== 'function') {
    throw new TypeError('signed-origin canary sources are required');
  }

  async function inspect(input = {}) {
    const blocks = bounded(input.blocks, DEFAULT_BLOCKS, 1, 200, 'blocks');
    const minimum = bounded(
      input.minTransactions, DEFAULT_MIN_TRANSACTIONS, 0, 1_000_000, 'minTransactions'
    );
    const preflight = await readiness.inspect();
    if (!preflight.ready) return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: false,
      blockers: [{ code: 'preflight_not_ready', detail: preflight.blockers }],
      preflight, range: null, parity: null,
    });
    const toBlock = BigInt(preflight.signed_origin.checkpoint_block);
    const journalStart = BigInt(preflight.handoff.journal_start_block);
    const candidate = toBlock + 1n > BigInt(blocks) ? toBlock - BigInt(blocks) + 1n : 0n;
    const fromBlock = candidate > journalStart ? candidate : journalStart;
    const blockNumbers = Array.from(
      { length: Number(toBlock - fromBlock + 1n) }, (_, index) => String(fromBlock + BigInt(index))
    );
    const readInput = {
      blockNumbers, coverageOriginBlock: preflight.signed_origin.origin_block,
      safeHead: toBlock.toString(), stream: 'live',
    };
    const [legacy, canonical] = await Promise.all([
      legacySource.readBlocks(readInput), canonicalSource.readBlocks(readInput),
    ]);
    const blockParity = compareRows(
      legacy.blocks, canonical.blocks, BLOCK_FIELDS, (row) => row.number
    );
    const originParity = compareRows(
      legacy.origins, canonical.origins, ORIGIN_FIELDS, (row) => row.walletAddress
    );
    const blockers = [];
    const add = (condition, code, detail) => {
      if (condition) blockers.push(detail == null ? { code } : { code, detail });
    };
    add(legacy.metrics.transactionsScanned < minimum, 'insufficient_transaction_samples', {
      actual: legacy.metrics.transactionsScanned, minimum,
    });
    for (const [parity, prefix] of [[blockParity, 'block'], [originParity, 'origin']]) {
      add(parity.missing_canonical > 0, `canonical_${prefix}s_missing`, parity.missing_canonical);
      add(parity.missing_legacy > 0, `legacy_${prefix}s_missing`, parity.missing_legacy);
      add(parity.divergent > 0, `${prefix}_fields_divergent`, parity.divergent);
    }
    return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: blockers.length === 0, blockers,
      range: { from_block: String(fromBlock), to_block: String(toBlock), blocks: blockNumbers.length },
      samples: { legacy_transactions: legacy.metrics.transactionsScanned,
        canonical_transactions: canonical.metrics.transactionsScanned },
      parity: { blocks: blockParity, origins: originParity },
    });
  }
  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_BLOCKS, DEFAULT_MIN_TRANSACTIONS, compareRows,
  createRobinhoodCanonicalSignedOriginCanary,
};
