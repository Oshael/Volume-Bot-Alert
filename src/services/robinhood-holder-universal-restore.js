'use strict';

const db = require('../models/db');
const { TRANSFER_TOPIC } = require('./evm-erc20-supply-delta');
const {
  createRobinhoodCanonicalHolderSource,
} = require('../models/robinhood-canonical-holder-source');
const {
  acquireRobinhoodHolderReorgFence, insertHolderJournalTransfers,
  normalizeHolderTransfer,
} = require('../models/robinhood-holder-ledger');

const MAX_BLOCKS = 250n;
const MAX_EVENTS = 10_000;

function rangeOf(input = {}) {
  const from = String(input.fromBlock ?? '');
  const to = String(input.toBlock ?? '');
  if (!/^\d+$/.test(from) || !/^\d+$/.test(to)) throw new Error('restore range is invalid');
  const start = BigInt(from);
  const end = BigInt(to);
  if (end < start || end - start + 1n > MAX_BLOCKS) {
    throw new Error(`restore range must contain 1-${MAX_BLOCKS} blocks`);
  }
  return Object.freeze({ fromBlock: start.toString(), toBlock: end.toString(),
    blocks: Number(end - start + 1n) });
}

function unavailable(reason) {
  const error = new Error(`holder universal restore unavailable: ${reason}`);
  error.code = 'holder_universal_restore_unavailable';
  error.reason = reason;
  return error;
}

function assertContext(context, range) {
  if (context?.capture_mode !== 'tracked') throw unavailable('tracked-policy-required');
  if (context.cutover_next_block == null || context.next_block == null
      || context.cutover_checkpoint_block == null || !context.cutover_checkpoint_hash
      || context.checkpoint_block == null || !context.checkpoint_hash
      || context.version == null || context.policy_version == null
      || BigInt(context.cutover_next_block) !== BigInt(context.cutover_checkpoint_block) + 1n
      || BigInt(context.next_block) !== BigInt(context.checkpoint_block) + 1n
      || BigInt(range.fromBlock) < BigInt(context.cutover_next_block)
      || BigInt(range.toBlock) >= BigInt(context.next_block)) {
    throw unavailable('range-outside-tracked-capture');
  }
}

