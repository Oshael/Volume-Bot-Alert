'use strict';

const db = require('../models/db');
const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');
const { __private: { decodeRows } } = require('../models/robinhood-canonical-holder-source');
const { deriveHolderBalanceChanges } = require('../models/robinhood-holder-ledger');

const CHAIN = 'robinhood';
const MAX_BLOCKS = 1000n;
const MAX_EVENTS = 10000;
const MAX_WALLETS = 10000;

function identity(event) {
  return `${event.transactionHash}:${event.logIndex}`;
}

function legacyTransfer(row) {
  return {
    blockNumber: String(row.block_number), blockHash: row.block_hash,
    transactionHash: row.transaction_hash, transactionIndex: Number(row.transaction_index),
    logIndex: Number(row.log_index), tokenAddress: row.token_address,
    fromWallet: row.from_wallet, toWallet: row.to_wallet, amountRaw: String(row.amount_raw),
  };
}

const FIELDS = Object.freeze([
  'blockNumber', 'blockHash', 'transactionIndex', 'tokenAddress',
  'fromWallet', 'toWallet', 'amountRaw',
]);

function compareTransfers(canonical, legacy) {
  const left = new Map(canonical.map((event) => [identity(event), event]));
  const right = new Map(legacy.map((event) => [identity(event), event]));
  const missing = [...left.keys()].filter((key) => !right.has(key));
  const excess = [...right.keys()].filter((key) => !left.has(key));
  const divergent = [...left.keys()].filter((key) => right.has(key)
    && FIELDS.some((field) => String(left.get(key)[field]) !== String(right.get(key)[field])));
  return Object.freeze({ missing, excess, divergent });
}

function replayBalances(transfers) {
  const balances = new Map();
  let holderCount = 0;
  for (const transfer of transfers) {
    const current = {
      [transfer.fromWallet]: balances.get(transfer.fromWallet) ?? '0',
      [transfer.toWallet]: balances.get(transfer.toWallet) ?? '0',
    };
    const change = deriveHolderBalanceChanges(transfer, current);
    holderCount += change.holderDelta;
    for (const transition of change.transitions) {
      const amount = BigInt(transition.after);
      if (amount > 0n) balances.set(transition.walletAddress, amount.toString());
      else balances.delete(transition.walletAddress);
    }
  }
  return Object.freeze({ holderCount: String(holderCount), balances });
}

function compareBalances(replayed, persistedRows, stateCount) {
  const persisted = new Map(persistedRows.map((row) => [
    row.wallet_address, String(row.balance_raw),
  ]));
  const divergent = [...new Set([...replayed.balances.keys(), ...persisted.keys()])]
    .filter((wallet) => replayed.balances.get(wallet) !== persisted.get(wallet));
  return Object.freeze({
    countMatches: replayed.holderCount === String(stateCount)
      && replayed.holderCount === String(persisted.size),
    divergentWallets: divergent,
  });
}

function handoffDecision(state, cursor) {
  if (state.ledger_status !== 'backfilling') return 'already-promoted';
  const next = BigInt(state.backfill_next_block);
  const tail = BigInt(state.tail_capture_from_block);
  if (next < tail) return 'replay-before-tail';
  if (next < BigInt(cursor.journal_floor_block)) return 'below-journal-floor';
  if (next > BigInt(cursor.next_block)) return 'live-behind';
  if (state.live_through_block == null
    || BigInt(state.live_through_block) + 1n !== next) return 'checkpoint-gap';
  if (next === BigInt(cursor.next_block)
    && state.live_through_hash !== cursor.checkpoint_hash) return 'checkpoint-mismatch';
  return 'eligible';
}

async function readCanonical(client, token, from, through) {
  const checkpoint = await client.query(
    `SELECT block_hash FROM robinhood_chain_blocks
      WHERE chain=$1 AND canonical=TRUE AND block_number=$2::bigint`,
    [CHAIN, through.toString()]
  );
  if (!checkpoint.rowCount) throw new Error('canonical checkpoint is missing');
  const events = await client.query(
    `SELECT event.block_number, event.block_hash, event.transaction_hash,
            event.transaction_index, event.log_index, event.address,
            event.topics, event.data
       FROM robinhood_chain_events event
       JOIN robinhood_chain_blocks block
         ON block.chain=event.chain AND block.block_hash=event.block_hash
        AND block.canonical=TRUE
      WHERE event.chain=$1 AND event.address=$2 AND event.topic0=$3
        AND event.block_number BETWEEN $4::bigint AND $5::bigint
      ORDER BY event.block_number, event.transaction_index, event.log_index
      LIMIT $6`,
    [CHAIN, token, TRANSFER_TOPIC, from.toString(), through.toString(), MAX_EVENTS + 1]
  );
  if (events.rows.length > MAX_EVENTS) throw new Error('canonical event sample exceeds limit');
  return decodeRows(events.rows, {
    tokenAddress: token, fromBlock: from, toBlock: through,
    checkpointHash: checkpoint.rows[0].block_hash,
  }, new Set([token]), false).transfers;
}

