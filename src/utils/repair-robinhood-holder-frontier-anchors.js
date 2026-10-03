'use strict';

require('dotenv').config();
const db = require('../models/db');
const { normalizeTokenAddress } = require('./token-identity');
const { lockRobinhoodCanonicalProjection } = require('../models/robinhood-canonical-projection-fence');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createArchiveResolver, __private: { blockEvidence } } = require('./repair-robinhood-bundle-redistribution-anchors');

const CONFIRM_FLAG = '--confirm-repair-robinhood-holder-frontier-anchors';
const failure = (code) => Object.assign(new Error(code), { code });
function bounded(value, fallback, max) {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw failure('holder_anchor_invalid_bound');
  return n;
}
function parseArgs(argv = []) {
  const values = {}; let apply = false; let confirmed = false;
  for (const arg of argv) {
    if (arg === '--apply' && !apply) apply = true;
    else if (arg === CONFIRM_FLAG && !confirmed) confirmed = true;
    else {
      const match = /^--(scan-limit|after-token|block|timeout-ms)=(.+)$/.exec(arg);
      if (!match || values[match[1]] != null) throw failure('holder_anchor_invalid_argument');
      values[match[1]] = match[2];
    }
  }
  if (apply !== confirmed) throw failure('holder_anchor_confirmation_required');
  const block = values.block ?? null;
  if (block != null && (!/^\d+$/.test(block) || BigInt(block) > 9223372036854775807n)) {
    throw failure('holder_anchor_invalid_block');
  }
  return { apply, scanLimit: bounded(values['scan-limit'], 500, 5000),
    timeoutMs: bounded(values['timeout-ms'], 5000, 60000),
    afterToken: values['after-token'] == null ? ''
      : normalizeTokenAddress('robinhood', values['after-token']), block };
}

async function transaction(database, readOnly, action) {
  const client = await database.getClient();
  try {
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL statement_timeout='5000ms'");
    await client.query("SET LOCAL lock_timeout='250ms'");
    const result = await action(client);
    await client.query('COMMIT'); return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {}); throw error;
  } finally { client.release(); }
}

async function readPage(database, options) {
  return transaction(database, true, async (client) => {
    const cursor = (await client.query(`SELECT generation::text, recovery_state,
      checkpoint_block::text, checkpoint_hash FROM robinhood_chain_capture_cursor
      WHERE chain='robinhood'`)).rows[0];
    if (cursor?.recovery_state !== 'running' || cursor.checkpoint_block == null) {
      throw failure('canonical_projection_fence_conflict');
    }
    const { rows } = await client.query(`WITH scanned AS MATERIALIZED (
      SELECT state.chain, state.token_address, state.coverage_generation,
        state.live_through_block, state.live_through_hash
      FROM robinhood_holder_token_states state
      JOIN robinhood_holder_legacy_coverage_manifest manifest
        ON manifest.chain=state.chain AND manifest.token_address=state.token_address
        AND manifest.coverage_generation=state.coverage_generation
      WHERE state.chain='robinhood' AND state.ledger_status='live'
        AND state.tail_capture_from_block IS NULL AND state.live_through_hash IS NOT NULL
        AND state.live_through_block <= $1::bigint AND state.token_address > $2
        AND ($4::bigint IS NULL OR state.live_through_block=$4::bigint)
      ORDER BY state.token_address LIMIT $3::int
    ) SELECT token_address, coverage_generation::text, live_through_block::text,
      live_through_hash, EXISTS (SELECT 1 FROM robinhood_chain_blocks block
        WHERE block.chain=scanned.chain AND block.canonical
          AND block.block_number=scanned.live_through_block
          AND block.block_hash=scanned.live_through_hash) AS raw_ready
      FROM scanned ORDER BY token_address`,
    [cursor.checkpoint_block, options.afterToken, options.scanLimit, options.block]);
    const groups = new Map();
    for (const row of rows.filter((item) => !item.raw_ready)) {
      const key = `${row.live_through_block}:${row.live_through_hash}`;
      if (!groups.has(key)) groups.set(key, { tokenAddress: row.token_address,
        generation: row.coverage_generation, blockNumber: row.live_through_block,
        blockHash: row.live_through_hash, sampledTokens: 0 });
      groups.get(key).sampledTokens += 1;
    }
    return { cursor, candidates: [...groups.values()], scanned: rows.length,
      nextToken: rows.at(-1)?.token_address || null, exhausted: rows.length < options.scanLimit };
  });
}

function createResolver(options, deps = {}) {
  const env = deps.env || process.env;
  const url = env.ROBINHOOD_ARCHIVE_RPC_URL || env.ROBINHOOD_RPC_URL;
  if (!url) throw failure('holder_anchor_rpc_missing');
  return createArchiveResolver(options, { env: { ROBINHOOD_ARCHIVE_RPC_URL: url },
    rpcClientFactory: (config) => (deps.rpcClientFactory || createEvmJsonRpcClient)({
      ...config, maxRetries: 0, minRequestIntervalMs: 100,
    }) });
}

