/**
 * Robinhood wallet swap attributor (attribution engine).
 *
 * Given source swap observations grouped by block, this resolves the signing
 * EOA (`tx.from`) for each swap and writes wallet-attributed rows to the
 * durable store. It is the join point between:
 *   - the decoded swaps that already exist (robinhood_market_observations),
 *   - the sender adapter (block -> tx.from), and
 *   - the wallet-swap persistence repository (partitioned durable table).
 *
 * All I/O is injected (`fetchBlock`, `repository`), so the engine is pure and
 * unit-testable. The runner wires the real RPC client and the source reader.
 *
 * An observation whose transaction is absent from the fetched block is left
 * unresolved (never written with a null wallet); the caller can retry it.
 */
const senderAdapterModule = require('./robinhood-transaction-sender-adapter');

const DEFAULT_PARSER_VERSION = 'rh-wallet-seed-1';
// Standalone seed callers remain sequential unless they opt in; the LIVE worker
// supplies its separately bounded default through runtime configuration.
const DEFAULT_FETCH_CONCURRENCY = 1;

function boundedConcurrency(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 32)) : DEFAULT_FETCH_CONCURRENCY;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { value: await mapper(items[index], index) };
      } catch (error) {
        results[index] = { error };
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, items.length) }, () => consume()
  ));
  return results;
}

function buildRow(observation, walletAddress, blockTime, parserVersion) {
  return {
    walletAddress,
    transactionHash: observation.transaction_hash,
    actionIndex: observation.log_index,
    blockNumber: observation.block_number,
    blockTime,
    protocol: observation.protocol,
    marketKey: observation.market_key,
    tokenAddress: observation.token_address,
    quoteAddress: observation.quote_address,
    side: observation.side,
    tokenAmountRaw: observation.token_amount_raw,
    quoteAmountRaw: observation.quote_amount_raw,
    tokenDecimals: observation.token_decimals,
    quoteDecimals: observation.quote_decimals,
    tokenAmount: observation.token_amount,
    quoteAmount: observation.quote_amount,
    priceUsd: observation.price_usd,
    volumeUsd: observation.volume_usd,
    // Crystallize the per-swap MC (and at-block supply) so the trades feed keeps it
    // after the observation is pruned (~3 days). See stage109 / feed plan §8.
    fdvUsd: observation.fdv_usd,
    tokenTotalSupplyRaw: observation.token_total_supply_raw,
    parserVersion,
  };
}

function createRobinhoodWalletSwapAttributor(deps = {}) {
  const { repository, transactionPositionRepository, fetchBlock } = deps;
  const adapter = deps.adapter || senderAdapterModule;
  const parserVersion = deps.parserVersion || DEFAULT_PARSER_VERSION;
  const fetchConcurrency = boundedConcurrency(deps.fetchConcurrency);
  const onTradesPersisted = typeof deps.onTradesPersisted === 'function'
    ? deps.onTradesPersisted : null;

  if (typeof fetchBlock !== 'function') {
    throw new Error('attributor requires a fetchBlock(blockNumber) function');
  }
  if (!repository || typeof repository.insertWalletSwaps !== 'function') {
    throw new Error('attributor requires a wallet-swap repository');
  }
  if (!transactionPositionRepository
    || typeof transactionPositionRepository.upsertPositions !== 'function') {
    throw new Error('attributor requires a transaction-position repository');
  }

  async function resolveBlock(blockNumber, observations = []) {
    if (!Array.isArray(observations) || observations.length === 0) {
      return {
        blockNumber: String(blockNumber), blockHash: null, blockTime: null,
        rows: [], positions: [], missing: [],
      };
    }
    const hashes = observations.map((observation) => observation.transaction_hash);
    const block = await fetchBlock(blockNumber);
    const {
      blockHash, blockTime, resolved, resolvedPositions, missing,
    } = adapter.resolveSenders(block, hashes, { expectedBlockNumber: blockNumber });

    if (missing.length > 0) {
      return {
        blockNumber: String(blockNumber), blockHash, blockTime,
        rows: [], positions: [], missing,
      };
    }

    const rows = observations.map((observation) => buildRow(
      observation,
      resolved.get(String(observation.transaction_hash ?? '').toLowerCase()),
      blockTime,
      parserVersion
    ));

    return {
      blockNumber: String(blockNumber), blockHash, blockTime, rows,
      positions: [...resolvedPositions.values()], missing: [],
    };
  }

  async function persistResolved(resolvedBlocks) {
    const rows = resolvedBlocks.flatMap((resolved) => resolved.rows);
    const positions = resolvedBlocks.flatMap((resolved) => resolved.positions);
    if (!rows.length) return 0;
    await transactionPositionRepository.upsertPositions(positions);
    const { inserted } = await repository.insertWalletSwaps(rows);
    // Publish every persisted batch, including an idempotent retry. If NOTIFY
    // fails after the DB insert, the worker retries and clients dedupe the event;
    // the polling snapshot remains the final reconciliation path.
    await onTradesPersisted?.(rows);
    return inserted;
  }

  async function attributeBlock(blockNumber, observations = []) {
    const resolved = await resolveBlock(blockNumber, observations);
    if (resolved.missing.length > 0) {
      return {
        blockNumber: resolved.blockNumber, blockHash: resolved.blockHash,
        blockTime: resolved.blockTime, attributed: 0, inserted: 0,
        unresolved: resolved.missing.length, missing: resolved.missing.length,
      };
    }
    const inserted = await persistResolved([resolved]);
    return {
      blockNumber: resolved.blockNumber, blockHash: resolved.blockHash,
      blockTime: resolved.blockTime, attributed: resolved.rows.length,
      inserted,
      unresolved: 0,
      missing: 0,
    };
  }

  async function attributeGroups(groups) {
    if (!Array.isArray(groups)) throw new TypeError('wallet swap groups must be a list');
    const fetched = await mapConcurrent(groups, fetchConcurrency, async (group) => {
      if (!Array.isArray(group) || group.length !== 2 || !Array.isArray(group[1])) {
        throw new TypeError('wallet swap group must contain a block and observations');
      }
      return resolveBlock(group[0], group[1]);
    });
    const resolved = [];
    let failed = null;
    for (let index = 0; index < fetched.length; index += 1) {
      if (fetched[index].error) throw fetched[index].error;
      const current = fetched[index].value;
      if (current.missing.length > 0) {
        failed = current;
        break;
      }
      resolved.push(current);
    }
    const inserted = await persistResolved(resolved);
    const attributed = resolved.reduce((sum, item) => sum + item.rows.length, 0);
    return {
      blocks: resolved.length,
      attributed,
      inserted,
      unresolved: failed?.missing.length || 0,
      missing: failed?.missing.length || 0,
      failedBlock: failed?.blockNumber || null,
      results: resolved.map((item) => ({
        blockNumber: item.blockNumber,
        blockHash: item.blockHash,
        blockTime: item.blockTime,
        attributed: item.rows.length,
      })),
    };
  }

  return { attributeBlock, attributeGroups };
}

module.exports = {
  createRobinhoodWalletSwapAttributor,
  DEFAULT_PARSER_VERSION,
  __private: { boundedConcurrency, buildRow, mapConcurrent },
};
