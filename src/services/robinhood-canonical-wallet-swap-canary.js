'use strict';

const senderAdapter = require('./robinhood-transaction-sender-adapter');

const DEFAULT_BLOCKS = 64;
const DEFAULT_MIN_OBSERVATIONS = 25;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function comparable(result, hash) {
  return {
    wallet: result.resolved.get(hash) || null,
    transaction_index: result.resolvedPositions.get(hash)?.transactionIndex || null,
    block_hash: result.blockHash,
    block_time: result.blockTime,
  };
}

function compareGroup(observations, legacyBlock, canonicalBlock) {
  const hashes = observations.map(({ transaction_hash }) => transaction_hash);
  const expectedBlockNumber = observations[0].block_number;
  const legacy = senderAdapter.resolveSenders(legacyBlock, hashes, { expectedBlockNumber });
  const canonical = senderAdapter.resolveSenders(canonicalBlock, hashes, { expectedBlockNumber });
  const rows = [];
  for (const observation of observations) {
    const hash = String(observation.transaction_hash).toLowerCase();
    const left = comparable(legacy, hash);
    const right = comparable(canonical, hash);
    const fields = Object.keys(left).filter((field) => left[field] !== right[field]);
    rows.push({
      identity: `${hash}:${observation.log_index}`,
      missing_legacy: left.wallet == null,
      missing_canonical: right.wallet == null,
      fields,
    });
  }
  return rows;
}

function summarize(rows, errors) {
  const missingLegacy = rows.filter(({ missing_legacy }) => missing_legacy);
  const missingCanonical = rows.filter(({ missing_canonical }) => missing_canonical);
  const divergent = rows.filter((row) => (
    !row.missing_legacy && !row.missing_canonical && row.fields.length > 0
  ));
  return Object.freeze({
    observations: rows.length,
    matched: rows.filter((row) => (
      !row.missing_legacy && !row.missing_canonical && row.fields.length === 0
    )).length,
    missing_legacy: missingLegacy.length,
    missing_canonical: missingCanonical.length,
    divergent: divergent.length,
    source_errors: errors.length,
    samples: Object.freeze({
      missing_legacy: missingLegacy.slice(0, 10).map(({ identity }) => identity),
      missing_canonical: missingCanonical.slice(0, 10).map(({ identity }) => identity),
      divergent: divergent.slice(0, 10).map(({ identity, fields }) => ({ identity, fields })),
      source_errors: errors.slice(0, 10),
    }),
  });
}

function createRobinhoodCanonicalWalletSwapCanary(options = {}) {
  const { readiness, reader, canonicalSource, fetchLegacyBlock } = options;
  if (typeof readiness?.inspect !== 'function') throw new TypeError('wallet readiness is required');
  if (typeof reader?.readAcceptedBlockGroups !== 'function') {
    throw new TypeError('wallet observation reader is required');
  }
  if (typeof canonicalSource?.loadBlock !== 'function') {
    throw new TypeError('canonical block source is required');
  }
  if (typeof fetchLegacyBlock !== 'function') throw new TypeError('legacy block source is required');

  async function inspect(input = {}) {
    const blocks = boundedInteger(input.blocks, DEFAULT_BLOCKS, 1, 1000, 'blocks');
    const minimum = boundedInteger(
      input.minObservations, DEFAULT_MIN_OBSERVATIONS, 0, 1_000_000, 'minObservations'
    );
    const preflight = await readiness.inspect();
    if (!preflight.ready) return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: false,
      blockers: [{ code: 'preflight_not_ready', detail: preflight.blockers }],
      preflight, range: null, parity: null,
    });
    const toBlock = BigInt(preflight.wallet.checkpoint_block);
    const journalStart = BigInt(preflight.handoff.journal_start_block);
    const candidateFrom = toBlock + 1n > BigInt(blocks) ? toBlock - BigInt(blocks) + 1n : 0n;
    const fromBlock = candidateFrom > journalStart ? candidateFrom : journalStart;
    const source = await reader.readAcceptedBlockGroups({
      fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), maxBlocks: blocks,
    });
    const compared = [];
    const errors = [];
    for (const [blockNumber, observations] of source.groups) {
      try {
        const [legacyBlock, canonicalBlock] = await Promise.all([
          fetchLegacyBlock(blockNumber), canonicalSource.loadBlock(blockNumber),
        ]);
        compared.push(...compareGroup(observations, legacyBlock, canonicalBlock));
      } catch (error) {
        errors.push({ block_number: String(blockNumber), message: String(error.message).slice(0, 300) });
      }
    }
    const parity = summarize(compared, errors);
    const blockers = [];
    const add = (condition, code, detail) => {
      if (condition) blockers.push(detail == null ? { code } : { code, detail });
    };
    add(parity.observations < minimum, 'insufficient_observation_samples', {
      actual: parity.observations, minimum,
    });
    add(parity.source_errors > 0, 'block_source_errors', parity.source_errors);
    add(parity.missing_legacy > 0, 'legacy_transaction_context_missing', parity.missing_legacy);
    add(parity.missing_canonical > 0,
      'canonical_transaction_context_missing', parity.missing_canonical);
    add(parity.divergent > 0, 'transaction_context_divergent', parity.divergent);
    return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: blockers.length === 0, blockers,
      range: {
        from_block: fromBlock.toString(), to_block: toBlock.toString(),
        requested_blocks: blocks, compared_blocks: source.groups.length,
      },
      parity,
    });
  }

  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_BLOCKS, DEFAULT_MIN_OBSERVATIONS, compareGroup,
  createRobinhoodCanonicalWalletSwapCanary,
};