async function persistAnchor(database, candidate, evidence, expectedGeneration) {
  const block = blockEvidence(evidence, candidate.blockNumber, candidate.blockHash, 'verified RPC');
  return transaction(database, false, async (client) => {
    await lockRobinhoodCanonicalProjection(client, null, 'holder anchor repair');
    const cursor = (await client.query(`SELECT generation::text
      FROM robinhood_chain_capture_cursor WHERE chain='robinhood'`)).rows[0];
    if (cursor.generation !== expectedGeneration) throw failure('holder_anchor_generation_changed');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`robinhood-holder-anchor:${block.blockNumber}`]);
    const eligible = await client.query(`SELECT 1 FROM robinhood_holder_token_states state
      JOIN robinhood_holder_legacy_coverage_manifest manifest
        ON manifest.chain=state.chain AND manifest.token_address=state.token_address
        AND manifest.coverage_generation=state.coverage_generation
      WHERE state.chain='robinhood' AND state.token_address=$1
        AND state.coverage_generation=$2::bigint AND state.ledger_status='live'
        AND state.tail_capture_from_block IS NULL AND state.live_through_block=$3::bigint
        AND state.live_through_hash=$4 FOR SHARE OF state, manifest`,
    [candidate.tokenAddress, candidate.generation, block.blockNumber, block.blockHash]);
    if (!eligible.rowCount) return 'stale';
    const conflict = await client.query(`SELECT
      EXISTS (SELECT 1 FROM robinhood_chain_blocks WHERE chain='robinhood'
        AND block_number=$1::bigint AND (
          (canonical AND (block_hash<>$2 OR block_timestamp IS DISTINCT FROM $3::timestamptz))
          OR (block_hash=$2 AND NOT canonical)))
      OR EXISTS (SELECT 1 FROM robinhood_chain_block_anchors WHERE chain='robinhood'
        AND block_number=$1::bigint AND
          (block_hash<>$2 OR block_timestamp IS DISTINCT FROM $3::timestamptz)) AS conflict`,
    [block.blockNumber, block.blockHash, block.blockTime]);
    if (conflict.rows[0].conflict) throw failure('holder_anchor_local_conflict');
    const inserted = await client.query(`INSERT INTO robinhood_chain_block_anchors
      (chain,block_number,block_hash,block_timestamp) VALUES ('robinhood',$1::bigint,$2,$3)
      ON CONFLICT DO NOTHING RETURNING block_hash`,
    [block.blockNumber, block.blockHash, block.blockTime]);
    // Other anchor writers do not share this command's per-height advisory lock.
    const stored = await client.query(`SELECT COUNT(*)::int AS count,
      COALESCE(BOOL_AND(block_hash=$2 AND block_timestamp=$3::timestamptz),FALSE) AS matched
      FROM robinhood_chain_block_anchors WHERE chain='robinhood' AND block_number=$1::bigint`,
    [block.blockNumber, block.blockHash, block.blockTime]);
    if (stored.rows[0].count !== 1 || !stored.rows[0].matched) {
      throw failure('holder_anchor_local_conflict');
    }
    return inserted.rowCount ? 'repaired' : 'already_present';
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv); const database = deps.database || db;
  const page = await readPage(database, options);
  const report = { mode: options.apply ? 'apply' : 'read-only',
    generation: page.cursor.generation, scanned: page.scanned, nextToken: page.nextToken,
    exhausted: page.exhausted, distinctAnchors: page.candidates.length, outcomes: [] };
  if (page.candidates.length) {
    const resolve = deps.resolveBlock || createResolver(options, deps);
    // Bind the RPC view to an already captured checkpoint before trusting older headers.
    blockEvidence(await resolve(page.cursor.checkpoint_block, page.cursor.checkpoint_hash),
      page.cursor.checkpoint_block, page.cursor.checkpoint_hash, 'RPC checkpoint');
    for (const candidate of page.candidates) {
      const outcome = { blockNumber: candidate.blockNumber, blockHash: candidate.blockHash,
        sampledTokens: candidate.sampledTokens };
      try {
        const evidence = blockEvidence(await resolve(candidate.blockNumber, candidate.blockHash),
          candidate.blockNumber, candidate.blockHash, 'RPC frontier');
        outcome.status = options.apply
          ? await persistAnchor(database, candidate, evidence, page.cursor.generation) : 'verified';
      } catch (error) {
        outcome.status = 'unresolved';
        outcome.code = error.code || 'holder_anchor_verification_failed';
      }
      report.outcomes.push(outcome);
    }
  }
  (deps.logger || console).log(JSON.stringify(report)); return report;
}

if (require.main === module) main().then((report) => {
  if (report.outcomes.some((item) => item.status === 'unresolved')) process.exitCode = 1;
}).catch((error) => {
  console.error(JSON.stringify({ code: error.code || 'holder_anchor_repair_failed' }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, parseArgs, readPage, createResolver, persistAnchor, main };
