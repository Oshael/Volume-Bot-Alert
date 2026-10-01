'use strict';

const { performance } = require('node:perf_hooks');
const db = require('../models/db');
const {
  createRobinhoodTransactionPositionRepository,
} = require('../models/robinhood-transaction-position');
const {
  createRobinhoodWalletSwapRepository,
} = require('../models/robinhood-wallet-swap-persistence');
const {
  createRobinhoodWalletSwapAttributor,
} = require('./robinhood-wallet-swap-attributor');

const OBSERVATION_COLUMNS = [
  'transaction_hash', 'log_index', 'block_number', 'protocol', 'market_key',
  'token_address', 'quote_address', 'side', 'token_amount_raw', 'quote_amount_raw',
  'token_decimals', 'quote_decimals', 'token_amount', 'quote_amount', 'price_usd',
  'volume_usd', 'fdv_usd', 'token_total_supply_raw',
];

function groupObservations(rows) {
  const groups = [];
  for (const row of rows) {
    const blockNumber = String(row.block_number);
    let group = groups.at(-1);
    if (!group || group[0] !== blockNumber) {
      group = [blockNumber, []];
      groups.push(group);
    }
    group[1].push(row);
  }
  return groups;
}

function timedRepository(repository, method, timing, key, now) {
  return {
    [method]: async (...args) => {
      const startedAt = now();
      try {
        return await repository[method](...args);
      } finally {
        timing[key] += now() - startedAt;
      }
    },
  };
}

function createRobinhoodV3ArchiveWalletAttribution(deps = {}) {
  const now = deps.now || (() => performance.now());
  const database = deps.database || db;
  const rpcClient = deps.rpcClient;
  if (typeof rpcClient?.request !== 'function') throw new Error('archive RPC is required');
  const walletRepository = deps.walletRepository
    || createRobinhoodWalletSwapRepository({ database });
  const transactionPositionRepository = deps.transactionPositionRepository
    || createRobinhoodTransactionPositionRepository({ database });

  async function attribute(captures) {
    if (!captures.length) return { accepted: 0, attributed: 0, inserted: 0, blocks: 0 };
    const expectedHashes = new Map();
    for (const capture of captures) {
      const blockNumber = String(capture.block_number);
      const blockHash = String(capture.block_hash).toLowerCase();
      const prior = expectedHashes.get(blockNumber);
      if (prior && prior !== blockHash) {
        throw new Error(`archive wallet attribution has conflicting hashes at ${blockNumber}`);
      }
      expectedHashes.set(blockNumber, blockHash);
    }
    const requested = captures.map((capture) => ({
      transactionHash: capture.transaction_hash,
      logIndex: String(capture.log_index),
      blockNumber: String(capture.block_number),
    }));
    const queryStartedAt = now();
    const result = await database.query(
      `WITH requested AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           "transactionHash" text, "logIndex" bigint, "blockNumber" bigint
         )
       )
       SELECT ${OBSERVATION_COLUMNS.map((column) => `observation.${column}`).join(', ')}
       FROM requested item
       JOIN robinhood_market_observations observation
         ON observation.chain = 'robinhood'
        AND observation.transaction_hash = item."transactionHash"
        AND observation.log_index = item."logIndex"
        AND observation.block_number = item."blockNumber"
        AND observation.status = 'accepted'
       ORDER BY observation.block_number, observation.log_index`,
      [JSON.stringify(requested)]
    );
    const observationsMs = now() - queryStartedAt;
    const attributionStartedAt = now();
    const timing = { positionsMs: 0, swapsMs: 0 };
    const groups = groupObservations(result.rows);
    const attributor = (deps.attributorFactory || createRobinhoodWalletSwapAttributor)({
      repository: deps.collectTiming
        ? timedRepository(walletRepository, 'insertWalletSwaps', timing, 'swapsMs', now)
        : walletRepository,
      transactionPositionRepository: deps.collectTiming
        ? timedRepository(transactionPositionRepository, 'upsertPositions', timing, 'positionsMs', now)
        : transactionPositionRepository,
      fetchConcurrency: deps.fetchConcurrency,
      fetchBlock: async (blockNumber) => {
        const block = await rpcClient.request('eth_getBlockByNumber', [
          `0x${BigInt(blockNumber).toString(16)}`, true,
        ]);
        if (String(block?.hash || '').toLowerCase() !== expectedHashes.get(String(blockNumber))) {
          throw new Error(`archive block hash differs from repaired capture at ${blockNumber}`);
        }
        return block;
      },
    });
    const attributed = await attributor.attributeGroups(groups);
    const attributionMs = now() - attributionStartedAt;
    if (attributed.unresolved || attributed.missing || attributed.blocks !== groups.length) {
      throw new Error('archive wallet attribution is incomplete');
    }
    return {
      accepted: result.rows.length,
      attributed: attributed.attributed,
      inserted: attributed.inserted,
      blocks: attributed.blocks,
      ...(deps.collectTiming ? { timing: {
        observationsMs: Math.round(observationsMs),
        // Reads run concurrently; use elapsed wall time, not summed RPC times.
        fetchResolveMs: Math.round(attributionMs - timing.positionsMs - timing.swapsMs),
        positionsMs: Math.round(timing.positionsMs),
        swapsMs: Math.round(timing.swapsMs),
      } } : {}),
    };
  }

  return Object.freeze({ attribute });
}

module.exports = {
  createRobinhoodV3ArchiveWalletAttribution,
  __private: { groupObservations },
};
