require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');
const onboarding = require('./backfill-robinhood-onboarding');
const reconstruction = require('./reconstruct-robinhood-v3-archive').__private;
const captureRepair = require('./repair-robinhood-v3-pruned-captures');
const aggregates = require('./backfill-robinhood-market-aggregates').__private;
const minutes = require('../services/robinhood-stock-minute-replay');
const scope = require('../services/robinhood-archive-replay-scope');
const LOCK_KEY = 'robinhood:stock-history-backfill';
const PHASES = ['discovery', 'captures', 'minutes', 'aggregates', 'complete'];

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const allowed = new Set(['mode', 'rpc-url', 'from-block', 'to-block', 'range-size',
    'batch-size', 'rpc-concurrency', 'rpc-batch-size', 'enrichment-concurrency',
    'sleep-ms', 'max-minutes', 'checkpoint-dir', 'maintenance-paused']);
  const args = {};
  const textArgs = new Set(['mode', 'rpc-url', 'checkpoint-dir', 'maintenance-paused']);
  for (const argument of argv) {
    const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match || !allowed.has(match[1]) || args[match[1]] != null) throw new Error(`Invalid argument: ${argument}`);
    args[match[1]] = match[2] ?? 'true';
    if (!textArgs.has(match[1]) && !/^\d+$/.test(args[match[1]])) throw new Error(`Invalid numeric argument: ${argument}`);
  }
  if (!args['checkpoint-dir'] || args['checkpoint-dir'] === 'true') throw new Error('--checkpoint-dir is required');
  if (args['maintenance-paused'] != null && args['maintenance-paused'] !== 'true') {
    throw new Error('--maintenance-paused must declare paused maintenance');
  }
  const replayArgs = { ...args, target: 'stock-quote', 'from-block': args['from-block'] || '0',
    'max-ranges': args['max-minutes'] || '0' };
  for (const key of ['checkpoint-dir', 'maintenance-paused', 'max-minutes']) delete replayArgs[key];
  const options = reconstruction.parseArgs(Object.entries(replayArgs).map(([key, value]) => `--${key}=${value}`), env);
  if (!options.rpcUrl) throw new Error('ROBINHOOD_ARCHIVE_RPC_URL is required');
  return { ...options, maintenancePaused: args['maintenance-paused'] === 'true',
    directory: path.join(path.resolve(args['checkpoint-dir']), options.mode) };
}

async function releaseCampaignLock(client, locked) {
  let discard = false;
  try {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
  } catch (error) { discard = true; throw error; }
  finally { client.release(discard); }
}

async function withCampaignLock(database, callback) {
  const client = await database.getClient();
  let locked = false;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK_KEY]);
    locked = result.rows[0]?.locked === true;
    if (!locked) throw new Error('Another Stock history campaign is running');
    return await callback();
  } finally {
    await releaseCampaignLock(client, locked);
  }
}

async function catalog(context) {
  const pools = scope.poolIndex(await context.repository.listPools(), 'stock-quote', context.options.toBlock);
  return { poolDigest: scope.poolDigest(pools),
    tokens: [...new Set([...pools.values()].map((pool) => pool.token_address))].sort() };
}

async function assertCatalog(context, state) {
  if (state.phase === 'discovery') return;
  const current = await catalog(context);
  if (state.poolDigest !== current.poolDigest || JSON.stringify(state.tokens) !== JSON.stringify(current.tokens)) {
    throw new Error('Stock history campaign catalog changed');
  }
}

function assertCursor(saved) {
  if (!PHASES.includes(saved.phase) || !Number.isSafeInteger(saved.tokenIndex) || saved.tokenIndex < 0
      || saved.tokenIndex > (saved.tokens || []).length) throw new Error('Stock history checkpoint cursor is invalid');
  if (saved.phase === 'complete' && saved.tokenIndex !== saved.tokens.length) {
    throw new Error('Stock history checkpoint skipped aggregate tokens');
  }
  if (['aggregates', 'complete'].includes(saved.phase) && !(Date.parse(saved.aggregateTo) >= Date.parse(saved.cutoff)
      && Date.parse(saved.aggregateTo) <= Date.parse(saved.cutoff) + 24 * 60 * 60_000)) {
    throw new Error('Stock history checkpoint aggregate cutoff is invalid');
  }
}

async function loadState(context, deps) {
  const { options, database, rpcClient, checkpoint } = context;
  const clock = minutes.__private.blockClock(rpcClient);
  const from = BigInt(options.fromBlock);
  const end = BigInt(options.toBlock);
  const cutoff = await clock(end) / 60n * 60n;
  const start = await clock(from) / 60n * 60n;
  if (start >= cutoff) throw new Error('Stock history interval must contain a complete minute');
  if (from > 0n && await clock(from - 1n) / 60n * 60n === start) {
    throw new Error('Stock history must start at the first block of a minute');
  }
  const identity = await database.query('SELECT current_database() AS name, inet_server_addr()::text AS host, inet_server_port() AS port');
  const expected = { version: 1, mode: options.mode, fromBlock: options.fromBlock, toBlock: options.toBlock,
    databaseKey: JSON.stringify(identity.rows[0]), anchorHash: await scope.anchorHash(rpcClient, options.toBlock),
    fromTimestamp: new Date(Number(start) * 1000).toISOString(), cutoff: new Date(Number(cutoff) * 1000).toISOString(),
    closedToBlock: (await minutes.__private.firstBlockAt(clock, from, end, cutoff) - 1n).toString() };
  const saved = await checkpoint.load();
  if (saved) {
    for (const [key, value] of Object.entries(expected)) {
      if (saved[key] !== value) throw new Error(`Stock history checkpoint ${key} changed`);
    }
    assertCursor(saved);
    await assertCatalog(context, saved);
    return saved;
  }
  const files = await (deps.listCheckpoints || (() => fs.readdir(options.directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })))();
  if (files.length) throw new Error('Stock history directory has orphan checkpoints; restore its campaign.json');
  return { ...expected, phase: 'discovery', tokenIndex: 0 };
}

