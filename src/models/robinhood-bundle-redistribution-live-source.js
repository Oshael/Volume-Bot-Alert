const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const PROJECTION_VERSION = 'rh_transfer_v1';
const MAX_EDGES = 10_000;
const INVALID_CREATORS = new Set([
  `0x${'0'.repeat(40)}`,
  '0x000000000000000000000000000000000000dead',
]);

const READINESS_SQL = `SELECT state.ledger_status,
       state.live_through_block::text, state.live_through_hash,
       attribution.creator_address, attribution.attribution_block::text,
       first_buy.next_time AS first_buy_next_time,
       first_buy.source_through AS first_buy_source_through,
       first_buy.source_next_block::text AS first_buy_source_next_block,
       swap.lifecycle_state AS swap_lifecycle_state,
       swap.next_block::text AS swap_next_block, swap.safe_head::text AS swap_safe_head,
       transfer.lifecycle_state AS transfer_lifecycle_state,
       transfer.next_block::text AS transfer_next_block
  FROM robinhood_holder_token_states state
  LEFT JOIN robinhood_token_attributions attribution
    ON attribution.chain = state.chain AND attribution.token_address = state.token_address
  LEFT JOIN robinhood_first_buy_live_cursors first_buy ON first_buy.chain = state.chain
  LEFT JOIN robinhood_wallet_swap_cursors swap
    ON swap.chain = state.chain AND swap.stream = 'live'
  LEFT JOIN robinhood_wallet_transfer_cursors transfer
    ON transfer.chain = state.chain AND transfer.stream = 'live'
   AND transfer.projection_version = $3
 WHERE state.chain = $1 AND state.token_address = $2`;

const EVIDENCE_SQL = `SELECT buy.wallet_address AS source_wallet,
       buy.block_number::text AS buy_block, buy.transaction_index::text AS buy_tx_index,
       buy.action_index::text AS buy_action_index, buy.transaction_hash AS buy_tx_hash,
       buy.block_time AS buy_time, buy_mc.fdv_usd AS buy_fdv_usd,
       edge.to_wallet AS recipient_wallet,
       edge.first_wallet_transfer_block::text AS transfer_block,
       transfer_position.transaction_index::text AS transfer_tx_index,
       edge.first_wallet_transfer_log_index::text AS transfer_log_index,
       edge.first_wallet_transfer_transaction_hash AS transfer_tx_hash,
       edge.first_wallet_transfer_at AS transfer_time,
       edge.first_wallet_transfer_amount_raw::text AS transfer_amount_raw,
       sell.block_number::text AS sell_block,
       sell.transaction_index::text AS sell_tx_index,
       sell.action_index::text AS sell_action_index,
       sell.transaction_hash AS sell_tx_hash, sell.block_time AS sell_time,
       sell.fdv_usd AS sell_fdv_usd
  FROM robinhood_wallet_token_first_buys buy
  INNER JOIN robinhood_wallet_transfer_edges edge
    ON edge.chain = buy.chain AND edge.classification_version = $3
   AND edge.token_address = buy.token_address AND edge.from_wallet = buy.wallet_address
  LEFT JOIN robinhood_swap_mc buy_mc
    ON buy_mc.chain = buy.chain AND buy_mc.transaction_hash = buy.transaction_hash
   AND buy_mc.log_index = buy.action_index
  LEFT JOIN robinhood_transaction_positions transfer_position
    ON transfer_position.chain = edge.chain
   AND transfer_position.transaction_hash = edge.first_wallet_transfer_transaction_hash
   AND transfer_position.block_number = edge.first_wallet_transfer_block
  LEFT JOIN LATERAL (
    SELECT swap.block_number, position.transaction_index, swap.action_index,
           swap.transaction_hash, swap.block_time, mc.fdv_usd
      FROM robinhood_wallet_swaps swap
      LEFT JOIN robinhood_transaction_positions position
        ON position.chain = swap.chain AND position.transaction_hash = swap.transaction_hash
       AND position.block_number = swap.block_number
      LEFT JOIN robinhood_swap_mc mc
        ON mc.chain = swap.chain AND mc.transaction_hash = swap.transaction_hash
       AND mc.log_index = swap.action_index
     WHERE swap.chain = edge.chain AND swap.token_address = edge.token_address
       AND swap.wallet_address = edge.to_wallet AND swap.side = 'sell'
       AND swap.block_number > edge.first_wallet_transfer_block
       AND swap.block_number <= $4::bigint
     ORDER BY swap.block_number, position.transaction_index NULLS FIRST,
              swap.action_index, swap.transaction_hash LIMIT 1
  ) sell ON true
 WHERE buy.chain = $1 AND buy.token_address = $2
   AND buy.block_number <= $4::bigint
   AND edge.first_wallet_transfer_block > buy.block_number
   AND edge.first_wallet_transfer_block >= $5::bigint
   AND edge.first_wallet_transfer_block <= $4::bigint
   AND edge.first_wallet_transfer_amount_raw > 0
   AND edge.from_wallet <> edge.to_wallet
 ORDER BY buy.block_number, buy.transaction_index, buy.action_index,
          buy.wallet_address, edge.first_wallet_transfer_block,
          edge.first_wallet_transfer_log_index, edge.to_wallet
 LIMIT ${MAX_EDGES + 1}`;

