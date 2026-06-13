const db = require('../models/db');
const gmgnClaimAlertEvent = require('../models/gmgn-claim-alert-event');
const backendAlertPublisher = require('./backend-alert-publisher');
const { GMGN_CLAIM_SIGNAL_RULE_KEY, getBackendAlertRule } = require('./backend-alert-rules');

const CLAIM_RULE = getBackendAlertRule(GMGN_CLAIM_SIGNAL_RULE_KEY);
const DEFAULT_MAX_ALERTS_PER_TOKEN = CLAIM_RULE.defaults.maxAlertsPerToken;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function normalizeSignalType(signal) {
  return Math.trunc(Number(firstPresent(signal.signalType, signal.signal_type)));
}

function normalizeSignalSource(signal) {
  return String(signal.source || 'gmgn').trim().toLowerCase() || 'gmgn';
}

function normalizeClaimedAt(signal) {
  return toTimestampOrNull(firstPresent(signal.claimedAt, signal.claimed_at, signal.timestamp)) || new Date();
}

function buildFallbackClaimId(signal, tokenAddress, signalType) {
  return [
    signalType,
    tokenAddress,
    firstPresent(signal.claimedAt, signal.claimed_at, signal.timestamp) || '',
    firstPresent(signal.totalFeeUsd, signal.total_fee_usd) || '',
  ].join(':');
}

function normalizeClaimId(signal, tokenAddress, signalType) {
  return gmgnClaimAlertEvent.__private.normalizeClaimId(
    firstPresent(signal.claimId, signal.claim_id, signal.txHash, signal.tx_hash)
    || buildFallbackClaimId(signal, tokenAddress, signalType)
  );
}

function normalizeSignal(signal = {}) {
  const tokenAddress = gmgnClaimAlertEvent.__private.normalizeTokenAddress(firstPresent(signal.tokenAddress, signal.address));
  const signalType = normalizeSignalType(signal);
  return {
    ruleKey: GMGN_CLAIM_SIGNAL_RULE_KEY,
    tokenAddress,
    signalType,
    source: normalizeSignalSource(signal),
    claimId: normalizeClaimId(signal, tokenAddress, signalType),
    totalFeeUsd: toNumberOrNull(firstPresent(signal.totalFeeUsd, signal.total_fee_usd, signal.total_fee)),
    claimedAt: normalizeClaimedAt(signal),
    payload: gmgnClaimAlertEvent.__private.normalizeMetadata(signal.payload || signal.raw || signal),
  };
}

function mapStateRow(row) {
  if (!row) return null;
  return {
    ruleKey: row.rule_key || null,
    tokenAddress: row.token_address || null,
    alertCount: Number(row.alert_count) || 0,
    lastClaimId: row.last_claim_id || null,
    lastClaimedAt: row.last_claimed_at || null,
    metadata: gmgnClaimAlertEvent.__private.normalizeMetadata(row.metadata),
    updatedAt: row.updated_at || null,
  };
}

async function ensureState(signal, runner) {
  await runner.query(
    `INSERT INTO gmgn_claim_alert_state (
       rule_key,
       token_address
     )
     VALUES ($1, $2)
     ON CONFLICT (rule_key, token_address) DO NOTHING`,
    [signal.ruleKey, signal.tokenAddress]
  );

  const { rows } = await runner.query(
    `SELECT *
     FROM gmgn_claim_alert_state
     WHERE rule_key = $1
       AND token_address = $2
     FOR UPDATE`,
    [signal.ruleKey, signal.tokenAddress]
  );

  return mapStateRow(rows[0] || null);
}

async function insertClaimEvent(signal, claimSequence, runner) {
  const { rows } = await runner.query(
    `INSERT INTO gmgn_claim_alert_events (
       rule_key,
       token_address,
       signal_type,
       source,
       claim_sequence,
       claim_id,
       total_fee_usd,
       claimed_at,
       payload,
       triggered_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
     ON CONFLICT (rule_key, claim_id) DO NOTHING
     RETURNING *`,
    [
      signal.ruleKey,
      signal.tokenAddress,
      signal.signalType,
      signal.source,
      claimSequence,
      signal.claimId,
      signal.totalFeeUsd,
      signal.claimedAt,
      JSON.stringify(signal.payload),
    ]
  );

  return gmgnClaimAlertEvent.__private.mapEventRow(rows[0] || null);
}

