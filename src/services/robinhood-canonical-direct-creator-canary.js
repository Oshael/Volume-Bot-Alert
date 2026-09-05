'use strict';

const DEFAULT_BLOCKS = 64;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MIN_DEPLOYMENTS = 1;
const FIELDS = Object.freeze([
  'tokenAddress', 'creatorAddress', 'transactionHash', 'blockNumber',
  'blockHash', 'factoryAddress', 'launchpadId', 'source',
]);

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function identity(item) {
  return `${item.transactionHash}:${item.tokenAddress}:${item.source}`;
}

function compareDeployments(legacyItems, canonicalItems) {
  const legacy = new Map(legacyItems.map((item) => [identity(item), item]));
  const canonical = new Map(canonicalItems.map((item) => [identity(item), item]));
  const missingCanonical = [];
  const missingLegacy = [];
  const divergent = [];
  let matched = 0;
  for (const [key, item] of legacy) {
    const candidate = canonical.get(key);
    if (!candidate) missingCanonical.push(key);
    else {
      const fields = FIELDS.filter((field) => String(item[field] ?? '')
        !== String(candidate[field] ?? ''));
      if (fields.length) divergent.push({ identity: key, fields });
      else matched += 1;
    }
  }
  for (const key of canonical.keys()) if (!legacy.has(key)) missingLegacy.push(key);
  return {
    legacy: legacy.size, canonical: canonical.size, matched,
    missing_canonical: missingCanonical.length, missing_legacy: missingLegacy.length,
    divergent: divergent.length,
    samples: {
      missing_canonical: missingCanonical.slice(0, 10),
      missing_legacy: missingLegacy.slice(0, 10), divergent: divergent.slice(0, 10),
    },
  };
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}

function createRobinhoodCanonicalDirectCreatorCanary(options = {}) {
  const { readiness, canonicalReader, scanLegacyBlock } = options;
  if (typeof readiness?.inspect !== 'function') throw new TypeError('creator readiness is required');
  if (typeof canonicalReader?.readRange !== 'function') {
    throw new TypeError('canonical creator reader is required');
  }
  if (typeof scanLegacyBlock !== 'function') throw new TypeError('legacy creator source is required');

  async function inspect(input = {}) {
    const blocks = bounded(input.blocks, DEFAULT_BLOCKS, 1, 200, 'blocks');
    const concurrency = bounded(input.concurrency, DEFAULT_CONCURRENCY, 1, 16, 'concurrency');
    const minimum = bounded(
      input.minDeployments, DEFAULT_MIN_DEPLOYMENTS, 0, 100_000, 'minDeployments'
    );
    const preflight = await readiness.inspect();
    if (!preflight.ready) return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: false,
      blockers: [{ code: 'preflight_not_ready', detail: preflight.blockers }],
      preflight, range: null, parity: null,
    });
    const toBlock = BigInt(preflight.direct_creator.checkpoint_block);
    const journalStart = BigInt(preflight.handoff.journal_start_block);
    const candidate = toBlock + 1n > BigInt(blocks) ? toBlock - BigInt(blocks) + 1n : 0n;
    const fromBlock = candidate > journalStart ? candidate : journalStart;
    const numbers = Array.from(
      { length: Number(toBlock - fromBlock + 1n) }, (_, index) => fromBlock + BigInt(index)
    );
    const canonical = await canonicalReader.readRange(fromBlock, toBlock);
    const sourceErrors = [];
    const legacy = await mapConcurrent(numbers, concurrency, async (blockNumber) => {
      try { return await scanLegacyBlock(blockNumber); } catch (error) {
        sourceErrors.push({ block_number: String(blockNumber), message: String(error.message).slice(0, 300) });
        return null;
      }
    });
    const legacyDeployments = legacy.flatMap((block) => (block?.deployments || []).map((item) => ({
      ...item,
      blockNumber: item.blockNumber ?? block.blockNumber,
      blockHash: item.blockHash ?? block.blockHash,
    })));
    const canonicalDeployments = [...canonical.values()].flatMap(({ deployments }) => deployments);
    const parity = compareDeployments(legacyDeployments, canonicalDeployments);
    const missingBlocks = numbers.filter((number) => !canonical.has(String(number))).map(String);
    const hashDivergent = legacy.filter((block) => block
      && canonical.get(String(block.blockNumber))?.blockHash !== block.blockHash).map((block) => ({
      block_number: String(block.blockNumber), legacy: block.blockHash,
      canonical: canonical.get(String(block.blockNumber))?.blockHash || null,
    }));
    Object.assign(parity, {
      block_hash_divergent: hashDivergent.length, source_errors: sourceErrors.length,
      samples: { ...parity.samples, block_hash_divergent: hashDivergent.slice(0, 10),
        source_errors: sourceErrors.slice(0, 10) },
    });
    const blockers = [];
    const add = (condition, code, detail) => {
      if (condition) blockers.push(detail == null ? { code } : { code, detail });
    };
    add(parity.legacy < minimum, 'insufficient_deployment_samples', {
      actual: parity.legacy, minimum,
    });
    add(missingBlocks.length > 0, 'canonical_blocks_missing', {
      count: missingBlocks.length, first_block: missingBlocks[0],
    });
    add(parity.source_errors > 0, 'legacy_source_errors', parity.source_errors);
    add(parity.block_hash_divergent > 0, 'block_hash_divergent', parity.block_hash_divergent);
    add(parity.missing_canonical > 0, 'canonical_deployments_missing', parity.missing_canonical);
    add(parity.missing_legacy > 0, 'legacy_deployments_missing', parity.missing_legacy);
    add(parity.divergent > 0, 'deployment_fields_divergent', parity.divergent);
    return Object.freeze({
      mode: 'read-only', phase: 'canary', approved: blockers.length === 0, blockers,
      range: { from_block: String(fromBlock), to_block: String(toBlock),
        requested_blocks: blocks, compared_blocks: numbers.length - sourceErrors.length },
      parity,
    });
  }
  return Object.freeze({ inspect });
}

module.exports = {
  DEFAULT_BLOCKS, DEFAULT_CONCURRENCY, DEFAULT_MIN_DEPLOYMENTS,
  compareDeployments, createRobinhoodCanonicalDirectCreatorCanary,
};