const BARRIERS_SQL = `WITH actors AS (
  SELECT actor.address, actor.observed_block::bigint
    FROM jsonb_to_recordset($2::jsonb) AS actor(address text, observed_block text)
) SELECT DISTINCT actor.address
  FROM actors actor
 WHERE EXISTS (
   SELECT 1 FROM robinhood_infrastructure_registry infrastructure
    WHERE infrastructure.chain = $1 AND infrastructure.address = actor.address
      AND infrastructure.valid_from_block <= actor.observed_block
      AND (infrastructure.valid_through_block IS NULL
        OR infrastructure.valid_through_block >= actor.observed_block)
 ) OR EXISTS (
   SELECT 1 FROM robinhood_pool_registry pool
    WHERE pool.chain = $1 AND pool.token_address = $3
      AND pool.discovery_block <= actor.observed_block
      AND (pool.pool_address = actor.address
        OR (pool.protocol = 'uniswap-v4' AND pool.origin_address = actor.address))
 ) ORDER BY actor.address`;

function unavailable(reason, tokenAddress, details = {}) {
  return Object.freeze({ ready: false, reason, tokenAddress, ...details });
}

function observationStart(value, tokenAddress) {
  const normalized = String(value ?? '');
  if (!/^\d+$/.test(normalized)) {
    return unavailable('observation_frontier_missing', tokenAddress);
  }
  return Object.freeze({ ready: true, observationFromBlock: normalized });
}

function holderFrontier(row) {
  if (!row || row.ledger_status !== 'live' || row.live_through_block == null
      || !/^0x[0-9a-f]{64}$/.test(row.live_through_hash || '')) return null;
  return Object.freeze({ blockNumber: String(row.live_through_block),
    blockHash: row.live_through_hash });
}

function creatorReady(row, throughBlock) {
  return /^0x[0-9a-f]{40}$/.test(row.creator_address || '')
    && !INVALID_CREATORS.has(row.creator_address)
    && (row.attribution_block == null
      || BigInt(row.attribution_block) <= BigInt(throughBlock));
}

function firstBuyReady(row, throughBlock) {
  if (!row.first_buy_next_time || !row.first_buy_source_through
      || row.first_buy_source_next_block == null) return false;
  return new Date(row.first_buy_next_time).getTime()
      === new Date(row.first_buy_source_through).getTime()
    && BigInt(row.first_buy_source_next_block) > BigInt(throughBlock);
}

function swapReady(row, throughBlock) {
  return row.swap_lifecycle_state === 'running' && row.swap_next_block != null
    && row.swap_safe_head != null && BigInt(row.swap_next_block) > BigInt(throughBlock)
    && BigInt(row.swap_safe_head) >= BigInt(throughBlock);
}

function transferReady(row, throughBlock) {
  return row.transfer_lifecycle_state === 'running' && row.transfer_next_block != null
    && BigInt(row.transfer_next_block) > BigInt(throughBlock);
}

function readiness(row, tokenAddress) {
  if (!row) return unavailable('holder_state_missing', tokenAddress);
  const frontier = holderFrontier(row);
  if (!frontier) return unavailable('holder_frontier_unavailable', tokenAddress);
  if (!creatorReady(row, frontier.blockNumber)) return unavailable('creator_unavailable', tokenAddress);
  if (!firstBuyReady(row, frontier.blockNumber)) return unavailable('first_buy_frontier_behind', tokenAddress);
  if (!swapReady(row, frontier.blockNumber)) return unavailable('swap_frontier_behind', tokenAddress);
  if (!transferReady(row, frontier.blockNumber)) return unavailable('transfer_frontier_behind', tokenAddress);
  return Object.freeze({ ready: true, reason: null, tokenAddress,
    creatorAddress: row.creator_address, frontier });
}

