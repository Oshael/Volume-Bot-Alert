'use strict';

const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

const STATUSES = new Set(['pre_bonded', 'migrated']);
const MAX_CANDIDATES = 500;

function normalizeLimit(value) {
  const limit = Number(value ?? MAX_CANDIDATES);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CANDIDATES) {
    throw new RangeError(`lifecycle candidate limit must be between 1 and ${MAX_CANDIDATES}`);
  }
  return limit;
}

function normalizeRow(row) {
  const chain = normalizeTokenChain(row.chain);
  return Object.freeze({
    chain,
    tokenAddress: normalizeTokenAddress(chain, row.token_address),
    launchpadId: row.launchpad_id,
    status: row.status,
    bondProgressBps: row.bond_progress_bps == null ? null : Number(row.bond_progress_bps),
    curveAddress: row.curve_address == null
      ? null : normalizeTokenAddress(chain, row.curve_address),
    createdAt: row.created_at,
    migratedAt: row.migrated_at,
    lastEventAt: row.last_event_at,
    evidenceSource: row.evidence_source,
    evidenceBlockNumber: String(row.evidence_block_number),
    evidenceBlockHash: row.evidence_block_hash,
    evidenceTransactionHash: row.evidence_transaction_hash,
    evidenceLogIndex: Number(row.evidence_log_index),
    version: String(row.version),
  });
}

function createTokenLaunchpadLifecycleRepository(options = {}) {
  const database = options.database || db;
  async function listCandidates(input = {}) {
    const chain = normalizeTokenChain(input.chain);
    const status = String(input.status || '');
    if (!STATUSES.has(status)) throw new RangeError('lifecycle status is unsupported');
    const limit = normalizeLimit(input.limit);
    const result = await database.query(
      `SELECT * FROM token_launchpad_lifecycle
        WHERE chain=$1 AND status=$2
        ORDER BY CASE WHEN $2='migrated' THEN migrated_at END DESC NULLS LAST,
                 bond_progress_bps DESC NULLS LAST,
                 last_event_at DESC, token_address COLLATE "C" ASC
        LIMIT $3`, [chain, status, limit]
    );
    return Object.freeze(result.rows.map(normalizeRow));
  }
  return Object.freeze({ listCandidates });
}

module.exports = { MAX_CANDIDATES, createTokenLaunchpadLifecycleRepository };
