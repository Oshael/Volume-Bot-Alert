'use strict';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const EVENT_CONTRACT = Object.freeze({
  observed: ['market:trade:observed', 'observed', 'observedAt'],
  finalized: ['market:trade:finalized', 'finalized', 'finalizedAt'],
  invalidate: ['market:trade:invalidate', 'invalidated', 'invalidatedAt'],
});

function sameQuantity(left, right) {
  return /^\d+$/.test(String(left ?? ''))
    && /^\d+$/.test(String(right ?? ''))
    && BigInt(left) === BigInt(right);
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(String(value || '')));
}

function validAddress(value) {
  return /^0x[0-9a-f]{40}$/.test(String(value || '').toLowerCase());
}

function optionalFinite(value) {
  return value == null || value === '' || Number.isFinite(Number(value));
}

function validateAuditClaim(row) {
  const payload = row?.payload;
  const contract = EVENT_CONTRACT[row?.eventKind];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !contract) {
    throw new Error('trade lifecycle audit payload is invalid');
  }
  const [type, finality, terminalTimestamp] = contract;
  const matches = [
    Number(payload.protocolVersion) === 2,
    payload.type === type,
    payload.finality === finality,
    String(payload.transactionHash || '').toLowerCase() === row.transactionHash,
    sameQuantity(payload.actionIndex, row.logIndex),
    sameQuantity(payload.blockNumber, row.blockNumber),
    sameQuantity(payload.asOfBlock, row.blockNumber),
    String(payload.blockHash || '').toLowerCase() === row.blockHash,
    String(payload.asOfBlockHash || '').toLowerCase() === row.blockHash,
    sameQuantity(payload.transactionIndex, row.transactionIndex),
    validTimestamp(payload.blockTime),
    validTimestamp(payload.observedAt),
    validTimestamp(payload[terminalTimestamp]),
    validAddress(payload.walletAddress),
    validAddress(payload.tokenAddress),
    validAddress(payload.quoteAddress),
    ['buy', 'sell'].includes(payload.side),
    ['uniswap-v2', 'uniswap-v3', 'uniswap-v4'].includes(payload.protocol),
    String(payload.marketKey || '').length > 0,
    [payload.volumeUsd, payload.priceUsd, payload.fdvUsd].every(optionalFinite),
  ].every(Boolean);
  if (!matches || (row.eventKind === 'invalidate' && payload.reason !== 'reorg')) {
    throw new Error('trade lifecycle audit payload contract mismatch');
  }
  return payload;
}

function backoffFor(attempt, baseMs, maxMs) {
  return Math.max(1, Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(attempt) - 1)));
}

function createRobinhoodWalletSwapRealtimeAuditRunner(deps = {}) {
  const repository = deps.repository;
  if (typeof repository?.claimAudit !== 'function'
      || typeof repository?.settleAudit !== 'function'
      || typeof repository?.reclaimExpiredAuditLeases !== 'function') {
    throw new Error('trade lifecycle audit repository is required');
  }
  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-trade-audit:${process.pid}`);
  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;
  const leaseMs = Number(options.leaseMs) || DEFAULT_LEASE_MS;
  const maxAttempts = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = Number(options.baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = Number(options.maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS;

  function retry(row, error) {
    return {
      transactionHash: row.transactionHash,
      logIndex: row.logIndex,
      blockHash: row.blockHash,
      eventKind: row.eventKind,
      error: String(error?.message || error).slice(0, 4000),
      backoffMs: backoffFor(row.attemptCount, baseBackoffMs, maxBackoffMs),
    };
  }

  async function runOnce() {
    const reclaimed = await repository.reclaimExpiredAuditLeases();
    const rows = await repository.claimAudit({ owner, limit: batchSize, leaseMs });
    if (!rows.length) {
      return { status: 'idle', reclaimed, claimed: 0, audited: 0, retried: 0, blocked: 0 };
    }
    const audited = [];
    const retryRows = [];
    for (const row of rows) {
      try {
        validateAuditClaim(row);
        audited.push(row);
      } catch (error) {
        retryRows.push(retry(row, error));
      }
    }
    const settled = await repository.settleAudit({
      owner, maxAttempts, audited, retry: retryRows,
    });
    return {
      status: settled.blocked ? 'blocked' : (settled.retried ? 'retrying' : 'audited'),
      reclaimed, claimed: rows.length, saturated: rows.length >= batchSize, ...settled,
    };
  }

  return Object.freeze({ owner, runOnce });
}

module.exports = {
  backoffFor,
  createRobinhoodWalletSwapRealtimeAuditRunner,
  __private: { validateAuditClaim },
};