function createRobinhoodHolderUniversalRestore(options = {}) {
  const database = options.database || db;
  const source = options.source || createRobinhoodCanonicalHolderSource({ database });

  async function readContext() {
    const result = await database.query(
      `SELECT policy.capture_mode, policy.version AS policy_version,
              policy.cutover_next_block, policy.cutover_checkpoint_block,
              policy.cutover_checkpoint_hash, cursor.next_block, cursor.version,
              cursor.checkpoint_block, cursor.checkpoint_hash
         FROM robinhood_holder_capture_policy policy
         JOIN robinhood_holder_cursors cursor
           ON cursor.chain=policy.chain AND cursor.stream='live'
        WHERE policy.chain='robinhood'`
    );
    return result.rows[0];
  }

  async function commitRange(context, range, captured, transfers) {
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '30000ms'");
      await acquireRobinhoodHolderReorgFence(client, 'shared');
      const cursor = (await client.query(
        `SELECT next_block, version, checkpoint_block, checkpoint_hash
           FROM robinhood_holder_cursors
          WHERE chain='robinhood' AND stream='live' FOR UPDATE`
      )).rows[0];
      const policy = (await client.query(
        `SELECT capture_mode, version, cutover_next_block,
                cutover_checkpoint_block, cutover_checkpoint_hash
           FROM robinhood_holder_capture_policy
          WHERE chain='robinhood' FOR SHARE`
      )).rows[0];
      if (!cursor || !policy || String(cursor.version) !== String(context.version)
          || String(cursor.next_block) !== String(context.next_block)
          || String(policy.version) !== String(context.policy_version)
          || String(policy.cutover_next_block) !== String(context.cutover_next_block)
          || String(policy.cutover_checkpoint_hash)
            !== String(context.cutover_checkpoint_hash)
          || String(cursor.checkpoint_hash) !== String(context.checkpoint_hash)
          || policy.capture_mode !== 'tracked') throw unavailable('cursor-or-policy-changed');

      const proof = (await client.query(
        `SELECT (SELECT COUNT(*)::int FROM robinhood_chain_blocks block
                  WHERE block.chain='robinhood' AND block.canonical=TRUE
                    AND block.block_number BETWEEN $1::bigint AND $2::bigint)
                  AS canonical_blocks,
                (SELECT COUNT(*)::int FROM robinhood_chain_events event
                  JOIN robinhood_chain_blocks block
                    ON block.chain=event.chain AND block.block_hash=event.block_hash
                   AND block.canonical=TRUE
                 WHERE event.chain='robinhood' AND event.topic0=$3
                   AND event.block_number BETWEEN $1::bigint AND $2::bigint)
                  AS raw_transfers,
                (SELECT COUNT(*)::int
                   FROM jsonb_to_recordset($5::jsonb) AS item(
                     block_number bigint, block_hash text, transaction_hash text,
                     transaction_index int, log_index int, token_address text,
                     from_topic text, to_topic text, data text)
                   JOIN robinhood_chain_events event
                     ON event.chain='robinhood' AND event.block_hash=item.block_hash
                    AND event.transaction_hash=item.transaction_hash
                    AND event.log_index=item.log_index
                   JOIN robinhood_chain_blocks block
                     ON block.chain=event.chain AND block.block_hash=event.block_hash
                    AND block.canonical=TRUE
                  WHERE event.topic0=$3
                    AND event.block_number BETWEEN $1::bigint AND $2::bigint
                    AND event.block_number=item.block_number
                    AND event.transaction_index=item.transaction_index
                    AND event.address=item.token_address
                    AND jsonb_array_length(event.topics)=3
                    AND lower(event.topics->>1)=item.from_topic
                    AND lower(event.topics->>2)=item.to_topic
                    AND lower(event.data)=item.data)
                  AS matched_transfers,
                EXISTS(SELECT 1 FROM robinhood_chain_blocks block
                  WHERE block.chain='robinhood' AND block.canonical=TRUE
                    AND block.block_number=$2::bigint AND block.block_hash=$4)
                  AS checkpoint_canonical,
                EXISTS(SELECT 1 FROM robinhood_chain_blocks block
                  WHERE block.chain='robinhood' AND block.canonical=TRUE
                    AND block.block_number=$6::bigint AND block.block_hash=$7)
                  AS cutover_anchor_canonical,
                EXISTS(SELECT 1 FROM robinhood_chain_blocks block
                  WHERE block.chain='robinhood' AND block.canonical=TRUE
                    AND block.block_number=$8::bigint AND block.block_hash=$9)
                  AS holder_checkpoint_canonical`,
        [range.fromBlock, range.toBlock, TRANSFER_TOPIC, captured.checkpoint.hash,
          JSON.stringify(transfers.map((transfer) => ({
            block_number: transfer.blockNumber,
            block_hash: transfer.blockHash,
            transaction_hash: transfer.transactionHash,
            transaction_index: transfer.transactionIndex,
            log_index: transfer.logIndex,
            token_address: transfer.tokenAddress,
            from_topic: `0x${'0'.repeat(24)}${transfer.fromWallet.slice(2)}`,
            to_topic: `0x${'0'.repeat(24)}${transfer.toWallet.slice(2)}`,
            data: `0x${BigInt(transfer.amountRaw).toString(16).padStart(64, '0')}`,
          }))), policy.cutover_checkpoint_block, policy.cutover_checkpoint_hash,
          cursor.checkpoint_block, cursor.checkpoint_hash]
      )).rows[0];
      if (!proof?.checkpoint_canonical || !proof.cutover_anchor_canonical
          || !proof.holder_checkpoint_canonical
          || Number(proof.canonical_blocks) !== range.blocks
          || Number(proof.raw_transfers) !== transfers.length
          || Number(proof.matched_transfers) !== transfers.length) {
        throw unavailable('raw-range-incomplete-or-changed');
      }
      const inserted = await insertHolderJournalTransfers(client, transfers);
      await client.query('COMMIT');
      return Object.freeze({ mode: 'apply', fromBlock: range.fromBlock,
        toBlock: range.toBlock, matched: transfers.length, inserted,
        alreadyPresent: transfers.length - inserted });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function restoreRange(input = {}) {
    const range = rangeOf(input);
    const context = await readContext();
    assertContext(context, range);
    const captured = await source.readGlobalRange({
      fromBlock: range.fromBlock, toBlock: range.toBlock,
      tokenAddresses: [], captureAllTransfers: true,
    });
    const transfers = captured.transfers.map(normalizeHolderTransfer);
    if (String(captured.fromBlock) !== range.fromBlock
        || String(captured.toBlock) !== range.toBlock
        || String(captured.checkpoint?.number) !== range.toBlock
        || !/^0x[0-9a-f]{64}$/.test(String(captured.checkpoint?.hash || ''))
        || transfers.length > MAX_EVENTS
        || Number(captured.telemetry?.observedLogs) !== transfers.length
        || Number(captured.telemetry?.ignoredMalformedLogs || 0) !== 0) {
      throw unavailable('canonical-source-incomplete');
    }
    if (input.apply !== true) return Object.freeze({
      mode: 'preview', fromBlock: range.fromBlock, toBlock: range.toBlock,
      observedTransfers: transfers.length, checkpointHash: captured.checkpoint.hash,
    });
    return commitRange(context, range, captured, transfers);
  }

  return Object.freeze({ restoreRange });
}

module.exports = { createRobinhoodHolderUniversalRestore, rangeOf };
