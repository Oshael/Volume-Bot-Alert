'use strict';
const { createHash } = require('node:crypto');
const db = require('./db');
const { routeCanonicalEvents } = require('../services/robinhood-chain-domain-router');
const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_chain_capture';
const DOMAIN_NOTIFY_CHANNEL = 'robinhood_chain_domain_outbox';
const CAPTURE_VERSION = 3;
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
function captureDigest(block, transactions, events, v3Snapshots) {
  const payload = {
    block: [block.number.toString(), block.hash, block.parentHash, block.timestamp,
      block.captureVersion],
    transactions: [...transactions].sort((a, b) => a.transaction_index - b.transaction_index),
    events: [...events].sort((a, b) => a.log_index - b.log_index),
    v3Snapshots: [...v3Snapshots].sort((a, b) => a.log_index - b.log_index),
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
  const eventIndexes = new Set(events.map((entry) => entry.log_index));
  const v3Snapshots = (input.v3Snapshots || []).map((entry, index) => {
    const logIndex = Number(quantity(entry.logIndex, `v3Snapshots[${index}].logIndex`));
    if (!eventIndexes.has(logIndex)) {
      throw new Error(`v3Snapshots[${index}] event is not included`);
    }
    return {
      log_index: logIndex,
      pool_address: hex(entry.poolAddress, 20, `v3Snapshots[${index}].poolAddress`),
      token_address: hex(entry.tokenAddress, 20, `v3Snapshots[${index}].tokenAddress`),
      quote_address: hex(entry.quoteAddress, 20, `v3Snapshots[${index}].quoteAddress`),
      token_balance_raw: quantity(
        entry.tokenBalanceRaw, `v3Snapshots[${index}].tokenBalanceRaw`
      ).toString(),
      quote_balance_raw: quantity(
        entry.quoteBalanceRaw, `v3Snapshots[${index}].quoteBalanceRaw`
      ).toString(),
    };
  });
  if (new Set(v3Snapshots.map((entry) => entry.log_index)).size !== v3Snapshots.length) {
    throw new Error('v3Snapshots contain duplicate log indexes');
  }
  const nodeHead = quantity(input.nodeHead ?? block.number, 'nodeHead');
  const finalizedHead = quantity(input.finalizedHead ?? 0, 'finalizedHead');
  if (nodeHead < block.number || finalizedHead > nodeHead
      || (block.finality === 'finalized' && finalizedHead < block.number)) {
    throw new Error('capture frontiers are invalid');
  }
  return { block, transactions, events, v3Snapshots, nodeHead, finalizedHead,
    digest: captureDigest(block, transactions, events, v3Snapshots) };
}
function batchPayload(entries) {
  const blocks = []; const transactions = []; const events = [];
  const v3Snapshots = []; const workItems = [];
  for (const entry of entries) {
    const { block } = entry;
    blocks.push({
      block_number: block.number.toString(), block_hash: block.hash,
      parent_hash: block.parentHash, capture_digest: entry.digest,
      block_timestamp: block.timestamp, finality: block.finality,
      head_observed_at: block.headObservedAt,
      receipts_available_at: block.receiptsAvailableAt,
      capture_version: block.captureVersion,
    });
    transactions.push(...entry.transactions.map((transaction) => ({
      block_hash: block.hash, ...transaction,
    })));
    events.push(...entry.events.map((event) => ({
      block_hash: block.hash, block_number: block.number.toString(), ...event,
    })));
    v3Snapshots.push(...entry.v3Snapshots.map((snapshot) => ({
      block_hash: block.hash, ...snapshot,
    })));
    const eventsByLogIndex = new Map(entry.events.map((event) => [event.log_index, event]));
    workItems.push(...routeCanonicalEvents(entry.events).map((item) => ({
      block_hash: block.hash, block_number: block.number.toString(), domain: item.domain,
      transaction_index: eventsByLogIndex.get(item.log_index).transaction_index,
      log_index: item.log_index,
    })));
  }
  return { blocks, transactions, events, v3Snapshots, workItems };
}
function validateSequence(entries, current) {
  let expected = current ? BigInt(current.next_block) : entries[0].block.number;
  let parentHash = current?.checkpoint_hash || null;
  for (const entry of entries) {
    if (entry.block.number !== expected) {
      const error = new Error(`capture expected block ${expected}, received ${entry.block.number}`);
      error.code = 'capture_sequence_conflict'; throw error;
    }
    if (parentHash && entry.block.parentHash !== parentHash) {
      const error = new Error(`block ${entry.block.number} does not extend the capture checkpoint`);
      error.code = 'capture_reorg_detected'; throw error;
    }
    expected += 1n; parentHash = entry.block.hash;
  }
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
  async function commitBlocks(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new Error('capture batch must not be empty');
    }
    const entries = inputs.map(normalizeInput);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const cursor = await client.query(
        'SELECT * FROM robinhood_chain_capture_cursor WHERE chain = $1 FOR UPDATE', [CHAIN]
      );
      const current = cursor.rows[0];
      const replay = entries.length === 1 && current
        && entries[0].block.number === BigInt(current.checkpoint_block)
        && entries[0].block.hash === current.checkpoint_hash;
      if (replay) {
        const replay = await client.query(
          'SELECT capture_digest FROM robinhood_chain_blocks WHERE chain=$1 AND block_hash=$2',
          [CHAIN, entries[0].block.hash]
        );
        if (replay.rows[0]?.capture_digest !== entries[0].digest) {
          const error = new Error(
            `replayed block ${entries[0].block.number} has divergent capture data`
          );
          error.code = 'capture_replay_conflict';
          throw error;
        }
        await client.query('COMMIT');
        return [{
          status: 'replayed', transactions: 0, events: 0, v3Snapshots: 0, workItems: 0,
        }];
      }
      validateSequence(entries, current);
      const payload = batchPayload(entries);
      await client.query(
        `INSERT INTO robinhood_chain_blocks(
           chain, block_number, block_hash, parent_hash, capture_digest, block_timestamp, finality,
           head_observed_at, receipts_available_at, capture_version
         ) SELECT $1, item.block_number, item.block_hash, item.parent_hash,
                  item.capture_digest, item.block_timestamp, item.finality,
                  item.head_observed_at, item.receipts_available_at, item.capture_version
             FROM jsonb_to_recordset($2::jsonb) AS item(
               block_number BIGINT, block_hash TEXT, parent_hash TEXT, capture_digest TEXT,
               block_timestamp TIMESTAMPTZ, finality TEXT, head_observed_at TIMESTAMPTZ,
               receipts_available_at TIMESTAMPTZ, capture_version INTEGER
             )`, [CHAIN, JSON.stringify(payload.blocks)]
      );
      await client.query(
        `INSERT INTO robinhood_chain_transactions(
           chain, block_hash, transaction_hash, transaction_index, from_address,
           to_address, receipt_succeeded, contract_address, nonce, value_wei
         ) SELECT $1, item.block_hash, item.transaction_hash, item.transaction_index,
                  item.from_address, item.to_address, item.receipt_succeeded,
                  item.contract_address, item.nonce, item.value_wei
             FROM jsonb_to_recordset($2::jsonb) AS item(
               block_hash TEXT, transaction_hash TEXT, transaction_index INTEGER, from_address TEXT,
               to_address TEXT, receipt_succeeded BOOLEAN, contract_address TEXT,
               nonce NUMERIC, value_wei NUMERIC
             )`, [CHAIN, JSON.stringify(payload.transactions)]
      );
      await client.query(
        `INSERT INTO robinhood_chain_events(
           chain, block_hash, block_number, transaction_hash, transaction_index,
           log_index, address, topic0, topics, data
         ) SELECT $1, item.block_hash, item.block_number, item.transaction_hash,
                  item.transaction_index,
                  item.log_index, item.address, item.topic0, item.topics, item.data
             FROM jsonb_to_recordset($2::jsonb) AS item(
               block_hash TEXT, block_number BIGINT, transaction_hash TEXT,
               transaction_index INTEGER, log_index INTEGER, address TEXT,
               topic0 TEXT, topics JSONB, data TEXT
             )`, [CHAIN, JSON.stringify(payload.events)]
      );
      await client.query(
        `INSERT INTO robinhood_chain_v3_balance_snapshots(
           chain, block_hash, log_index, pool_address, token_address, quote_address,
           token_balance_raw, quote_balance_raw
         ) SELECT $1, item.block_hash, item.log_index, item.pool_address, item.token_address,
                  item.quote_address, item.token_balance_raw, item.quote_balance_raw
             FROM jsonb_to_recordset($2::jsonb) AS item(
               block_hash TEXT, log_index INTEGER, pool_address TEXT, token_address TEXT,
               quote_address TEXT, token_balance_raw NUMERIC, quote_balance_raw NUMERIC
             )`, [CHAIN, JSON.stringify(payload.v3Snapshots)]
      );
      await client.query(
        `INSERT INTO robinhood_chain_domain_outbox(
           chain, domain, block_hash, block_number, transaction_index, log_index
         ) SELECT $1, item.domain, item.block_hash, item.block_number,
                  item.transaction_index, item.log_index
             FROM jsonb_to_recordset($2::jsonb) AS item(
               domain TEXT, block_hash TEXT, block_number BIGINT,
               transaction_index INTEGER, log_index INTEGER
             )`, [CHAIN, JSON.stringify(payload.workItems)]
      );
      const last = entries.at(-1);
      const version = current
        ? BigInt(current.version) + BigInt(entries.length) : BigInt(entries.length - 1);
      await client.query(
        `INSERT INTO robinhood_chain_capture_cursor(
           chain, next_block, checkpoint_block, checkpoint_hash, node_head,
           finalized_head, head_observed_at, receipts_available_at, version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (chain) DO UPDATE SET
           next_block=EXCLUDED.next_block, checkpoint_block=EXCLUDED.checkpoint_block,
           checkpoint_hash=EXCLUDED.checkpoint_hash, node_head=EXCLUDED.node_head,
           finalized_head=EXCLUDED.finalized_head, head_observed_at=EXCLUDED.head_observed_at,
           receipts_available_at=EXCLUDED.receipts_available_at,
           version=EXCLUDED.version, updated_at=NOW()`,
        [CHAIN, (last.block.number + 1n).toString(), last.block.number.toString(), last.block.hash,
          last.nodeHead.toString(), last.finalizedHead.toString(), last.block.headObservedAt,
          last.block.receiptsAvailableAt, version.toString()]
      );
      await client.query('SELECT pg_notify($1, $2)', [NOTIFY_CHANNEL, last.block.number.toString()]);
      if (payload.workItems.length > 0) {
        await client.query(
          'SELECT pg_notify($1, $2)', [DOMAIN_NOTIFY_CHANNEL, last.block.number.toString()]
        );
      }
      await client.query('COMMIT');
      return entries.map((entry) => ({
        status: 'committed', transactions: entry.transactions.length,
        events: entry.events.length, v3Snapshots: entry.v3Snapshots.length,
        workItems: routeCanonicalEvents(entry.events).length,
      }));
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }
  async function commitBlock(input = {}) {
    return (await commitBlocks([input]))[0];
  }
  return Object.freeze({ commitBlock, commitBlocks, getCursor });
}
module.exports = {
  CAPTURE_VERSION, DOMAIN_NOTIFY_CHANNEL, NOTIFY_CHANNEL, createRobinhoodChainCaptureJournal,
  __private: { batchPayload, normalizeInput, validateSequence },
};
