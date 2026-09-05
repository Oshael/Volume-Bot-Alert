'use strict';

const DEFAULT_BLOCKS = 64;
const DEFAULT_MIN_TRANSFERS = 100;
const TRANSFER_FIELDS = Object.freeze([
  'blockNumber', 'blockHash', 'transactionHash', 'transactionIndex', 'logIndex',
  'tokenAddress', 'fromWallet', 'toWallet', 'amountRaw',
]);

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function identity(transfer) {
  return `${transfer.transactionHash}:${transfer.logIndex}`;
}

function differingFields(left, right) {
  return TRANSFER_FIELDS.filter((field) => String(left[field]) !== String(right[field]));
}

function compareTransfers(legacyTransfers, canonicalTransfers) {
  const legacyOrder = legacyTransfers.map(identity);
  const canonicalOrder = canonicalTransfers.map(identity);
  const legacy = new Map(legacyTransfers.map((transfer) => [identity(transfer), transfer]));
  const canonical = new Map(canonicalTransfers.map((transfer) => [identity(transfer), transfer]));
  const missingCanonical = [];
  const missingLegacy = [];
  const divergent = [];
  let matched = 0;
  for (const [key, transfer] of legacy) {
    const candidate = canonical.get(key);
    if (!candidate) missingCanonical.push(key);
    else {
      const fields = differingFields(transfer, candidate);
      if (fields.length) divergent.push({ identity: key, fields });
      else matched += 1;
    }
  }
  for (const key of canonical.keys()) if (!legacy.has(key)) missingLegacy.push(key);
  const comparableOrder = missingCanonical.length === 0 && missingLegacy.length === 0;
  const orderDivergent = comparableOrder
    && legacyOrder.some((key, index) => key !== canonicalOrder[index]);
  return Object.freeze({
    legacy: legacy.size, canonical: canonical.size, matched,
    missing_canonical: missingCanonical.length, missing_legacy: missingLegacy.length,
    divergent: divergent.length, order_divergent: orderDivergent,
    samples: Object.freeze({
      missing_canonical: Object.freeze(missingCanonical.slice(0, 10)),
      missing_legacy: Object.freeze(missingLegacy.slice(0, 10)),
      divergent: Object.freeze(divergent.slice(0, 10).map(Object.freeze)),
    }),
  });
}

function sourceSummary(head, range) {
  return Object.freeze({
    head: head.head, safe_head: head.safeHead,
    checkpoint: range.checkpoint,
    transfers: range.transfers.length,
    observed_logs: Number(range.telemetry?.observedLogs || 0),
    ignored_malformed_logs: Number(range.telemetry?.ignoredMalformedLogs || 0),
    requests: Number(range.telemetry?.requests || 0),
    splits: Number(range.telemetry?.splits || 0),
  });
}

function createRobinhoodCanonicalHolderCanary(options = {}) {
  const readiness = options.readiness;
  const legacySource = options.legacySource;
  const canonicalSource = options.canonicalSource;
  if (typeof readiness?.inspect !== 'function') throw new TypeError('holder readiness is required');
  if (typeof legacySource?.getSafeHead !== 'function'
      || typeof legacySource?.readGlobalRange !== 'function') {
    throw new TypeError('legacy holder source is required');
  }
  if (typeof canonicalSource?.getSafeHead !== 'function'
      || typeof canonicalSource?.readGlobalRange !== 'function') {
    throw new TypeError('canonical holder source is required');
  }

  async function inspect(input = {}) {
    const blocks = boundedInteger(input.blocks, DEFAULT_BLOCKS, 1, 1000, 'blocks');
    const minTransfers = boundedInteger(
      input.minTransfers, DEFAULT_MIN_TRANSFERS, 0, 1_000_000, 'minTransfers'
    );
    const confirmations = boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations');
    const preflight = await readiness.inspect();
    if (!preflight.ready) {
      return Object.freeze({
        mode: 'read-only', phase: 'canary', approved: false,
        blockers: Object.freeze([{ code: 'preflight_not_ready', detail: preflight.blockers }]),
        preflight, range: null, sources: null, parity: null,
      });
    }

    const [legacyHead, canonicalHead] = await Promise.all([
      legacySource.getSafeHead(confirmations), canonicalSource.getSafeHead(confirmations),
    ]);
    const toBlock = BigInt(legacyHead.safeHead) < BigInt(canonicalHead.safeHead)
      ? BigInt(legacyHead.safeHead) : BigInt(canonicalHead.safeHead);
    const width = BigInt(blocks);
    const fromBlock = toBlock + 1n > width ? toBlock - width + 1n : 0n;
    const readInput = {
      tokenAddresses: [], captureAllTransfers: true,
      fromBlock: fromBlock.toString(), toBlock: toBlock.toString(),
    };
    const [legacyRange, canonicalRange] = await Promise.all([
      legacySource.readGlobalRange(readInput), canonicalSource.readGlobalRange(readInput),
    ]);
    const parity = compareTransfers(legacyRange.transfers, canonicalRange.transfers);
    const legacy = sourceSummary(legacyHead, legacyRange);
    const canonical = sourceSummary(canonicalHead, canonicalRange);
    const blockers = [];
    const add = (condition, code, detail = null) => {
      if (condition) blockers.push(detail == null ? { code } : { code, detail });
    };
    add(legacyRange.checkpoint.hash !== canonicalRange.checkpoint.hash,
      'checkpoint_divergent', {
        legacy: legacyRange.checkpoint.hash, canonical: canonicalRange.checkpoint.hash,
      });
    add(legacy.observed_logs !== canonical.observed_logs, 'raw_log_count_divergent', {
      legacy: legacy.observed_logs, canonical: canonical.observed_logs,
    });
    add(parity.legacy < minTransfers, 'insufficient_transfer_samples', {
      actual: parity.legacy, minimum: minTransfers,
    });
    add(parity.missing_canonical > 0, 'canonical_transfers_missing',
      parity.missing_canonical);
    add(parity.missing_legacy > 0, 'legacy_transfers_missing', parity.missing_legacy);
    add(parity.divergent > 0, 'transfer_fields_divergent', parity.divergent);
    add(parity.order_divergent, 'transfer_order_divergent');
    return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: blockers.length === 0,
      blockers: Object.freeze(blockers), preflight,
      range: Object.freeze({
        from_block: fromBlock.toString(), to_block: toBlock.toString(),
        blocks, confirmations,
      }),
      sources: Object.freeze({ legacy, canonical }), parity,
    });
  }

  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_BLOCKS,
  DEFAULT_MIN_TRANSFERS,
  compareTransfers,
  createRobinhoodCanonicalHolderCanary,
};
