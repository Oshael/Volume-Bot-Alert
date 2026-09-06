'use strict';

const DEFAULT_BLOCKS = 64;
const DEFAULT_MIN_TRANSFERS = 1;
const CONFIRMATIONS = 2n;
const FIELDS = Object.freeze([
  'transactionIndex', 'fromAddress', 'toAddress', 'valueWei',
  'blockNumber', 'blockHash', 'blockTimestamp',
]);

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function compareTransfers(legacyItems, canonicalItems) {
  const legacy = new Map(legacyItems.map((item) => [item.transactionHash, item]));
  const canonical = new Map(canonicalItems.map((item) => [item.transactionHash, item]));
  const missingCanonical = [];
  const missingLegacy = [];
  const divergent = [];
  let matched = 0;
  for (const [identity, item] of legacy) {
    const candidate = canonical.get(identity);
    if (!candidate) missingCanonical.push(identity);
    else {
      const fields = FIELDS.filter((field) => String(item[field] ?? '')
        !== String(candidate[field] ?? ''));
      if (fields.length) divergent.push({ identity, fields });
      else matched += 1;
    }
  }
  for (const identity of canonical.keys()) {
    if (!legacy.has(identity)) missingLegacy.push(identity);
  }
  return Object.freeze({
    legacy: legacy.size, canonical: canonical.size, matched,
    missing_canonical: missingCanonical.length, missing_legacy: missingLegacy.length,
    divergent: divergent.length,
    samples: {
      missing_canonical: missingCanonical.slice(0, 10),
      missing_legacy: missingLegacy.slice(0, 10), divergent: divergent.slice(0, 10),
    },
  });
}

async function observe(reader, numbers) {
  try {
    await reader.assertChain();
    const before = await reader.checkpoint(numbers.at(-1));
    const result = await reader.readBlocks(numbers);
    const after = await reader.checkpoint(numbers.at(-1));
    return { before, after, result, error: null };
  } catch (error) {
    return { before: null, after: null, result: null,
      error: { code: error.code || 'source_error', message: String(error.message).slice(0, 300) } };
  }
}

function parityBlockers(values) {
  const blockers = [];
  const add = (condition, code, detail = null) => {
    if (condition) blockers.push(detail == null ? { code } : { code, detail });
  };
  add(values.legacy.error != null, 'legacy_source_error', values.legacy.error);
  add(values.canonical.error != null, 'canonical_source_error', values.canonical.error);
  if (values.legacy.error || values.canonical.error) return blockers;
  add(values.legacy.before !== values.legacy.after, 'legacy_checkpoint_changed');
  add(values.canonical.before !== values.canonical.after, 'canonical_checkpoint_changed');
  add(values.legacy.after !== values.canonical.after, 'checkpoint_divergent', {
    legacy: values.legacy.after, canonical: values.canonical.after,
  });
  add(values.legacy.result.blocksScanned !== values.expectedBlocks,
    'legacy_block_coverage_incomplete', values.legacy.result.blocksScanned);
  add(values.canonical.result.blocksScanned !== values.expectedBlocks,
    'canonical_block_coverage_incomplete', values.canonical.result.blocksScanned);
  add(values.parity.legacy < values.minimum, 'insufficient_transfer_samples', {
    actual: values.parity.legacy, minimum: values.minimum,
  });
  add(values.parity.missing_canonical > 0,
    'canonical_transfers_missing', values.parity.missing_canonical);
  add(values.parity.missing_legacy > 0,
    'legacy_transfers_missing', values.parity.missing_legacy);
  add(values.parity.divergent > 0, 'transfer_fields_divergent', values.parity.divergent);
  return blockers;
}

function createRobinhoodCanonicalBundleFundingCanary(options = {}) {
  const { readiness, legacyReader, canonicalReader } = options;
  if (typeof readiness?.inspect !== 'function') throw new TypeError('readiness is required');
  if (typeof legacyReader?.readBlocks !== 'function') throw new TypeError('legacy reader is required');
  if (typeof canonicalReader?.readBlocks !== 'function') {
    throw new TypeError('canonical reader is required');
  }

  async function inspect(input = {}) {
    const blocks = bounded(input.blocks, DEFAULT_BLOCKS, 1, 100, 'blocks');
    const minimum = bounded(
      input.minTransfers, DEFAULT_MIN_TRANSFERS, 0, 1_000_000, 'minTransfers'
    );
    const preflight = await readiness.inspect();
    if (!preflight.ready) return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: false,
      blockers: [{ code: 'preflight_not_ready', detail: preflight.blockers }],
      preflight, range: null, parity: null,
    });
    const checkpoint = BigInt(preflight.capture.checkpoint_block);
    const nodeHead = BigInt(preflight.capture.node_head);
    const confirmed = nodeHead >= CONFIRMATIONS ? nodeHead - CONFIRMATIONS : 0n;
    const toBlock = checkpoint < confirmed ? checkpoint : confirmed;
    const journalStart = BigInt(preflight.handoff.journal_start_block);
    const candidate = toBlock + 1n > BigInt(blocks) ? toBlock - BigInt(blocks) + 1n : 0n;
    const fromBlock = candidate > journalStart ? candidate : journalStart;
    const numbers = Array.from({ length: Number(toBlock - fromBlock + 1n) }, (
      _, index
    ) => (fromBlock + BigInt(index)).toString());
    const [legacy, canonical] = await Promise.all([
      observe(legacyReader, numbers), observe(canonicalReader, numbers),
    ]);
    const parity = legacy.result && canonical.result
      ? compareTransfers(legacy.result.transfers, canonical.result.transfers) : null;
    const blockers = parityBlockers({
      legacy, canonical, parity, expectedBlocks: numbers.length, minimum,
    });
    return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: blockers.length === 0, blockers,
      range: { from_block: String(fromBlock), to_block: String(toBlock),
        blocks: numbers.length, confirmations: Number(CONFIRMATIONS) },
      checkpoints: {
        legacy: legacy.after, canonical: canonical.after,
        stable: !legacy.error && !canonical.error
          && legacy.before === legacy.after && canonical.before === canonical.after,
      },
      parity,
    });
  }
  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_BLOCKS, DEFAULT_MIN_TRANSFERS,
  compareTransfers, createRobinhoodCanonicalBundleFundingCanary,
};
