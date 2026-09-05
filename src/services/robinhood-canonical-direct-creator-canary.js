'use strict';

const db = require('../models/db');
const {
  FACTORIES, decodeLaunchpadCreatorLog,
} = require('./robinhood-launchpad-creator-adapter');

const CHAIN = 'robinhood';
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

function createCanonicalReader(database = db) {
  async function readRange(fromBlock, toBlock) {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const params = [CHAIN, String(fromBlock), String(toBlock)];
      const [headers, direct, events] = await Promise.all([
        client.query(
          `SELECT block_number, block_hash FROM robinhood_chain_blocks
            WHERE chain=$1 AND canonical=TRUE
              AND block_number BETWEEN $2::bigint AND $3::bigint
            ORDER BY block_number`, params
        ),
        client.query(
          `SELECT block.block_number, block.block_hash, transaction.transaction_hash,
                  transaction.from_address, transaction.contract_address
             FROM robinhood_chain_transactions transaction
             JOIN robinhood_chain_blocks block
               ON block.chain=transaction.chain AND block.block_hash=transaction.block_hash
            WHERE block.chain=$1 AND block.canonical=TRUE
              AND block.block_number BETWEEN $2::bigint AND $3::bigint
              AND transaction.to_address IS NULL
              AND transaction.contract_address IS NOT NULL`, params
        ),
        client.query(
          `SELECT event.block_number, event.block_hash, event.transaction_hash,
                  event.address, event.topics, event.data
             FROM robinhood_chain_events event
             JOIN robinhood_chain_blocks block
               ON block.chain=event.chain AND block.block_hash=event.block_hash
            WHERE block.chain=$1 AND block.canonical=TRUE
              AND event.block_number BETWEEN $2::bigint AND $3::bigint
              AND event.address=ANY($4::varchar[]) AND event.topic0=ANY($5::varchar[])
            ORDER BY event.block_number, event.transaction_index, event.log_index`,
          [...params, [...FACTORIES.keys()],
            [...new Set([...FACTORIES.values()].map(({ topic }) => topic))]]
        ),
      ]);
      const blocks = new Map(headers.rows.map((row) => [String(row.block_number), {
        blockNumber: String(row.block_number), blockHash: row.block_hash, deployments: [],
      }]));
      for (const row of direct.rows) blocks.get(String(row.block_number))?.deployments.push({
        tokenAddress: row.contract_address, creatorAddress: row.from_address,
        transactionHash: row.transaction_hash, blockNumber: String(row.block_number),
        blockHash: row.block_hash, factoryAddress: null, launchpadId: null,
        source: 'rpc_direct',
      });
      for (const row of events.rows) blocks.get(String(row.block_number))?.deployments.push(
        decodeLaunchpadCreatorLog({
          ...row, blockNumber: String(row.block_number), blockHash: row.block_hash,
          transactionHash: row.transaction_hash,
        })
      );
      await client.query('ROLLBACK');
      return blocks;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ readRange });
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
  compareDeployments, createCanonicalReader, createRobinhoodCanonicalDirectCreatorCanary,
};
