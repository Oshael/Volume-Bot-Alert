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
  const { repository, fetchBlock } = deps;
  const adapter = deps.adapter || senderAdapterModule;
  const parserVersion = deps.parserVersion || DEFAULT_PARSER_VERSION;

  if (typeof fetchBlock !== 'function') {
    throw new Error('attributor requires a fetchBlock(blockNumber) function');
  }
  if (!repository || typeof repository.insertWalletSwaps !== 'function') {
    throw new Error('attributor requires a wallet-swap repository');
  }

  async function attributeBlock(blockNumber, observations = []) {
    if (!Array.isArray(observations) || observations.length === 0) {
      return {
        blockNumber: String(blockNumber), blockHash: null, blockTime: null,
        attributed: 0, inserted: 0, unresolved: 0, missing: 0,
      };
    }
    const hashes = observations.map((observation) => observation.transaction_hash);
    const block = await fetchBlock(blockNumber);
    const { blockHash, blockTime, resolved, missing } = adapter.resolveSenders(block, hashes, {
      expectedBlockNumber: blockNumber,
    });

    if (missing.length > 0) {
      return {
        blockNumber: String(blockNumber), blockHash, blockTime,
        attributed: 0, inserted: 0, unresolved: missing.length, missing: missing.length,
      };
    }

    const rows = observations.map((observation) => buildRow(
      observation,
      resolved.get(String(observation.transaction_hash ?? '').toLowerCase()),
      blockTime,
      parserVersion
    ));

    const { inserted } = await repository.insertWalletSwaps(rows);
    return {
      blockNumber: String(blockNumber), blockHash, blockTime,
      attributed: rows.length,
      inserted,
      unresolved: 0,
      missing: 0,
    };
  }

  async function attributeGroups(groups) {
    const totals = { blocks: 0, attributed: 0, inserted: 0, unresolved: 0, missing: 0 };
    for (const [blockNumber, observations] of groups) {
      const result = await attributeBlock(blockNumber, observations);
      totals.blocks += 1;
      totals.attributed += result.attributed;
      totals.inserted += result.inserted;
      totals.unresolved += result.unresolved;
      totals.missing += result.missing;
    }
    return totals;
  }

  return { attributeBlock, attributeGroups };
}

module.exports = {
  createRobinhoodWalletSwapAttributor,
  DEFAULT_PARSER_VERSION,
  __private: { buildRow },
};
