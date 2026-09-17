'use strict';

const db = require('./db');
const { TRANSFER_TOPIC } = require('../services/evm-erc20-supply-delta');
const {
  __private: { decodeTransferLog },
} = require('../services/robinhood-holder-transfer-reader');

const CHAIN = 'robinhood';
const MAX_RANGE_BLOCKS = 5000n;
const MAX_RECEIPT_RANGE_BLOCKS = 1000n;

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized);
}

function address(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function boundedRange(input, maximum, label) {
  const fromBlock = quantity(input.fromBlock, 'fromBlock');
  const toBlock = quantity(input.toBlock, 'toBlock');
  if (fromBlock > toBlock) throw new Error(`${label} range is inverted`);
  if (toBlock - fromBlock + 1n > maximum) {
    throw new Error(`${label} range exceeds ${maximum} blocks`);
  }
  return { fromBlock, toBlock };
}

function logFromRow(row) {
  return {
    blockNumber: String(row.block_number), blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    transactionIndex: String(row.transaction_index), logIndex: String(row.log_index),
    address: row.address, topics: row.topics, data: row.data, removed: false,
  };
}

function sourceGap(message, reason = 'coverage-unavailable', coverage = null) {
  const error = new Error(message);
  error.code = 'canonical_holder_source_gap';
  error.reason = reason;
  if (coverage) error.coverage = Object.freeze(coverage);
  return error;
}

function coverageFrom(row) {
  if (!row || row.checkpoint_block == null || row.node_head == null) {
    throw sourceGap('canonical capture frontier is unavailable', 'frontier-unavailable');
  }
  const frontier = quantity(row.checkpoint_block, 'checkpoint_block');
  const nodeHead = quantity(row.node_head, 'node_head');
  const floor = row.journal_start_block == null
    ? null : quantity(row.journal_start_block, 'journal_start_block');
  if ((floor != null && floor > frontier) || frontier > nodeHead) {
    throw sourceGap('canonical capture coverage is inconsistent', 'coverage-inconsistent');
  }
  return Object.freeze({
    floorBlock: floor == null ? null : floor.toString(),
    frontierBlock: frontier.toString(), nodeHead: nodeHead.toString(),
  });
}

function coverageGap(fromBlock, toBlock, coverage) {
  if (coverage.floorBlock == null) return 'journal-empty';
  const floor = BigInt(coverage.floorBlock);
  const frontier = BigInt(coverage.frontierBlock);
  if (toBlock < floor) return 'below-floor';
  if (fromBlock < floor) return 'partial-coverage';
  if (fromBlock > frontier) return 'above-frontier';
  if (toBlock > frontier) return 'partial-coverage';
  return null;
}

function safeHeadFrom(row, confirmations) {
  if (!row || row.checkpoint_block == null || row.node_head == null) {
    throw sourceGap('canonical capture frontier is unavailable');
  }
  const checkpoint = BigInt(row.checkpoint_block);
  const nodeHead = BigInt(row.node_head);
  const confirmed = nodeHead >= BigInt(confirmations)
    ? nodeHead - BigInt(confirmations) : 0n;
  return checkpoint < confirmed ? checkpoint : confirmed;
}

function decodeRows(rows, context, allowed, captureAllTransfers) {
  const transfers = [];
  let ignoredMalformedLogs = 0;
  for (const row of rows) {
    try {
      const transfer = decodeTransferLog(logFromRow(row), context);
      if (captureAllTransfers || allowed.has(transfer.tokenAddress)) transfers.push(transfer);
    } catch (error) {
      const tokenAddress = String(row.address || '').toLowerCase();
      if (error.code !== 'holder_transfer_invalid_log' || allowed.has(tokenAddress)) throw error;
      ignoredMalformedLogs += 1;
    }
  }
  const identities = new Set(transfers.map(({ transactionHash, logIndex }) => (
    `${transactionHash}:${logIndex}`
  )));
  if (identities.size !== transfers.length) throw sourceGap('canonical holder range has duplicates');
  return { transfers: Object.freeze(transfers), ignoredMalformedLogs };
}

function createRobinhoodCanonicalHolderSource(options = {}) {
  const database = options.database || db;
  const statementTimeoutMs = Number(options.statementTimeoutMs || 0);
  if (!Number.isSafeInteger(statementTimeoutMs)
      || statementTimeoutMs < 0 || statementTimeoutMs > 60_000) {
    throw new Error('statementTimeoutMs must be between 0 and 60000');
  }

  async function readFrontier(client = database) {
    const result = await client.query(
      `SELECT cursor.checkpoint_block, cursor.node_head,
              (SELECT block_number FROM robinhood_chain_blocks
                WHERE chain=$1 AND canonical=TRUE ORDER BY block_number LIMIT 1) AS journal_start_block
         FROM robinhood_chain_capture_cursor cursor WHERE cursor.chain=$1`,
      [CHAIN]
    );
    if (!result.rowCount) throw sourceGap('canonical capture cursor is missing');
    return result.rows[0];
  }

  async function assertChain() {
    await readFrontier();
    return '4663';
  }

  async function getSafeHead(confirmations = 12) {
    const parsed = Number(confirmations);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100_000) {
      throw new Error('confirmations must be between 0 and 100000');
    }
    const row = await readFrontier();
    return Object.freeze({
      head: String(row.node_head), safeHead: safeHeadFrom(row, parsed).toString(),
      confirmations: parsed,
    });
  }

  async function getCoverage() {
    return coverageFrom(await readFrontier());
  }

  async function matchesCheckpoint(checkpoint = {}) {
    const number = quantity(checkpoint.number, 'checkpoint.number').toString();
    const hash = String(checkpoint.hash || '').toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('checkpoint.hash is invalid');
    const result = await database.query(
      `SELECT EXISTS (
         SELECT 1 FROM robinhood_chain_blocks
          WHERE chain=$1 AND block_number=$2::bigint AND block_hash=$3 AND canonical=TRUE
       ) AS matches`,
      [CHAIN, number, hash]
    );
    return result.rows[0]?.matches === true;
  }

  async function readCanonicalRange(input, maximum, label, tokenAddress = null) {
    const { fromBlock, toBlock } = boundedRange(input, maximum, label);
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if (statementTimeoutMs > 0) {
        await client.query("SELECT set_config('statement_timeout', $1, TRUE)", [
          `${statementTimeoutMs}ms`,
        ]);
      }
      const frontier = await readFrontier(client);
      const coverage = coverageFrom(frontier);
      const gapReason = coverageGap(fromBlock, toBlock, coverage);
      if (gapReason) {
        throw sourceGap(
          `canonical journal does not cover holder range ${fromBlock}-${toBlock}`,
          gapReason, coverage
        );
      }
      const checkpointResult = await client.query(
        `SELECT block_hash FROM robinhood_chain_blocks
          WHERE chain=$1 AND block_number=$2::bigint AND canonical=TRUE`,
        [CHAIN, toBlock.toString()]
      );
      if (!checkpointResult.rowCount) {
        throw sourceGap(
          `canonical holder checkpoint ${toBlock} is missing`, 'checkpoint-missing', coverage
        );
      }
      const events = await client.query(
        `SELECT event.block_number, event.block_hash, event.transaction_hash,
                event.transaction_index, event.log_index, event.address,
                event.topics, event.data
           FROM robinhood_chain_events event
           JOIN robinhood_chain_blocks block
             ON block.chain=event.chain AND block.block_hash=event.block_hash
            AND block.canonical=TRUE
          WHERE event.chain=$1 AND event.block_number BETWEEN $2::bigint AND $3::bigint
            AND event.topic0=$4${tokenAddress ? ' AND event.address=$5' : ''}
          ORDER BY event.block_number, event.transaction_index, event.log_index`,
        [CHAIN, fromBlock.toString(), toBlock.toString(), TRANSFER_TOPIC,
          ...(tokenAddress ? [tokenAddress] : [])]
      );
      await client.query('ROLLBACK');
      return {
        fromBlock, toBlock, rows: events.rows,
        checkpoint: Object.freeze({
          number: toBlock.toString(), hash: checkpointResult.rows[0].block_hash,
        }),
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function readTokenRange(input, maximum, label, telemetry = {}) {
    const tokenAddress = address(input.tokenAddress, 'tokenAddress');
    const range = await readCanonicalRange(input, maximum, label, tokenAddress);
    const decoded = decodeRows(range.rows, {
      tokenAddress, fromBlock: range.fromBlock, toBlock: range.toBlock,
      checkpointHash: range.checkpoint.hash,
    }, new Set([tokenAddress]), false);
    return Object.freeze({
      tokenAddress, fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString(),
      nextBlock: (range.toBlock + 1n).toString(), checkpoint: range.checkpoint,
      transfers: decoded.transfers,
      telemetry: Object.freeze({
        requests: 0, observedLogs: range.rows.length, ignoredLogs: 0,
        source: 'canonical-journal', ...telemetry,
      }),
    });
  }

  async function readRange(input = {}) {
    return readTokenRange(input, MAX_RANGE_BLOCKS, 'holder replay');
  }

  async function readGlobalRange(input = {}) {
    if (!Array.isArray(input.tokenAddresses)) throw new TypeError('tokenAddresses must be an array');
    const allowed = new Set(input.tokenAddresses.map((value) => address(value, 'tokenAddress')));
    const captureAllTransfers = input.captureAllTransfers === true;
    const range = await readCanonicalRange(input, MAX_RANGE_BLOCKS, 'holder live');
    const context = {
      tokenAddress: null, fromBlock: range.fromBlock, toBlock: range.toBlock,
      checkpointHash: range.checkpoint.hash,
    };
    const decoded = decodeRows(range.rows, context, allowed, captureAllTransfers);
    const trackedTransfers = decoded.transfers.filter(
      ({ tokenAddress }) => allowed.has(tokenAddress)
    ).length;
    return Object.freeze({
      fromBlock: range.fromBlock.toString(), toBlock: range.toBlock.toString(),
      nextBlock: (range.toBlock + 1n).toString(), scopeTokens: allowed.size,
      checkpoint: range.checkpoint, transfers: decoded.transfers,
      telemetry: Object.freeze({
        requests: 0, splits: 0, addressSplits: 0,
        filterMode: captureAllTransfers ? 'canonical-journal-buffered' : 'canonical-journal',
        observedLogs: range.rows.length,
        ignoredLogs: range.rows.length - decoded.transfers.length,
        rawTransfersObserved: range.rows.length,
        trackedTransfers,
        legacyExtraTransfers: decoded.transfers.length - trackedTransfers,
        scopeTokens: allowed.size,
        ...(captureAllTransfers ? { ignoredMalformedLogs: decoded.ignoredMalformedLogs,
          bufferedTokenAddresses: new Set(decoded.transfers
            .map(({ tokenAddress }) => tokenAddress)
            .filter((tokenAddress) => !allowed.has(tokenAddress))).size } : {}),
      }),
    });
  }

  async function readReceiptRange(input = {}) {
    const { fromBlock, toBlock } = boundedRange(
      input, MAX_RECEIPT_RANGE_BLOCKS, 'holder receipt'
    );
    return readTokenRange(input, MAX_RECEIPT_RANGE_BLOCKS, 'holder receipt', {
      receiptBlocks: Number(toBlock - fromBlock + 1n), receipts: 0,
    });
  }

  return Object.freeze({
    assertChain, getCoverage, getSafeHead, matchesCheckpoint,
    readGlobalRange, readRange, readReceiptRange,
  });
}

module.exports = {
  createRobinhoodCanonicalHolderSource,
  __private: { coverageFrom, coverageGap, decodeRows, logFromRow, safeHeadFrom },
};