async function readLegacy(client, token, from, through) {
  const result = await client.query(
    `SELECT block_number, block_hash, transaction_hash, transaction_index,
            log_index, token_address, from_wallet, to_wallet, amount_raw
       FROM robinhood_holder_transfer_journal
      WHERE chain=$1 AND token_address=$2
        AND block_number BETWEEN $3::bigint AND $4::bigint
      ORDER BY block_number, transaction_index, log_index
      LIMIT $5`,
    [CHAIN, token, from.toString(), through.toString(), MAX_EVENTS + 1]
  );
  if (result.rows.length > MAX_EVENTS) throw new Error('legacy event sample exceeds limit');
  return result.rows.map(legacyTransfer);
}

function sampleRangeIncomplete(stateThrough, deployment, captureThrough, tail, parityThrough) {
  return stateThrough < deployment || stateThrough - deployment >= MAX_BLOCKS
    || stateThrough > captureThrough || parityThrough < tail;
}

function parityWindow(tail, liveThrough, captureThrough) {
  const through = liveThrough < captureThrough ? liveThrough : captureThrough;
  const start = through >= MAX_BLOCKS ? through - MAX_BLOCKS + 1n : 0n;
  return { from: tail > start ? tail : start, through };
}

async function auditToken(client, state, frontier) {
  const token = state.token_address;
  const deployment = BigInt(state.deployment_block);
  const stateThrough = state.ledger_status === 'backfilling'
    ? BigInt(state.backfill_next_block) - 1n : BigInt(state.live_through_block);
  const tail = BigInt(state.tail_capture_from_block);
  const liveThrough = BigInt(frontier.holder_checkpoint_block);
  const captureThrough = BigInt(frontier.capture_checkpoint_block);
  const { from: parityFrom, through: parityThrough } = parityWindow(
    tail, liveThrough, captureThrough
  );
  const issues = [];
  if (sampleRangeIncomplete(
    stateThrough, deployment, captureThrough, parityFrom, parityThrough
  )) {
    issues.push('sample_range_incomplete');
  }
  const decision = handoffDecision(state, frontier);
  if (issues.length) return { token, status: state.ledger_status, decision, issues };
  const [history, canonicalTail, legacyTail, balances, pending] = await Promise.all([
    readCanonical(client, token, deployment, stateThrough),
    readCanonical(client, token, parityFrom, parityThrough),
    readLegacy(client, token, parityFrom, parityThrough),
    client.query(`SELECT wallet_address, balance_raw FROM robinhood_holder_balances
      WHERE chain=$1 AND token_address=$2 LIMIT $3`, [CHAIN, token, MAX_WALLETS + 1]),
    client.query(`SELECT 1 FROM robinhood_holder_transfer_journal
      WHERE chain=$1 AND token_address=$2 AND applied=FALSE
        AND block_number <= $3::bigint LIMIT 1`, [CHAIN, token, stateThrough.toString()]),
  ]);
  if (balances.rows.length > MAX_WALLETS) issues.push('balance_sample_exceeds_limit');
  if (!canonicalTail.length) issues.push('tail_sample_has_no_transfers');
  if (state.ledger_status !== 'backfilling' && pending.rowCount) {
    issues.push('applied_frontier_not_drained');
  }
  if (decision === 'eligible') {
    const [checkpoint, overlap] = await Promise.all([
      client.query(`SELECT 1 FROM robinhood_chain_blocks
        WHERE chain=$1 AND canonical=TRUE AND block_number=$2::bigint
          AND block_hash=$3 LIMIT 1`,
      [CHAIN, state.live_through_block, state.live_through_hash]),
      client.query(`SELECT 1 FROM robinhood_holder_transfer_journal
        WHERE chain=$1 AND token_address=$2 AND applied=TRUE
          AND block_number < $3::bigint LIMIT 1`,
      [CHAIN, token, state.backfill_next_block]),
    ]);
    if (!checkpoint.rowCount || overlap.rowCount) issues.push('handoff_decision_divergent');
  }
  const transfers = compareTransfers(canonicalTail, legacyTail);
  const balance = issues.length ? null : compareBalances(
    replayBalances(history), balances.rows, state.holder_count
  );
  if (balance && (!balance.countMatches || balance.divergentWallets.length)) {
    issues.push('balance_divergent');
  }
  return Object.freeze({
    token, status: state.ledger_status, decision,
    history: { fromBlock: deployment.toString(), throughBlock: stateThrough.toString() },
    tail: { fromBlock: parityFrom.toString(), throughBlock: parityThrough.toString() },
    observedTailTransfers: canonicalTail.length,
    transfers, balance: balance && {
      countMatches: balance.countMatches, divergentWallets: balance.divergentWallets.slice(0, 20),
      divergentWalletCount: balance.divergentWallets.length,
    }, issues,
  });
}

