const db = require('./db');
const { persistTransferProjection } = require('./robinhood-wallet-transfer-projection');

const CHAIN = 'robinhood';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const EDGE_KINDS = new Set(['wallet_transfer', 'dex_flow']);
const TARGET_KINDS = new Set([
  'mint', 'burn', 'dex_flow', 'liquidity_flow',
  'router_flow', 'wallet_transfer', 'contract_flow',
]);

function identifier(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function fixedHex(value, label, bytes) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function index(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized) || BigInt(normalized) > 2_147_483_647n) {
    throw new Error('logIndex must be a PostgreSQL integer');
  }
  return Number(normalized);
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  if (Number.isNaN(date.getTime())) throw new Error('blockTime must be a timestamp');
  return date.toISOString();
}

function decisionEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error('decisionEvidence must be a non-empty object');
  }
  const serialized = JSON.stringify(value);
  if (!serialized) throw new Error('decisionEvidence must be JSON serializable');
  return JSON.parse(serialized);
}

function normalizeTransition(input = {}) {
  const toTransferKind = String(input.toTransferKind ?? '').trim();
  if (!TARGET_KINDS.has(toTransferKind)) throw new Error('toTransferKind is invalid');
  return Object.freeze({
    transactionHash: fixedHex(input.transactionHash, 'transactionHash', 32),
    logIndex: index(input.logIndex),
    blockTime: timestamp(input.blockTime),
    fromClassificationVersion: identifier(
      input.fromClassificationVersion, 'fromClassificationVersion'
    ),
    toTransferKind,
    toClassificationVersion: identifier(input.toClassificationVersion, 'toClassificationVersion'),
    transitionVersion: identifier(input.transitionVersion, 'transitionVersion'),
    decisionReason: identifier(input.decisionReason, 'decisionReason'),
    decisionEvidence: decisionEvidence(input.decisionEvidence),
  });
}

function utcDay(value) {
  const normalized = String(value ?? '').trim();
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== normalized) throw new Error('day must be a valid UTC day');
  return normalized;
}

function candidate(row) {
  return Object.freeze({
    blockNumber: String(row.block_number), blockHash: row.block_hash,
    blockTime: new Date(row.block_time).toISOString(), transactionHash: row.transaction_hash,
    transactionIndex: String(row.transaction_index), logIndex: String(row.log_index),
    tokenAddress: row.token_address, fromWallet: row.from_wallet, toWallet: row.to_wallet,
    amountRaw: String(row.amount_raw), transferKind: row.transfer_kind,
    classificationVersion: row.classification_version,
    fromRoleEvidence: Object.freeze(row.from_role_evidence),
    toRoleEvidence: Object.freeze(row.to_role_evidence),
  });
}

async function lockRawEvent(client, transition) {
  const result = await client.query(
    `SELECT * FROM robinhood_token_transfer_events
     WHERE chain = $1 AND transaction_hash = $2 AND log_index = $3
       AND block_time = $4::timestamptz FOR UPDATE`,
    [CHAIN, transition.transactionHash, transition.logIndex, transition.blockTime]
  );
  return result.rows[0] || null;
}

async function matchingAuditExists(client, transition) {
  const result = await client.query(
    `SELECT 1 FROM robinhood_wallet_transfer_reclassifications
     WHERE chain = $1 AND transaction_hash = $2 AND log_index = $3
       AND block_time = $4::timestamptz AND from_transfer_kind = 'unknown'
       AND from_classification_version = $5 AND to_transfer_kind = $6
       AND to_classification_version = $7 AND transition_version = $8
       AND decision_reason = $9 AND decision_evidence = $10::jsonb`,
    [CHAIN, transition.transactionHash, transition.logIndex, transition.blockTime,
      transition.fromClassificationVersion, transition.toTransferKind,
      transition.toClassificationVersion, transition.transitionVersion,
      transition.decisionReason, JSON.stringify(transition.decisionEvidence)]
  );
  return result.rowCount === 1;
}