function sourceBuy(row) {
  return Object.freeze({ blockNumber: row.buy_block, transactionIndex: row.buy_tx_index,
    actionIndex: row.buy_action_index, transactionHash: row.buy_tx_hash,
    blockTime: new Date(row.buy_time).toISOString(),
    fdvUsd: row.buy_fdv_usd == null ? null : Number(row.buy_fdv_usd) });
}

function recipient(row) {
  return Object.freeze({ walletAddress: row.recipient_wallet,
    transfer: Object.freeze({ blockNumber: row.transfer_block,
      transactionIndex: row.transfer_tx_index, logIndex: row.transfer_log_index,
      transactionHash: row.transfer_tx_hash,
      blockTime: new Date(row.transfer_time).toISOString(), amountRaw: row.transfer_amount_raw }),
    firstSell: row.sell_block == null ? null : Object.freeze({ blockNumber: row.sell_block,
      transactionIndex: row.sell_tx_index, actionIndex: row.sell_action_index,
      transactionHash: row.sell_tx_hash, blockTime: new Date(row.sell_time).toISOString(),
      fdvUsd: row.sell_fdv_usd == null ? null : Number(row.sell_fdv_usd) }) });
}

function normalizeEvidence(rows, tokenAddress) {
  if (rows.length > MAX_EDGES) return unavailable('edge_cap_exceeded', tokenAddress);
  if (rows.some((row) => row.transfer_tx_index == null
      || (row.sell_block != null && row.sell_tx_index == null))) {
    return unavailable('transaction_position_missing', tokenAddress);
  }
  const sources = new Map();
  for (const row of rows) {
    const current = sources.get(row.source_wallet) || { tokenAddress,
      sourceWallet: row.source_wallet, sourceBuy: sourceBuy(row), recipients: [] };
    current.recipients.push(recipient(row)); sources.set(row.source_wallet, current);
  }
  return Object.freeze({ ready: true, sources: Object.freeze([...sources.values()].map((item) => (
    Object.freeze({ ...item, recipients: Object.freeze(item.recipients) })
  ))) });
}

function actors(sources) {
  const values = new Map();
  const add = (address, observedBlock) => values.set(`${address}:${observedBlock}`,
    { address, observed_block: observedBlock });
  for (const source of sources) {
    add(source.sourceWallet, source.sourceBuy.blockNumber);
    for (const item of source.recipients) add(item.walletAddress, item.transfer.blockNumber);
  }
  return [...values.values()];
}

function createRobinhoodBundleRedistributionLiveSource(options = {}) {
  const database = options.database || db;
  const statementTimeoutMs = Math.max(1_000,
    Math.min(Number(options.statementTimeoutMs) || 120_000, 900_000));
  const query = (sql, params) => (database.queryWithStatementTimeout
    ? database.queryWithStatementTimeout(sql, params, statementTimeoutMs)
    : database.query(sql, params));

  async function loadToken(inputTokenAddress, input = {}) {
    const tokenAddress = normalizeTokenAddress(CHAIN, inputTokenAddress);
    const observation = observationStart(input.observationFromBlock, tokenAddress);
    if (!observation.ready) return observation;
    const state = readiness((await query(
      READINESS_SQL, [CHAIN, tokenAddress, PROJECTION_VERSION]
    )).rows[0], tokenAddress);
    if (!state.ready) return state;
    if (BigInt(observation.observationFromBlock) > BigInt(state.frontier.blockNumber)) {
      return unavailable('observation_frontier_ahead', tokenAddress,
        { frontier: state.frontier, observationFromBlock: observation.observationFromBlock });
    }
    const evidence = normalizeEvidence((await query(EVIDENCE_SQL, [
      CHAIN, tokenAddress, PROJECTION_VERSION, state.frontier.blockNumber,
      observation.observationFromBlock,
    ])).rows, tokenAddress);
    if (!evidence.ready) return Object.freeze({ ...evidence, frontier: state.frontier,
      observationFromBlock: observation.observationFromBlock });
    const barrierRows = evidence.sources.length ? (await query(BARRIERS_SQL, [
      CHAIN, JSON.stringify(actors(evidence.sources)), tokenAddress,
    ])).rows : [];
    return Object.freeze({ ...state, observationFromBlock: observation.observationFromBlock,
      sources: evidence.sources,
      barrierAddresses: Object.freeze(barrierRows.map(({ address }) => address)) });
  }

  return Object.freeze({ loadToken });
}

module.exports = { createRobinhoodBundleRedistributionLiveSource,
  __private: { BARRIERS_SQL, EVIDENCE_SQL, READINESS_SQL, normalizeEvidence,
    observationStart, readiness } };