function report(frontier, samples, missingTailStates) {
  const frontierIncomplete = [
    frontier.capture_checkpoint_block, frontier.holder_checkpoint_block,
    frontier.raw_floor_block, frontier.journal_floor_block,
  ].some((value) => value == null);
  const incomplete = frontierIncomplete || samples.length !== 2 || missingTailStates > 0
    || samples.some((sample) => sample.issues.length > 0);
  const missing = samples.reduce((total, sample) => total + (sample.transfers?.missing.length || 0), 0);
  const excess = samples.reduce((total, sample) => total + (sample.transfers?.excess.length || 0), 0);
  const divergent = samples.reduce((total, sample) => total + (sample.transfers?.divergent.length || 0), 0);
  return Object.freeze({
    mode: 'read-only', ready: !incomplete && !missing && !excess && !divergent,
    missing, excess, divergent, incomplete, frontierIncomplete,
    missingTailStates, snapshot: {
      captureCheckpointBlock: frontier.capture_checkpoint_block == null
        ? null : String(frontier.capture_checkpoint_block),
      holderCheckpointBlock: frontier.holder_checkpoint_block == null
        ? null : String(frontier.holder_checkpoint_block),
      rawFloorBlock: frontier.raw_floor_block == null
        ? null : String(frontier.raw_floor_block),
      journalFloorBlock: frontier.journal_floor_block == null
        ? null : String(frontier.journal_floor_block),
    }, samples,
  });
}

function createRobinhoodHolderShadowParity(options = {}) {
  const database = options.database || db;
  async function inspect() {
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = await client.query(
        `SELECT capture.checkpoint_block AS capture_checkpoint_block,
                holder.checkpoint_block AS holder_checkpoint_block,
                holder.checkpoint_hash, holder.next_block, holder.journal_floor_block,
                (SELECT MIN(block_number) FROM robinhood_chain_blocks
                  WHERE chain=$1 AND canonical=TRUE) AS raw_floor_block,
                (SELECT COUNT(*)::int FROM robinhood_holder_token_states
                  WHERE chain=$1 AND ledger_status IN ('backfilling','shadow','live')
                    AND (tail_capture_from_block IS NULL
                      OR deployment_block IS NULL OR backfill_next_block IS NULL
                      OR tail_capture_from_block < deployment_block
                      OR (ledger_status IN ('shadow','live') AND (
                        live_through_block IS NULL
                        OR backfill_next_block < tail_capture_from_block
                        OR live_through_block < tail_capture_from_block-1))))
                  AS missing_tail_states
           FROM robinhood_chain_capture_cursor capture
           JOIN robinhood_holder_cursors holder ON holder.chain=capture.chain
            AND holder.stream='live'
          WHERE capture.chain=$1`, [CHAIN]
      );
      const frontier = snapshot.rows[0];
      if (!frontier || frontier.raw_floor_block == null
          || frontier.journal_floor_block == null || frontier.capture_checkpoint_block == null
          || frontier.holder_checkpoint_block == null) {
        await client.query('ROLLBACK');
        return report(frontier || {}, [], Number(frontier?.missing_tail_states || 0));
      }
      const selected = await client.query(
        `WITH eligible AS (
           SELECT state.*, CASE WHEN ledger_status='backfilling'
             THEN 'new' ELSE 'existing' END AS sample_kind,
             ROW_NUMBER() OVER (PARTITION BY ledger_status='backfilling'
               ORDER BY updated_at DESC, token_address) AS sample_rank
             FROM robinhood_holder_token_states state
            WHERE state.chain=$1 AND state.ledger_status IN ('backfilling','shadow','live')
              AND state.tail_capture_from_block IS NOT NULL
              AND state.deployment_block >= GREATEST($2::bigint,$3::bigint)
              AND state.tail_capture_from_block <= $4::bigint
              AND state.holder_count <= $5
              AND state.backfill_next_block IS NOT NULL
              AND state.live_through_block IS NOT NULL
              AND CASE WHEN ledger_status='backfilling' THEN backfill_next_block-1
                ELSE live_through_block END BETWEEN deployment_block
                  AND LEAST(deployment_block+$6::bigint-1,$7::bigint)
         ) SELECT * FROM eligible WHERE sample_rank=1 ORDER BY sample_kind`,
        [CHAIN, frontier.raw_floor_block, frontier.journal_floor_block,
          frontier.holder_checkpoint_block, MAX_WALLETS, MAX_BLOCKS.toString(),
          frontier.capture_checkpoint_block]
      );
      const samples = [];
      for (const state of selected.rows) {
        try { samples.push(await auditToken(client, state, frontier)); } catch (error) {
          samples.push({ token: state.token_address, status: state.ledger_status,
            issues: [error.code || error.message] });
        }
      }
      await client.query('ROLLBACK');
      return report(frontier, samples, Number(frontier.missing_tail_states));
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }
  return Object.freeze({ inspect });
}

module.exports = {
  createRobinhoodHolderShadowParity,
  __private: { compareTransfers, replayBalances, compareBalances, handoffDecision, report },
};