async function discoveryStep(context) {
  const { options } = context;
  const result = await onboarding.backfillStockPairs({
    ...onboarding.parseArgs(['--range-size=10000', '--stock-rpc-concurrency=2'], {}),
    fromBlock: '0', toBlock: options.toBlock, rpcUrl: options.rpcUrl,
    confirm: options.mode === 'write', stockCheckpointFile: path.join(options.directory, 'discovery.json'),
  }, context);
  return { done: true, result, patch: await catalog(context) };
}

async function capturesStep(context) {
  const { options, state } = context;
  const result = await captureRepair.runRepair({
    ...captureRepair.__private.parseArgs(['--target=stock-quote', `--mode=${options.mode}`, '--max-batches=0'], {}),
    rpcUrl: options.rpcUrl, fromBlock: options.fromBlock, toBlock: state.closedToBlock,
  }, context);
  if (options.mode === 'write' && (!result.complete || result.blocked)) throw new Error('Stock capture repair is incomplete');
  return { done: true, result };
}

async function minutesStep(context) {
  const result = await minutes.runStockMinuteReplay({ ...context.options,
    checkpointFile: path.join(context.options.directory, 'minutes.json') }, {
    database: context.database, rpcClient: context.rpcClient,
    repository: context.repository, logger: context.logger,
  });
  return { done: result.complete, paused: !result.complete, result };
}

async function aggregatesStep(context) {
  const { options, state } = context;
  const token = state.tokens[state.tokenIndex];
  if (!token) return { done: true };
  const result = await aggregates.runBackfill({ ...aggregates.parseCliArgs([]),
    mode: options.mode, from: new Date(state.fromTimestamp), to: new Date(state.aggregateTo),
    tokenAddress: token, tokenLimit: 1, maxChunks: 1000,
    checkpointFile: path.join(options.directory, `aggregate-${token}.json`),
  }, { database: context.database,
    readCheckpoint: async (file) => {
      const saved = await reconstruction.createCheckpointStore(file).load();
      if (saved && saved.asOf !== state.aggregateTo) throw new Error('Aggregate checkpoint cutoff changed');
      return saved;
    },
  });
  if (result.failed) throw new Error('Stock aggregate rebuild failed');
  const tokenIndex = state.tokenIndex + (result.paused ? 0 : 1);
  return { done: tokenIndex === state.tokens.length, result: { token, ...result }, patch: { tokenIndex } };
}

async function runCampaign(options, deps = {}) {
  if (options.mode === 'write' && !options.maintenancePaused) throw new Error('Write requires --maintenance-paused');
  const database = deps.database || db;
  const rpcClient = deps.rpcClient || captureRepair.__private.createArchiveClient(options.rpcUrl);
  const context = { options, database, rpcClient, logger: deps.logger || console,
    repository: deps.repository || reconstruction.createRepository(database, 'stock-quote'),
    checkpoint: deps.checkpoint || reconstruction.createCheckpointStore(path.join(options.directory, 'campaign.json')) };
  const steps = deps.steps || { discovery: discoveryStep, captures: capturesStep, minutes: minutesStep, aggregates: aggregatesStep };
  return (deps.withLock || withCampaignLock)(database, async () => {
    if (BigInt(await rpcClient.request('eth_chainId')) !== 4663n) throw new Error('Archive RPC is not on Robinhood Chain');
    let state = await loadState(context, deps);
    await context.checkpoint.save(state);
    while (state.phase !== 'complete') {
      context.state = state;
      await scope.assertAnchor('stock-quote', rpcClient, state);
      const outcome = await steps[state.phase](context);
      await scope.assertAnchor('stock-quote', rpcClient, state);
      state = { ...state, ...outcome.patch, lastResult: outcome.result,
        phase: outcome.done ? PHASES[PHASES.indexOf(state.phase) + 1] : state.phase };
      if (state.phase === 'aggregates' && !state.aggregateTo) {
        state.aggregateTo = new Date(Math.min(Math.floor((deps.now || Date.now)() / 60_000) * 60_000,
          Date.parse(state.cutoff) + 24 * 60 * 60_000)).toISOString();
      }
      if (outcome.done) await assertCatalog(context, state);
      await context.checkpoint.save(state);
      context.logger.log(JSON.stringify({ event: 'stock_history_campaign_progress', phase: state.phase,
        tokenIndex: state.tokenIndex, tokenCount: state.tokens?.length, lastResult: state.lastResult }));
      if (outcome.paused) return { ...state, complete: false, paused: true };
    }
    return { ...state, complete: true };
  });
}

async function main() {
  try {
    const { tokens, ...result } = await runCampaign(parseArgs());
    console.log(JSON.stringify({ ...result, tokenCount: tokens?.length }, null, 2));
  }
  catch (error) { console.error('[RobinhoodStockHistory]', error.message); process.exitCode = 1; }
  finally { await db.pool.end().catch(() => {}); }
}
if (require.main === module) void main();
module.exports = { parseArgs, runCampaign, __private: { LOCK_KEY, withCampaignLock } };
