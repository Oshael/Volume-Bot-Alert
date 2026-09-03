const fs = require('node:fs/promises');
const path = require('node:path');
const { digest, save, header, initialize } = require('./preview-robinhood-v4-blocked');
const { repairPool, validateEvents } = require('../models/robinhood-v4-blocked-repair');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');

function validateCheckpoint(checkpoint, report) {
  const { checksum, ...state } = checkpoint;
  if (checksum !== digest(state) || report.checkpointChecksum !== checksum || !report.completed
    || state.version !== 1 || ![state.mode, report.mode].every((mode) => mode === 'read-only')
    || state.throughBlock !== report.throughBlock || !Array.isArray(state.pools)
    || !state.pools.length || state.pools.length > 7 || report.pools.length !== state.pools.length
    || new Set(state.pools.map((p) => p.target.pool_id)).size !== state.pools.length) {
    throw new Error('Incomplete/incompatible checkpoint and report');
  }
  for (const item of state.pools) {
    validateEvents(item);
    const summary = report.pools.find((p) => p.marketKey === item.target.market_key);
    if (!summary || summary.conflicts !== 0 || summary.negativePrefixes !== 0
      || summary.processedWithoutDelta !== 0 || BigInt(item.target.blocked_block) > BigInt(state.throughBlock)) {
      throw new Error('Unsafe preview report');
    }
  }
  return state;
}
async function runRepair(options, { client, rpc, progress = console.log, shouldStop = () => false }) {
  const lockPath = path.join(options.outputDir, 'preview.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(String(process.pid));
    const read = async (name) => JSON.parse(await fs.readFile(path.join(options.outputDir, name), 'utf8'));
    const state = validateCheckpoint(await read('checkpoint.json'), await read('report.json'));
    if (BigInt(await rpc.request('eth_chainId')) !== 4663n) throw new Error('Wrong archive chain');
    const result = { mode: options.write ? 'write' : 'dry-run', checkpointChecksum: digest(state), pools: [] };
    for (const item of state.pools) {
      if (shouldStop()) throw new Error('Interrupted; completed pools are safe to retry');
      await initialize(rpc, item.target);
      await header(rpc, item.target.blocked_block, item.target.block_hash);
      result.pools.push(await repairPool(client, item, { ...options,
        verifyCanonical: () => header(rpc, item.target.blocked_block, item.target.block_hash) }));
      await save(path.join(options.outputDir, `repair-${result.mode}.json`), result);
      progress(JSON.stringify(result.pools.at(-1)));
    }
    return result;
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
async function main() {
  const args = process.argv.slice(2);
  const output = args.find((arg) => arg.startsWith('--output-dir='));
  if (!output || args.filter((arg) => arg.startsWith('--output-dir=')).length !== 1
    || args.some((arg) => arg !== output && arg !== '--write')) throw new Error('Use --output-dir=<preview directory> [--write]');
  const rpcUrl = process.env.ROBINHOOD_V4_REPLAY_RPC_URL;
  if (!rpcUrl || !/^https?:$/.test(new URL(rpcUrl).protocol)) throw new Error('Archive RPC URL required');
  const db = require('../models/db'); const client = await db.getClient();
  let stopping = false; const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const rpc = createEvmJsonRpcClient({ providers: [{ name: 'v4-repair', url: rpcUrl }], timeoutMs: 60000, maxRetries: 1 });
    await runRepair({ outputDir: path.resolve(output.slice(13)), write: args.includes('--write') },
      { client, rpc, shouldStop: () => stopping });
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    client.release(); await db.pool.end();
  }
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { runRepair, validateCheckpoint };
