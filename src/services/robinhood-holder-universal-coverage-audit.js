'use strict';

const db = require('../models/db');
const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');
const { __private: { decodeTransferLog } } = require('./robinhood-holder-transfer-reader');
const { normalizeHolderTransfer } = require('../models/robinhood-holder-ledger');
const { rangeOf } = require('./robinhood-holder-universal-restore');

const MAX_EVENTS = 10_000;
const EVIDENCE_FIELDS = Object.freeze([
  'blockNumber', 'blockHash', 'transactionHash', 'transactionIndex', 'logIndex',
  'tokenAddress', 'fromWallet', 'toWallet', 'amountRaw',
]);

function identity(transfer) {
  return `${transfer.transactionHash}:${transfer.logIndex}`;
}

function journalTransfer(row) {
  return normalizeHolderTransfer({
    blockNumber: row.block_number, blockHash: row.block_hash,
    transactionHash: row.transaction_hash, transactionIndex: row.transaction_index,
    logIndex: row.log_index, tokenAddress: row.token_address,
    fromWallet: row.from_wallet, toWallet: row.to_wallet, amountRaw: row.amount_raw,
  });
}

function compareEvidence(raw, journal) {
  const expected = new Map();
  const actual = new Map();
  for (const transfer of raw) {
    const key = identity(transfer);
    if (expected.has(key)) throw new Error('canonical raw range has duplicate Transfer identities');
    expected.set(key, transfer);
  }
  for (const transfer of journal) {
    const key = identity(transfer);
    if (actual.has(key)) throw new Error('holder journal range has duplicate Transfer identities');
    actual.set(key, transfer);
  }
  const counts = { missing: 0, excess: 0, divergent: 0 };
  const samples = [];
  const add = (kind, key) => {
    counts[kind] += 1;
    if (samples.length < 4) samples.push({ kind, identity: key });
  };
  for (const [key, transfer] of expected) {
    const observed = actual.get(key);
    if (!observed) add('missing', key);
    else if (EVIDENCE_FIELDS.some((field) => transfer[field] !== observed[field])) {
      add('divergent', key);
    }
  }
  for (const key of actual.keys()) if (!expected.has(key)) add('excess', key);
  return { ...counts, samples };
}

function assertCoveredContext(context, range) {
  const from = BigInt(range.fromBlock);
  const to = BigInt(range.toBlock);
  if (!context || context.capture_mode !== 'tracked'
      || context.cutover_next_block == null || context.next_block == null
      || context.cutover_checkpoint_block == null || !context.cutover_checkpoint_hash
      || context.checkpoint_block == null || !context.checkpoint_hash
      || BigInt(context.cutover_next_block) !== BigInt(context.cutover_checkpoint_block) + 1n
      || BigInt(context.next_block) !== BigInt(context.checkpoint_block) + 1n
      || from < BigInt(context.cutover_next_block) || to >= BigInt(context.next_block)
      || context.raw_floor_block == null || BigInt(context.raw_floor_block) > from
      || context.capture_checkpoint_block == null
      || BigInt(context.capture_checkpoint_block) < to) {
    throw new Error('tracked holder range or retained raw coverage is unavailable');
  }
}

