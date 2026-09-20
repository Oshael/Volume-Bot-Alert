'use strict';

require('dotenv').config();

const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { RULE_VERSION } = require('./db-init-stage188');

const CHAIN = 'robinhood';
const CHAIN_ID = 4663n;
const CONFIRM_FLAG = '--confirm-repair-robinhood-bundle-redistribution-anchors';
const HASH = /^0x[0-9a-f]{64}$/;

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {}; let apply = false; let confirmed = false;
  for (const argument of argv) {
    if (argument === '--apply' && !apply) apply = true;
    else if (argument === CONFIRM_FLAG && !confirmed) confirmed = true;
    else {
      const match = /^--(limit|concurrency|timeout-ms)=(.+)$/.exec(argument);
      if (!match || values[match[1]] != null) {
        throw new Error(`unknown or repeated argument: ${argument}`);
      }
      values[match[1]] = match[2];
    }
  }
  if (apply !== confirmed) throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  return Object.freeze({ apply,
    limit: bounded(values.limit, 100, 1, 1000, '--limit'),
    concurrency: bounded(values.concurrency, 2, 1, 8, '--concurrency'),
    timeoutMs: bounded(values['timeout-ms'], 60_000, 1000, 300_000, '--timeout-ms') });
}

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} timestamp is invalid`);
  return parsed.toISOString();
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}

function firstField(input, names) {
  for (const name of names) {
    if (input && input[name] != null) return input[name];
  }
  return null;
}

function blockEvidence(input, expectedNumber, expectedHash, source) {
  const number = quantity(firstField(input, ['number', 'block_number', 'blockNumber']),
    `${source} block number`).toString();
  const hash = String(firstField(input, ['hash', 'block_hash', 'blockHash']) || '').toLowerCase();
  const rawTime = firstField(input, ['timestamp', 'block_timestamp', 'blockTime']);
  const blockTime = typeof rawTime === 'string' && /^0x[0-9a-f]+$/i.test(rawTime)
    ? new Date(Number(quantity(rawTime, `${source} timestamp`)) * 1000).toISOString()
    : instant(rawTime, source);
  if (number !== String(expectedNumber) || !HASH.test(hash)
      || (expectedHash && hash !== expectedHash)) {
    throw new Error(`${source} block evidence diverged from the requested anchor`);
  }
  return Object.freeze({ blockNumber: number, blockHash: hash, blockTime, source });
}

async function listCandidates(database, limit) {
  const { rows } = await database.query(`SELECT queue.token_address,
      queue.observation_from_block::text, queue.observation_from_hash,
      queue.observation_from_time, queue.event_through_block::text,
      queue.requested_version::text, queue.source_through_block::text,
      queue.source_through_hash, queue.source_through_time,
      queue.source_requested_version::text, holder.ledger_status,
      holder.live_through_block::text, holder.live_through_hash
    FROM robinhood_bundle_redistribution_queue queue
    LEFT JOIN robinhood_holder_token_states holder
      ON holder.chain=queue.chain AND holder.token_address=queue.token_address
   WHERE queue.chain=$1 AND queue.rule_version=$2 AND queue.status='pending'
     AND (queue.observation_from_hash IS NULL
       OR queue.source_requested_version IS DISTINCT FROM queue.requested_version)
   ORDER BY queue.updated_at, queue.token_address LIMIT $3::int`,
  [CHAIN, RULE_VERSION, limit]);
  return Object.freeze(rows.map((row) => Object.freeze({
    tokenAddress: row.token_address,
    observation: row.observation_from_hash ? Object.freeze({
      blockNumber: row.observation_from_block, blockHash: row.observation_from_hash,
      blockTime: instant(row.observation_from_time, 'observation'), source: 'stored',
    }) : Object.freeze({ blockNumber: row.observation_from_block, blockHash: null }),
    eventThroughBlock: row.event_through_block, requestedVersion: row.requested_version,
    source: row.source_requested_version === row.requested_version ? Object.freeze({
      blockNumber: row.source_through_block, blockHash: row.source_through_hash,
      blockTime: instant(row.source_through_time, 'source'), source: 'stored',
    }) : null,
    holder: row.ledger_status === 'live' && row.live_through_block != null
      ? Object.freeze({ blockNumber: row.live_through_block, blockHash: row.live_through_hash })
      : null,
  })));
}

async function loadLocalBlocks(database, numbers) {
  if (!numbers.length) return new Map();
  const { rows } = await database.query(`SELECT block_number::text, block_hash, block_timestamp
    FROM robinhood_chain_blocks
   WHERE chain=$1 AND canonical AND block_number=ANY($2::bigint[])`, [CHAIN, numbers]);
  return new Map(rows.map((row) => [row.block_number, blockEvidence(row,
    row.block_number, null, 'postgres')]));
}

function target(candidate) {
  if (candidate.source) return candidate.source;
  if (!candidate.holder
      || BigInt(candidate.holder.blockNumber) < BigInt(candidate.eventThroughBlock)) return null;
  return candidate.holder;
}

function requiredBlocks(candidates) {
  return [...new Set(candidates.flatMap((candidate) => [
    ...(candidate.observation.blockHash ? [] : [candidate.observation.blockNumber]),
    ...(candidate.source ? [] : [target(candidate)?.blockNumber]),
  ]).filter(Boolean))];
}

function createArchiveResolver(options, deps = {}) {
  const url = String((deps.env || process.env).ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!url) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required for missing local blocks');
  const client = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-redistribution-anchor-archive', url }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  let validated;
  async function validate() {
    validated ||= client.request('eth_chainId', []).then((value) => {
      if (quantity(value, 'archive chain ID') !== CHAIN_ID) {
        throw new Error('archive RPC is not Robinhood Chain');
      }
    }).catch((error) => { validated = null; throw error; });
    return validated;
  }
  return async (number, expectedHash = null) => {
    await validate();
    const block = await client.request('eth_getBlockByNumber', [
      `0x${BigInt(number).toString(16)}`, false,
    ]);
    return blockEvidence(block, number, expectedHash, 'archive');
  };
}

async function resolveCandidate(candidate, local, archive) {
  const sourceTarget = target(candidate);
  if (!sourceTarget) throw new Error('holder frontier has not reached the queued event');
  async function resolve(value) {
    if (value.blockTime) return value;
    const localBlock = local.get(value.blockNumber);
    if (localBlock) return blockEvidence(localBlock, value.blockNumber, value.blockHash, 'postgres');
    return archive(value.blockNumber, value.blockHash);
  }
  const [observation, source] = await Promise.all([
    resolve(candidate.observation), resolve(candidate.source || sourceTarget),
  ]);
  return Object.freeze({ observation, source });
}

async function persistCandidate(database, candidate, anchors) {
  if (BigInt(anchors.source.blockNumber) < BigInt(candidate.eventThroughBlock)) {
    throw new Error('repaired source frontier is behind the queued event');
  }
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const locked = await client.query(`SELECT requested_version::text
      FROM robinhood_bundle_redistribution_queue
     WHERE chain=$1 AND token_address=$2 AND rule_version=$3 AND status='pending'
       AND requested_version=$4::bigint FOR UPDATE`,
    [CHAIN, candidate.tokenAddress, RULE_VERSION, candidate.requestedVersion]);
    if (!locked.rowCount) { await client.query('ROLLBACK'); return false; }
    for (const anchor of [anchors.observation, anchors.source]) {
      const stored = await client.query(`INSERT INTO robinhood_chain_block_anchors(
        chain, block_number, block_hash, block_timestamp
      ) VALUES ($1, $2::bigint, $3, $4::timestamptz)
      ON CONFLICT (chain, block_number, block_hash) DO UPDATE SET
        block_timestamp=robinhood_chain_block_anchors.block_timestamp
      RETURNING block_timestamp`, [CHAIN, anchor.blockNumber, anchor.blockHash, anchor.blockTime]);
      if (instant(stored.rows[0]?.block_timestamp, 'stored anchor') !== anchor.blockTime) {
        throw new Error('stored anchor timestamp diverged from repaired evidence');
      }
    }
    const updated = await client.query(`UPDATE robinhood_bundle_redistribution_queue SET
      observation_from_hash=$5, observation_from_time=$6::timestamptz,
      source_through_block=$7::bigint, source_through_hash=$8,
      source_through_time=$9::timestamptz, source_requested_version=requested_version,
      next_attempt_at=NOW(), last_error_code=NULL, last_error_message=NULL, updated_at=NOW()
     WHERE chain=$1 AND token_address=$2 AND rule_version=$3 AND status='pending'
       AND requested_version=$4::bigint`, [CHAIN, candidate.tokenAddress, RULE_VERSION,
      candidate.requestedVersion, anchors.observation.blockHash, anchors.observation.blockTime,
      anchors.source.blockNumber, anchors.source.blockHash, anchors.source.blockTime]);
    if (updated.rowCount !== 1) throw new Error('redistribution anchor repair version changed');
    await client.query('COMMIT'); return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { client.release(); }
}

async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0; const output = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor; cursor += 1; output[index] = await operation(items[index]);
    }
  }));
  return output;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv); const database = deps.database || db;
  const candidates = await (deps.listCandidates || listCandidates)(database, options.limit);
  const local = await (deps.loadLocalBlocks || loadLocalBlocks)(database, requiredBlocks(candidates));
  const preview = candidates.map((candidate) => ({ tokenAddress: candidate.tokenAddress,
    observationBlock: candidate.observation.blockNumber,
    sourceBlock: target(candidate)?.blockNumber || null,
    needsArchive: Boolean(target(candidate))
      && [candidate.observation, candidate.source || target(candidate)]
        .some((item) => !item.blockTime && !local.has(item.blockNumber)) }));
  if (!options.apply) {
    const report = { mode: 'read-only', candidates: candidates.length,
      localReady: preview.filter((item) => item.sourceBlock && !item.needsArchive).length,
      archiveRequired: preview.filter((item) => item.needsArchive).length,
      blocked: preview.filter((item) => !item.sourceBlock).length, selection: preview };
    (deps.logger || console).log(JSON.stringify(report, null, 2)); return report;
  }
  let archiveResolver;
  const archive = (...args) => {
    archiveResolver ||= (deps.createArchiveResolver || createArchiveResolver)(options, deps);
    return archiveResolver(...args);
  };
  const outcomes = await mapConcurrent(candidates, options.concurrency, async (candidate) => {
    try {
      const anchors = await resolveCandidate(candidate, local, archive);
      const repaired = await (deps.persistCandidate || persistCandidate)(database, candidate, anchors);
      return { tokenAddress: candidate.tokenAddress, status: repaired ? 'repaired' : 'stale',
        sources: [...new Set([anchors.observation.source, anchors.source.source])] };
    } catch (error) {
      return { tokenAddress: candidate.tokenAddress, status: 'unresolved',
        error: String(error?.message || error).slice(0, 500) };
    }
  });
  const report = { mode: 'apply', candidates: candidates.length,
    repaired: outcomes.filter(({ status }) => status === 'repaired').length,
    stale: outcomes.filter(({ status }) => status === 'stale').length,
    unresolved: outcomes.filter(({ status }) => status === 'unresolved').length, outcomes };
  (deps.logger || console).log(JSON.stringify(report, null, 2)); return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood redistribution anchor repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, createArchiveResolver, listCandidates, main, parseArgs,
  persistCandidate, resolveCandidate,
  __private: { blockEvidence, loadLocalBlocks, requiredBlocks, target } };
