const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonNegativeInteger(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new TypeError(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`${label} is invalid`);
  return parsed.toISOString();
}

function mapCandidate(row) {
  if (!row) return null;
  return Object.freeze({
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    holderCount: nonNegativeInteger(row.holder_count, 'holder count'),
    version: Number(row.version),
    lastReconciledAt: row.last_reconciled_at == null
      ? null : timestamp(row.last_reconciled_at, 'last reconciled timestamp'),
  });
}

function candidateSql(status, where = '') {
  return `SELECT state.token_address, state.holder_count, state.version,
                 state.last_reconciled_at
            FROM robinhood_holder_token_states state
           WHERE state.chain = '${CHAIN}' AND state.ledger_status = '${status}'
             ${where}
             AND NOT EXISTS (
               SELECT 1 FROM robinhood_holder_transfer_journal journal
                WHERE journal.chain = state.chain
                  AND journal.token_address = state.token_address
                  AND journal.applied = false
             )`;
}

function createRobinhoodHolderReconciliationRepository(options = {}) {
  const database = options.database || db;

  async function getNextCandidate() {
    const { rows } = await database.query(
      `${candidateSql('shadow')}
       ORDER BY state.last_reconciled_at ASC NULLS FIRST, state.token_address ASC
       LIMIT 1`
    );
    return mapCandidate(rows[0]);
  }

  async function getCandidate(value) {
    const token = normalizeTokenAddress(CHAIN, value);
    const { rows } = await database.query(
      candidateSql('shadow', 'AND state.token_address = $1'), [token]
    );
    return mapCandidate(rows[0]);
  }

  async function getNextLiveCandidate() {
    const { rows } = await database.query(
      `${candidateSql('live')}
       ORDER BY state.last_reconciled_at ASC NULLS FIRST, state.token_address ASC
       LIMIT 1`
    );
    return mapCandidate(rows[0]);
  }

  async function getLiveCandidate(value) {
    const token = normalizeTokenAddress(CHAIN, value);
    const { rows } = await database.query(
      candidateSql('live', 'AND state.token_address = $1'), [token]
    );
    return mapCandidate(rows[0]);
  }

  async function recordLiveAudit(input = {}) {
    const token = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const expectedCount = nonNegativeInteger(input.expectedHolderCount, 'expected holder count');
    const expectedVersion = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new TypeError('expected version is invalid');
    }
    const observedAt = timestamp(input.observedAt, 'observed timestamp');
    const { rows } = await database.query(
      `UPDATE robinhood_holder_token_states state
          SET last_reconciled_at = $4::timestamptz,
              version = version + 1, updated_at = NOW()
        WHERE state.chain = '${CHAIN}' AND state.token_address = $1
          AND state.ledger_status = 'live' AND state.version = $2::bigint
          AND state.holder_count = $3::bigint
          AND (state.last_reconciled_at IS NULL OR state.last_reconciled_at < $4::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM robinhood_holder_transfer_journal journal
             WHERE journal.chain = state.chain AND journal.token_address = state.token_address
               AND journal.applied = false
          )
        RETURNING state.token_address, state.holder_count, state.version,
                  state.last_reconciled_at`,
      [token, expectedVersion, expectedCount, observedAt]
    );
    if (!rows[0]) {
      throw codedError('holder live audit candidate changed', 'holder_reconciliation_stale');
    }
    return mapCandidate(rows[0]);
  }

  async function recordComparison(input = {}) {
    const token = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const expectedCount = nonNegativeInteger(input.expectedHolderCount, 'expected holder count');
    const expectedVersion = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      throw new TypeError('expected version is invalid');
    }
    const observedAt = timestamp(input.observedAt, 'observed timestamp');
    const promote = input.promote === true;
    const { rows } = await database.query(
      `UPDATE robinhood_holder_token_states state
          SET last_reconciled_at = $4::timestamptz,
              ledger_status = CASE WHEN $5::boolean THEN 'live' ELSE 'shadow' END,
              version = version + 1, updated_at = NOW()
        WHERE state.chain = '${CHAIN}' AND state.token_address = $1
          AND state.ledger_status = 'shadow' AND state.version = $2::bigint
          AND state.holder_count = $3::bigint
          AND (state.last_reconciled_at IS NULL OR state.last_reconciled_at < $4::timestamptz)
          AND NOT EXISTS (
            SELECT 1 FROM robinhood_holder_transfer_journal journal
             WHERE journal.chain = state.chain AND journal.token_address = state.token_address
               AND journal.applied = false
          )
        RETURNING state.token_address, state.holder_count, state.version,
                  state.last_reconciled_at, state.ledger_status`,
      [token, expectedVersion, expectedCount, observedAt, promote]
    );
    if (!rows[0]) {
      throw codedError('holder reconciliation candidate changed', 'holder_reconciliation_stale');
    }
    return Object.freeze({ ...mapCandidate(rows[0]), status: rows[0].ledger_status });
  }

  return Object.freeze({
    getNextCandidate, getCandidate, recordComparison,
    getNextLiveCandidate, getLiveCandidate, recordLiveAudit,
  });
}

module.exports = { createRobinhoodHolderReconciliationRepository };