function createRobinhoodHolderUniversalCoverageAudit(options = {}) {
  const database = options.database || db;

  async function inspectRange(input = {}) {
    const range = rangeOf(input);
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      const context = (await client.query(
        `SELECT policy.capture_mode, policy.version AS policy_version,
                policy.cutover_next_block, policy.cutover_checkpoint_block,
                policy.cutover_checkpoint_hash, holder.next_block,
                holder.version AS holder_version, holder.checkpoint_block,
                holder.checkpoint_hash, capture.checkpoint_block AS capture_checkpoint_block,
                (SELECT MIN(block_number) FROM robinhood_chain_blocks
                  WHERE chain='robinhood' AND canonical=TRUE) AS raw_floor_block
           FROM robinhood_holder_capture_policy policy
           JOIN robinhood_holder_cursors holder
             ON holder.chain=policy.chain AND holder.stream='live'
           JOIN robinhood_chain_capture_cursor capture ON capture.chain=policy.chain
          WHERE policy.chain='robinhood'`
      )).rows[0];
      const from = BigInt(range.fromBlock);
      const to = BigInt(range.toBlock);
      assertCoveredContext(context, range);
      const anchors = (await client.query(
        `SELECT (SELECT COUNT(*)::int FROM robinhood_chain_blocks
                  WHERE chain='robinhood' AND canonical=TRUE
                    AND block_number BETWEEN $1::bigint AND $2::bigint) AS blocks,
                (SELECT block_hash FROM robinhood_chain_blocks
                  WHERE chain='robinhood' AND canonical=TRUE AND block_number=$2::bigint)
                  AS range_checkpoint_hash,
                EXISTS(SELECT 1 FROM robinhood_chain_blocks
                  WHERE chain='robinhood' AND canonical=TRUE
                    AND block_number=$3::bigint AND block_hash=$4) AS cutover_canonical,
                EXISTS(SELECT 1 FROM robinhood_chain_blocks
                  WHERE chain='robinhood' AND canonical=TRUE
                    AND block_number=$5::bigint AND block_hash=$6) AS holder_canonical`,
        [range.fromBlock, range.toBlock, context.cutover_checkpoint_block,
          context.cutover_checkpoint_hash, context.checkpoint_block, context.checkpoint_hash]
      )).rows[0];
      if (!anchors.cutover_canonical || !anchors.holder_canonical
          || Number(anchors.blocks) !== range.blocks || !anchors.range_checkpoint_hash) {
        throw new Error('canonical holder range or anchor is incomplete');
      }
      const raw = (await client.query(
        `SELECT event.block_number, event.block_hash, event.transaction_hash,
                event.transaction_index, event.log_index, event.address,
                event.topics, event.data
           FROM robinhood_chain_events event
           JOIN robinhood_chain_blocks block
             ON block.chain=event.chain AND block.block_hash=event.block_hash
            AND block.canonical=TRUE
          WHERE event.chain='robinhood' AND event.topic0=$3
            AND event.block_number BETWEEN $1::bigint AND $2::bigint
          ORDER BY event.block_number, event.transaction_index, event.log_index
          LIMIT $4`,
        [range.fromBlock, range.toBlock, TRANSFER_TOPIC, MAX_EVENTS + 1]
      )).rows;
      const journal = (await client.query(
        `SELECT block_number, block_hash, transaction_hash, transaction_index,
                log_index, token_address, from_wallet, to_wallet, amount_raw
           FROM robinhood_holder_transfer_journal
          WHERE chain='robinhood' AND block_number BETWEEN $1::bigint AND $2::bigint
          ORDER BY block_number, transaction_index, log_index LIMIT $3`,
        [range.fromBlock, range.toBlock, MAX_EVENTS + 1]
      )).rows;
      if (raw.length > MAX_EVENTS || journal.length > MAX_EVENTS) {
        throw new Error('holder audit range exceeds event limit');
      }
      const expected = raw.map((row) => normalizeHolderTransfer(decodeTransferLog({
        blockNumber: String(row.block_number), blockHash: row.block_hash,
        transactionHash: row.transaction_hash, transactionIndex: row.transaction_index,
        logIndex: row.log_index, address: row.address, topics: row.topics, data: row.data,
      }, { tokenAddress: null, fromBlock: from, toBlock: to,
        checkpointHash: anchors.range_checkpoint_hash })));
      const comparison = compareEvidence(expected, journal.map(journalTransfer));
      await client.query('ROLLBACK');
      return Object.freeze({
        mode: 'read-only', fromBlock: range.fromBlock, toBlock: range.toBlock,
        nextBlock: (to + 1n).toString(), rangeComplete: comparison.missing === 0
          && comparison.excess === 0 && comparison.divergent === 0,
        rawTransfers: expected.length, journalTransfers: journal.length,
        ...comparison,
        snapshot: { policyVersion: String(context.policy_version),
          holderVersion: String(context.holder_version),
          holderNextBlock: String(context.next_block),
          rangeCheckpointHash: anchors.range_checkpoint_hash },
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ inspectRange });
}

module.exports = { createRobinhoodHolderUniversalCoverageAudit, compareEvidence };
