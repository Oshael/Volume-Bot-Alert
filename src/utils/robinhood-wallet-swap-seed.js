/**
 * Standalone Robinhood wallet-swap seed entrypoint.
 *
 * Runs the historical tx.from attribution against a local node, writing to the
 * production Postgres. Built to run on the node host (WSL) with minimal coupling
 * to the surrounding checkout: it creates its own pg pool and makes raw JSON-RPC
 * calls, so it depends only on the wallet-swap modules, not on the shared db.js
 * or RPC client (which may diverge on the node host).
 *
 * Env:
 *   RH_NODE_RPC_URL      node JSON-RPC (e.g. http://127.0.0.1:8547)
 *   DATABASE_URL         Postgres (VPS2, e.g. via tunnel)
 *   RH_SEED_FROM_BLOCK   optional seed start (default: MIN accepted block)
 *   RH_SEED_TO_BLOCK     optional seed end   (default: MAX accepted block)
 *   RH_SEED_MAX_BLOCKS   blocks per read batch (default 200)
 *   RH_SEED_BATCH_LIMIT  max batches this run (default: run to completion)
 *
 * Run with: node src/utils/robinhood-wallet-swap-seed.js
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { Pool } = require('pg');

const { createRobinhoodWalletSwapSourceReader } = require('../models/robinhood-wallet-swap-source-reader');
const { createRobinhoodWalletSwapRepository } = require('../models/robinhood-wallet-swap-persistence');
const {
  createRobinhoodTransactionPositionRepository,
} = require('../models/robinhood-transaction-position');
const { createRobinhoodWalletSwapCursorRepository } = require('../models/robinhood-wallet-swap-cursor');
const { createRobinhoodWalletSwapAttributor } = require('../services/robinhood-wallet-swap-attributor');
const { runSeed } = require('../services/robinhood-wallet-swap-seed-runner');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function toHex(blockNumber) {
  return `0x${BigInt(blockNumber).toString(16)}`;
}

function rpcCall(url, method, params) {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) reject(new Error(`RPC ${method}: ${parsed.error.message || JSON.stringify(parsed.error)}`));
            else resolve(parsed.result);
          } catch (error) {
            reject(new Error(`RPC ${method} returned a non-JSON response: ${error.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function assertSchema(database) {
  const result = await database.query(
    `SELECT to_regclass('robinhood_wallet_swaps') AS swaps,
            to_regclass('robinhood_wallet_swap_cursors') AS cursors,
            to_regclass('idx_robinhood_market_observations_attribution') AS attribution_index,
            to_regclass('robinhood_transaction_positions') AS transaction_positions`
  );
  const {
    swaps, cursors, attribution_index: attributionIndex,
    transaction_positions: transactionPositions,
  } = result.rows[0];
  const missing = [];
  if (!swaps) missing.push('robinhood_wallet_swaps (run db-init-stage90.js)');
  if (!cursors) missing.push('robinhood_wallet_swap_cursors (run db-init-stage91.js)');
  if (!attributionIndex) missing.push('idx_robinhood_market_observations_attribution (run db-init-stage92.js)');
  if (!transactionPositions) {
    missing.push('robinhood_transaction_positions (run db-init-stage139.js)');
  }
  if (missing.length) throw new Error(`schema not ready:\n  - ${missing.join('\n  - ')}`);
}

async function assertNode(rpcUrl) {
  const head = BigInt(await rpcCall(rpcUrl, 'eth_blockNumber', []));
  const block = await rpcCall(rpcUrl, 'eth_getBlockByNumber', [toHex(head), true]);
  if (!block || !Array.isArray(block.transactions)) {
    throw new Error('node did not return a full block for the head');
  }
  const withObjects = block.transactions.find((tx) => tx && typeof tx === 'object');
  if (block.transactions.length > 0 && (!withObjects || !withObjects.from)) {
    throw new Error('node returned block transactions without a "from" (needs full transactions)');
  }
  return head;
}

async function acceptedBounds(database) {
  const result = await database.query(
    `SELECT MIN(block_number) AS min_block, MAX(block_number) AS max_block
     FROM robinhood_market_observations
     WHERE chain = 'robinhood' AND status = 'accepted'`
  );
  return result.rows[0];
}

async function main() {
  const rpcUrl = requireEnv('RH_NODE_RPC_URL');
  const pool = new Pool({ connectionString: requireEnv('DATABASE_URL') });
  const database = { query: (sql, params) => pool.query(sql, params) };

  try {
    console.log('[seed] preflight: node...');
    const head = await assertNode(rpcUrl);
    console.log(`[seed] node head = ${head}`);
    console.log('[seed] preflight: schema...');
    await assertSchema(database);

    const cursor = createRobinhoodWalletSwapCursorRepository({ database });
    let state = await cursor.loadCursor('seed');
    if (!state) {
      const bounds = await acceptedBounds(database);
      const fromBlock = process.env.RH_SEED_FROM_BLOCK || bounds.min_block;
      const safeHead = process.env.RH_SEED_TO_BLOCK || bounds.max_block;
      if (fromBlock == null || safeHead == null) throw new Error('no accepted observations to seed');
      state = await cursor.initCursor('seed', String(fromBlock), { safeHead: String(safeHead) });
      console.log(`[seed] initialized cursor: next_block=${state.nextBlock} safe_head=${state.safeHead}`);
    } else {
      console.log(`[seed] resuming cursor: next_block=${state.nextBlock} safe_head=${state.safeHead} v${state.version}`);
    }

    const reader = createRobinhoodWalletSwapSourceReader({ database });
    const repository = createRobinhoodWalletSwapRepository({ database });
    const transactionPositionRepository = createRobinhoodTransactionPositionRepository({ database });
    const fetchBlock = (blockNumber) => rpcCall(rpcUrl, 'eth_getBlockByNumber', [toHex(blockNumber), true]);
    const attributor = createRobinhoodWalletSwapAttributor({
      repository, transactionPositionRepository, fetchBlock,
    });

    const maxBlocks = process.env.RH_SEED_MAX_BLOCKS ? Number(process.env.RH_SEED_MAX_BLOCKS) : undefined;
    const maxBatches = process.env.RH_SEED_BATCH_LIMIT ? Number(process.env.RH_SEED_BATCH_LIMIT) : undefined;

    const summary = await runSeed({ reader, attributor, cursor, maxBlocks, maxBatches });
    console.log('[seed] done:', JSON.stringify(summary));
    if (summary.missing > 0 || summary.unresolved > 0) {
      console.warn(`[seed] WARNING: ${summary.unresolved} unresolved / ${summary.missing} missing senders — check node coverage.`);
    }
  } catch (error) {
    console.error('[seed] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { __private: { toHex, rpcCall, assertSchema, assertNode } };