async function insertAudit(client, transition, raw) {
  const result = await client.query(
    `INSERT INTO robinhood_wallet_transfer_reclassifications (
       chain, transaction_hash, log_index, block_time, block_number, block_hash,
       transaction_index, token_address, from_wallet, to_wallet, amount_raw,
       from_transfer_kind, from_classification_version, to_transfer_kind,
       to_classification_version, transition_version, decision_reason, decision_evidence
     ) VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11,
       'unknown', $12, $13, $14, $15, $16, $17::jsonb)
     ON CONFLICT DO NOTHING`,
    [CHAIN, transition.transactionHash, transition.logIndex, transition.blockTime,
      raw.block_number, raw.block_hash, raw.transaction_index, raw.token_address,
      raw.from_wallet, raw.to_wallet, raw.amount_raw,
      transition.fromClassificationVersion, transition.toTransferKind,
      transition.toClassificationVersion, transition.transitionVersion,
      transition.decisionReason, JSON.stringify(transition.decisionEvidence)]
  );
  if (result.rowCount !== 1) throw new Error('reclassification audit conflicts with raw state');
}

async function updateRawEvent(client, transition) {
  const result = await client.query(
    `UPDATE robinhood_token_transfer_events
     SET transfer_kind = $5, classification_version = $6
     WHERE chain = $1 AND transaction_hash = $2 AND log_index = $3
       AND block_time = $4::timestamptz AND transfer_kind = 'unknown'
       AND classification_version = $7`,
    [CHAIN, transition.transactionHash, transition.logIndex, transition.blockTime,
      transition.toTransferKind, transition.toClassificationVersion,
      transition.fromClassificationVersion]
  );
  if (result.rowCount !== 1) throw new Error('locked raw transfer changed unexpectedly');
}

function projectionEvent(raw, transition) {
  if (raw.from_wallet === ZERO_ADDRESS || raw.to_wallet === ZERO_ADDRESS
      || raw.from_wallet === raw.to_wallet) {
    throw new Error('edge-eligible transition requires distinct non-zero endpoints');
  }
  return {
    blockNumber: String(raw.block_number), blockHash: raw.block_hash,
    blockTime: new Date(raw.block_time).toISOString(),
    transactionHash: raw.transaction_hash,
    transactionIndex: String(raw.transaction_index), logIndex: String(raw.log_index),
    tokenAddress: raw.token_address, fromWallet: raw.from_wallet, toWallet: raw.to_wallet,
    amountRaw: String(raw.amount_raw), transferKind: transition.toTransferKind,
    classificationVersion: transition.toClassificationVersion,
  };
}

async function invalidateWatermarks(client, transition) {
  const versions = [...new Set([
    transition.fromClassificationVersion, transition.toClassificationVersion,
  ])];
  const dropped = await client.query(
    `SELECT 1 FROM robinhood_wallet_transfer_compaction_watermarks
     WHERE chain = $1 AND projection_version = ANY($2::varchar[])
       AND partition_day = ($3::timestamptz AT TIME ZONE 'UTC')::date
       AND lifecycle_state = 'dropped' FOR UPDATE`,
    [CHAIN, versions, transition.blockTime]
  );
  if (dropped.rowCount) throw new Error('cannot reclassify a dropped transfer partition');
  const result = await client.query(
    `UPDATE robinhood_wallet_transfer_compaction_watermarks SET
       lifecycle_state = 'blocked', state_reason = 'reclassification_applied',
       summary_reconciled = false, position_complete = false,
       evidence_complete = false, audited_at = NOW(), verified_at = NULL,
       dropped_at = NULL, version = version + 1, updated_at = NOW()
     WHERE chain = $1 AND projection_version = ANY($2::varchar[])
       AND partition_day = ($3::timestamptz AT TIME ZONE 'UTC')::date
       AND lifecycle_state <> 'dropped'`,
    [CHAIN, versions, transition.blockTime]
  );
  return result.rowCount || 0;
}