async function updateStateAfterEvent(signal, claimSequence, runner) {
  const { rows } = await runner.query(
    `UPDATE gmgn_claim_alert_state
     SET alert_count = $3,
         last_claim_id = $4,
         last_claimed_at = $5,
         metadata = CASE
           WHEN $6::numeric IS NULL THEN COALESCE(metadata, '{}'::jsonb)
           ELSE jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{lastTotalFeeUsd}',
             to_jsonb($6::numeric),
             true
           )
         END,
         updated_at = NOW()
     WHERE rule_key = $1
       AND token_address = $2
     RETURNING *`,
    [
      signal.ruleKey,
      signal.tokenAddress,
      claimSequence,
      signal.claimId,
      signal.claimedAt,
      signal.totalFeeUsd,
    ]
  );

  return mapStateRow(rows[0] || null);
}

async function beginOwnedTransaction(client, ownsClient) {
  if (ownsClient) {
    await client.query('BEGIN');
  }
}

async function commitOwnedTransaction(client, ownsClient) {
  if (ownsClient) {
    await client.query('COMMIT');
  }
}

async function rollbackOwnedTransaction(client, ownsClient) {
  if (!ownsClient) {
    return;
  }
  try { await client.query('ROLLBACK'); } catch (_) {}
}

function buildNoEventResult(action, reason, stateBefore) {
  return { action, reason, event: null, stateBefore, stateAfter: stateBefore };
}

function evaluateStateBefore(signal, stateBefore, maxAlertsPerToken) {
  if ((stateBefore?.alertCount || 0) >= maxAlertsPerToken) {
    return buildNoEventResult('suppressed', 'max-alerts-per-token', stateBefore);
  }
  if (stateBefore?.lastClaimId === signal.claimId) {
    return buildNoEventResult('deduped', 'same-claim-id', stateBefore);
  }
  return null;
}

async function persistTriggeredSignal(signal, stateBefore, client) {
  const claimSequence = (stateBefore?.alertCount || 0) + 1;
  const event = await insertClaimEvent(signal, claimSequence, client);
  if (!event) {
    return buildNoEventResult('deduped', 'existing-claim-event', stateBefore);
  }

  const stateAfter = await updateStateAfterEvent(signal, claimSequence, client);
  return { action: 'triggered', reason: null, event, stateBefore, stateAfter };
}

async function recordClaimSignal(signalInput = {}, options = {}, deps = {}) {
  const signal = normalizeSignal(signalInput);
  const maxAlertsPerToken = Math.max(
    1,
    Math.trunc(Number(options.maxAlertsPerToken) || DEFAULT_MAX_ALERTS_PER_TOKEN)
  );
  const client = deps.client || await db.getClient();
  const ownsClient = !deps.client;

  try {
    await beginOwnedTransaction(client, ownsClient);

    const stateBefore = await ensureState(signal, client);
    const result = evaluateStateBefore(signal, stateBefore, maxAlertsPerToken)
      || await persistTriggeredSignal(signal, stateBefore, client);
    await commitOwnedTransaction(client, ownsClient);

    if (result.event) {
      await (deps.publisher || backendAlertPublisher).publishEventSafe(result.event, { logLabel: 'GmgnClaimSignalAlert' });
    }
    return result;
  } catch (error) {
    await rollbackOwnedTransaction(client, ownsClient);
    throw error;
  } finally {
    if (ownsClient) {
      client.release();
    }
  }
}

module.exports = {
  DEFAULT_MAX_ALERTS_PER_TOKEN,
  recordClaimSignal,
  __private: {
    mapStateRow,
    normalizeSignal,
  },
};
