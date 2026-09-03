'use strict';
const { createHash } = require('node:crypto');
const db = require('./db');
const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_chain_capture';
const CAPTURE_VERSION = 2;
function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw);
}
function hex(value, bytes, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}
function optionalAddress(value, label) {
  return value == null ? null : hex(value, 20, label);
}
function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}
function timestamp(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}
function captureDigest(block, transactions, events) {
  const payload = {
    block: [block.number.toString(), block.hash, block.parentHash, block.timestamp,
      block.captureVersion],
    transactions: [...transactions].sort((a, b) => a.transaction_index - b.transaction_index),
    events: [...events].sort((a, b) => a.log_index - b.log_index),
  };
  return `0x${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
function normalizeInput(input) {
  const source = input?.block || {};
  const finality = source.finality ?? 'observed';
  if (!['observed', 'finalized'].includes(finality)) throw new Error('block.finality is invalid');
  const block = {
    number: quantity(source.number, 'block.number'),
    hash: hex(source.hash, 32, 'block.hash'),
    parentHash: hex(source.parentHash, 32, 'block.parentHash'),
    timestamp: timestamp(source.timestamp, 'block.timestamp'),
    captureVersion: CAPTURE_VERSION,
    finality,
    headObservedAt: timestamp(source.headObservedAt, 'block.headObservedAt'),
    receiptsAvailableAt: timestamp(source.receiptsAvailableAt, 'block.receiptsAvailableAt'),
  };
  const transactions = (input.transactions || []).map((entry, index) => ({
    transaction_hash: hex(entry.hash, 32, `transactions[${index}].hash`),
    transaction_index: Number(quantity(entry.index, `transactions[${index}].index`)),
    from_address: hex(entry.from, 20, `transactions[${index}].from`),
    to_address: optionalAddress(entry.to, `transactions[${index}].to`),
    receipt_succeeded: requiredBoolean(entry.succeeded, `transactions[${index}].succeeded`),
    contract_address: optionalAddress(
      entry.contractAddress, `transactions[${index}].contractAddress`
    ),
    nonce: quantity(entry.nonce, `transactions[${index}].nonce`).toString(),
    value_wei: quantity(entry.valueWei, `transactions[${index}].valueWei`).toString(),
  }));
  const transactionMap = new Map(transactions.map((entry) => [entry.transaction_hash, entry]));
  if (transactionMap.size !== transactions.length) throw new Error('transactions contain duplicates');
  const events = (input.events || []).map((entry, index) => {
    const transactionHash = hex(entry.transactionHash, 32, `events[${index}].transactionHash`);
    const transaction = transactionMap.get(transactionHash);
    if (!transaction) throw new Error(`events[${index}] transaction is not included`);
    const topics = (entry.topics || []).map((topic, topicIndex) => (
      hex(topic, 32, `events[${index}].topics[${topicIndex}]`)
    ));
    if (!topics.length) throw new Error(`events[${index}].topics is empty`);
    const transactionIndex = Number(quantity(entry.transactionIndex, `events[${index}].transactionIndex`));
    if (transactionIndex !== transaction.transaction_index) {
      throw new Error(`events[${index}] transaction index diverges`);
    }
    return {
      transaction_hash: transactionHash, transaction_index: transactionIndex,
      log_index: Number(quantity(entry.logIndex, `events[${index}].logIndex`)),
      address: hex(entry.address, 20, `events[${index}].address`),
      topic0: topics[0], topics, data: String(entry.data ?? ''),
    };
  });
  if (new Set(events.map((entry) => entry.log_index)).size !== events.length) {
    throw new Error('events contain duplicate log indexes');
  }
  const nodeHead = quantity(input.nodeHead ?? block.number, 'nodeHead');
  const finalizedHead = quantity(input.finalizedHead ?? 0, 'finalizedHead');
  if (nodeHead < block.number || finalizedHead > nodeHead
      || (block.finality === 'finalized' && finalizedHead < block.number)) {
    throw new Error('capture frontiers are invalid');
  }
  return { block, transactions, events, nodeHead, finalizedHead,
    digest: captureDigest(block, transactions, events) };
}
function createRobinhoodChainCaptureJournal(options = {}) {
  const database = options.database || db;
  async function getCursor(client = database) {
    const result = await client.query(
      `SELECT next_block, checkpoint_block, checkpoint_hash, node_head,
              finalized_head, head_observed_at, receipts_available_at, version
         FROM robinhood_chain_capture_cursor WHERE chain = $1`, [CHAIN]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return Object.fromEntries(Object.entries(row).map(([key, value]) => (
      [key, typeof value === 'string' || value == null || value instanceof Date
        ? value : String(value)]
    )));
  }
  async function commitBlock(input = {}) {
    const normalized = normalizeInput(input);
    const { block, transactions, events, nodeHead, finalizedHead, digest } = normalized;
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const cursor = await client.query(
        'SELECT * FROM robinhood_chain_capture_cursor WHERE chain = $1 FOR UPDATE', [CHAIN]
      );
      const current = cursor.rows[0];
      if (current && block.number === BigInt(current.checkpoint_block)
          && block.hash === current.checkpoint_hash) {
        const replay = await client.query(
          'SELECT capture_digest FROM robinhood_chain_blocks WHERE chain=$1 AND block_hash=$2',
          [CHAIN, block.hash]
        );
        if (replay.rows[0]?.capture_digest !== digest) {
          const error = new Error(`replayed block ${block.number} has divergent capture data`);
          error.code = 'capture_replay_conflict';
          throw error;
        }
        await client.query('COMMIT');
        return { status: 'replayed', transactions: 0, events: 0 };
      }
      if (current && block.number !== BigInt(current.next_block)) {
        const error = new Error(`capture expected block ${current.next_block}, received ${block.number}`);
        error.code = 'capture_sequence_conflict';
        throw error;
      }
      if (current?.checkpoint_hash && block.parentHash !== current.checkpoint_hash) {
        const error = new Error(`block ${block.number} does not extend the capture checkpoint`);
        error.code = 'capture_reorg_detected';
        throw error;
      }
      await client.query(
        `INSERT INTO robinhood_chain_blocks(
           chain, block_number, block_hash, parent_hash, capture_digest, block_timestamp, finality,
           head_observed_at, receipts_available_at, capture_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [CHAIN, block.number.toString(), block.hash, block.parentHash, digest, block.timestamp,
          block.finality, block.headObservedAt, block.receiptsAvailableAt, block.captureVersion]
      );
      const insertedTransactions = await client.query(
        `INSERT INTO robinhood_chain_transactions(
           chain, block_hash, transaction_hash, transaction_index, from_address,
           to_address, receipt_succeeded, contract_address, nonce, value_wei
         ) SELECT $1, $2, item.transaction_hash, item.transaction_index,
                  item.from_address, item.to_address, item.receipt_succeeded,
                  item.contract_address, item.nonce, item.value_wei
             FROM jsonb_to_recordset($3::jsonb) AS item(
               transaction_hash TEXT, transaction_index INTEGER, from_address TEXT,
               to_address TEXT, receipt_succeeded BOOLEAN, contract_address TEXT,
               nonce NUMERIC, value_wei NUMERIC
             )`, [CHAIN, block.hash, JSON.stringify(transactions)]
      );
      const insertedEvents = await client.query(
        `INSERT INTO robinhood_chain_events(
           chain, block_hash, block_number, transaction_hash, transaction_index,
           log_index, address, topic0, topics, data
         ) SELECT $1, $2, $3, item.transaction_hash, item.transaction_index,
                  item.log_index, item.address, item.topic0, item.topics, item.data
             FROM jsonb_to_recordset($4::jsonb) AS item(
               transaction_hash TEXT, transaction_index INTEGER, log_index INTEGER,
               address TEXT, topic0 TEXT, topics JSONB, data TEXT
             )`, [CHAIN, block.hash, block.number.toString(), JSON.stringify(events)]
      );
      await client.query(
        `INSERT INTO robinhood_chain_capture_cursor(
           chain, next_block, checkpoint_block, checkpoint_hash, node_head,
           finalized_head, head_observed_at, receipts_available_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (chain) DO UPDATE SET
           next_block=EXCLUDED.next_block, checkpoint_block=EXCLUDED.checkpoint_block,
           checkpoint_hash=EXCLUDED.checkpoint_hash, node_head=EXCLUDED.node_head,
           finalized_head=EXCLUDED.finalized_head, head_observed_at=EXCLUDED.head_observed_at,
           receipts_available_at=EXCLUDED.receipts_available_at,
           version=robinhood_chain_capture_cursor.version+1, updated_at=NOW()`,
        [CHAIN, (block.number + 1n).toString(), block.number.toString(), block.hash,
          nodeHead.toString(), finalizedHead.toString(), block.headObservedAt,
          block.receiptsAvailableAt]
      );
      await client.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, block.number.toString()]);
      await client.query('COMMIT');
      return { status: 'committed', transactions: insertedTransactions.rowCount, events: insertedEvents.rowCount };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }
  return Object.freeze({ commitBlock, getCursor });
}
module.exports = {
  CAPTURE_VERSION, NOTIFY_CHANNEL, createRobinhoodChainCaptureJournal,
  __private: { normalizeInput },
};
