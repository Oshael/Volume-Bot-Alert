'use strict';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

function backoffFor(attempt, baseMs, maxMs) {
  return Math.max(1, Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(attempt) - 1)));
}

function sameQuantity(left, right) {
  return /^\d+$/.test(String(left ?? ''))
    && /^\d+$/.test(String(right ?? ''))
    && BigInt(left) === BigInt(right);
}

function validateClaim(row) {
  const payload = row?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('wallet swap outbox payload is invalid');
  }
  const matches = String(payload.transactionHash || '').toLowerCase() === row.transactionHash
    && sameQuantity(payload.actionIndex, row.logIndex)
    && sameQuantity(payload.blockNumber, row.blockNumber)
    && String(payload.blockHash || '').toLowerCase() === String(row.blockHash).toLowerCase()
    && sameQuantity(payload.transactionIndex, row.transactionIndex);
  if (!matches) throw new Error('wallet swap outbox payload identity mismatch');
  return payload;
}

function assertDependencies(deps) {
  if (typeof deps.repository?.claimFinalized !== 'function'
      || typeof deps.repository?.settle !== 'function') throw new Error('wallet swap outbox repository is required');
  if (typeof deps.walletRepository?.insertWalletSwaps !== 'function') throw new Error('wallet swap persistence is required');
  if (typeof deps.transactionPositionRepository?.upsertPositions !== 'function') throw new Error('transaction position persistence is required');
  if (typeof deps.publishRows !== 'function') throw new Error('market trade publisher is required');
  if (typeof deps.readFinalizedBlock !== 'function') throw new Error('finalized block reader is required');
}

function settlementStatus(settled) {
  if (settled.blocked) return 'blocked';
  if (settled.retried) return 'retrying';
  return 'delivered';
}

function createRobinhoodWalletSwapOutboxRunner(deps = {}) {
  assertDependencies(deps);
  const { repository, walletRepository, transactionPositionRepository } = deps;
  const publishRows = deps.publishRows;
  const readFinalizedBlock = deps.readFinalizedBlock;

  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-wallet-outbox:${process.pid}`);
  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;
  const leaseMs = Number(options.leaseMs) || DEFAULT_LEASE_MS;
  const maxAttempts = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = Number(options.baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = Number(options.maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS;

  function retry(row, error) {
    return {
      transactionHash: row.transactionHash,
      logIndex: row.logIndex,
      error: String(error?.message || error).slice(0, 4000),
      backoffMs: backoffFor(row.attemptCount, baseBackoffMs, maxBackoffMs),
    };
  }

  async function runOnce() {
    const reclaimed = await repository.reclaimExpired();
    const throughBlock = await readFinalizedBlock();
    if (throughBlock == null) {
      return { status: 'waiting-finality', throughBlock: null, reclaimed, claimed: 0, delivered: 0, retried: 0, blocked: 0 };
    }
    const rows = await repository.claimFinalized({ owner, limit: batchSize, leaseMs, throughBlock });
    if (!rows.length) {
      return { status: 'idle', throughBlock: String(throughBlock), reclaimed, claimed: 0, delivered: 0, retried: 0, blocked: 0 };
    }

    const valid = [];
    const retryRows = [];
    for (const row of rows) {
      try { valid.push({ row, payload: validateClaim(row) }); } catch (error) {
        retryRows.push(retry(row, error));
      }
    }
    let inserted = 0;
    if (valid.length) {
      try {
        const payloads = valid.map((entry) => entry.payload);
        await transactionPositionRepository.upsertPositions(payloads.map((payload) => ({
          transactionHash: payload.transactionHash,
          blockNumber: payload.blockNumber,
          blockHash: payload.blockHash,
          transactionIndex: payload.transactionIndex,
        })));
        inserted = Number((await walletRepository.insertWalletSwaps(payloads))?.inserted || 0);
        await publishRows(payloads);
      } catch (error) {
        retryRows.push(...valid.map(({ row }) => retry(row, error)));
        valid.length = 0;
      }
    }
    const delivered = valid.map(({ row }) => row);
    const settled = await repository.settle({
      owner, maxAttempts, delivered, retry: retryRows,
    });
    return {
      status: settlementStatus(settled),
      throughBlock: String(throughBlock), reclaimed, claimed: rows.length, inserted, ...settled,
    };
  }

  return Object.freeze({ owner, runOnce });
}

module.exports = {
  backoffFor,
  createRobinhoodWalletSwapOutboxRunner,
  __private: { settlementStatus, validateClaim },
};