function createRobinhoodWalletTransferReclassificationRepository(options = {}) {
  const database = options.database || db;
  const persistProjection = options.persistProjection || persistTransferProjection;

  async function listCandidates(input = {}) {
    const version = identifier(input.classificationVersion, 'classificationVersion');
    const day = utcDay(input.day);
    const limit = Number(input.limit ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('limit must be between 1 and 1000');
    }
    const result = await database.query(
      `SELECT raw.*,
         jsonb_build_object(
           'endpointRole', from_role.endpoint_role, 'evidenceSource', from_role.evidence_source,
           'evidenceBlock', from_role.evidence_block::text,
           'evidenceBlockHash', from_role.evidence_block_hash,
           'resolverVersion', from_role.resolver_version,
           'observedFromBlock', from_role.observed_from_block::text,
           'observedThroughBlock', from_role.observed_through_block::text
         ) AS from_role_evidence,
         jsonb_build_object(
           'endpointRole', to_role.endpoint_role, 'evidenceSource', to_role.evidence_source,
           'evidenceBlock', to_role.evidence_block::text,
           'evidenceBlockHash', to_role.evidence_block_hash,
           'resolverVersion', to_role.resolver_version,
           'observedFromBlock', to_role.observed_from_block::text,
           'observedThroughBlock', to_role.observed_through_block::text
         ) AS to_role_evidence
       FROM robinhood_token_transfer_events raw
       JOIN robinhood_wallet_endpoint_roles from_role
         ON from_role.chain = raw.chain AND from_role.endpoint_address = raw.from_wallet
        AND raw.block_number BETWEEN from_role.observed_from_block AND from_role.observed_through_block
       JOIN robinhood_wallet_endpoint_roles to_role
         ON to_role.chain = raw.chain AND to_role.endpoint_address = raw.to_wallet
        AND raw.block_number BETWEEN to_role.observed_from_block AND to_role.observed_through_block
       WHERE raw.chain = $1 AND raw.transfer_kind = 'unknown'
         AND raw.classification_version = $2
         AND raw.block_time >= ($3::date::timestamp AT TIME ZONE 'UTC')
         AND raw.block_time < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
       ORDER BY raw.block_number, raw.transaction_index, raw.log_index, raw.transaction_hash
       LIMIT $4::integer`,
      [CHAIN, version, day, limit]
    );
    return Object.freeze(result.rows.map(candidate));
  }

  async function applyTransition(input = {}) {
    const transition = normalizeTransition(input);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const raw = await lockRawEvent(client, transition);
      if (!raw) {
        await client.query('ROLLBACK');
        return { applied: false, reason: 'event_not_found' };
      }
      if (raw.transfer_kind !== 'unknown'
          || raw.classification_version !== transition.fromClassificationVersion) {
        const alreadyApplied = raw.transfer_kind === transition.toTransferKind
          && raw.classification_version === transition.toClassificationVersion
          && await matchingAuditExists(client, transition);
        await client.query('ROLLBACK');
        return { applied: false, reason: alreadyApplied ? 'already_applied' : 'classification_conflict' };
      }
      const event = EDGE_KINDS.has(transition.toTransferKind)
        ? projectionEvent(raw, transition) : null;
      await insertAudit(client, transition, raw);
      await updateRawEvent(client, transition);
      const projected = event ? await persistProjection(
        client, transition.toClassificationVersion, [event]
      ) : { edgeGroups: 0, dailySummaryGroups: 0, evidenceCandidates: 0 };
      const watermarksInvalidated = await invalidateWatermarks(client, transition);
      await client.query('COMMIT');
      return { applied: true, projected, watermarksInvalidated };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ applyTransition, listCandidates });
}

module.exports = {
  createRobinhoodWalletTransferReclassificationRepository,
  __private: { normalizeTransition, utcDay },
};
