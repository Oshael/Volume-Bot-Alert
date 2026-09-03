const assert = require('node:assert/strict');
const { it } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const v4 = require('../src/services/uniswap-v4-decoder');
const { runPreview, parseArgs, fetchRange, matchesLedger } = require('../src/utils/preview-robinhood-v4-blocked');
const HASH = `0x${'a'.repeat(64)}`;
const ID = `0x${'b'.repeat(64)}`;
const address = `0x${'1'.repeat(40)}`;
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const target = { pool_id: ID, market_key: `robinhood:uniswap-v4:${ID}`, discovery_block: '10',
  blocked_block: '12', log_index: '3', transaction_hash: `0x${word(12)}`, block_hash: HASH,
  tick_spacing: 60, origin_address: v4.ROBINHOOD_V4_POOL_MANAGER };
function log(block, index, delta) {
  return { address: target.origin_address, blockNumber: String(block), blockHash: HASH,
    transactionHash: `0x${word(block)}`, logIndex: String(index),
    topics: [v4.TOPICS.modifyLiquidity, ID, `0x${word(address)}`],
    data: `0x${word(-60)}${word(60)}${word(delta)}${word(0)}` };
}
function fixture() {
  const logs = [log(10, 1, 9), log(12, 3, -9), log(12, 4, 5)];
  const scans = [];
  const rpc = { async request(method, params) {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') return { number: params[0], hash: HASH, timestamp: '0x10' };
    const filter = params[0];
    assert.equal(filter.address, target.origin_address);
    assert.equal(filter.topics[1], ID);
    if (filter.topics[0] === v4.TOPICS.initialize) return [{ ...log(10, 0, 0),
      topics: [v4.TOPICS.initialize, ID, `0x${word(0)}`, `0x${word(address)}`],
      data: `0x${word(3000)}${word(60)}${word(0)}${word(1n << 96n)}${word(0)}` }];
    scans.push(filter.fromBlock);
    return logs.filter((row) => BigInt(row.blockNumber) >= BigInt(filter.fromBlock)
      && BigInt(row.blockNumber) <= BigInt(filter.toBlock));
  } };
  return { rpc, scans, repository: { targets: async () => [target], ranges: async () => [],
    identities: async (events) => new Map(events.map((e) => [`${e.transactionHash}:${e.logIndex}`,
      { ledger: null, processed: false, capture_status: e.logIndex === '3' ? 'blocked' : null }])) } };
}
it('saves each bounded range and resumes without rescanning; excludes logs after the blocker', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-preview-'));
  try {
    const deps = fixture();
    const options = { outputDir, throughBlock: '12', rangeSize: 2 };
    let interrupted = false;
    await assert.rejects(runPreview(options, { ...deps, shouldStop: () => interrupted,
      progress: () => { interrupted = true; } }), /Interrupted/);
    const saved = JSON.parse(await fs.readFile(path.join(outputDir, 'checkpoint.json')));
    assert.equal(saved.pools[0].nextBlock, '12');
    assert.equal(saved.pools[0].events.length, 1);
    const report = await runPreview(options, { ...deps, progress: () => {} });
    assert.deepEqual(deps.scans, ['0xa', '0xc']);
    assert.equal(report.pools[0].archiveEvents, 2);
    assert.equal(report.pools[0].missingPredecessors, 1);
    assert.equal(report.pools[0].negativePrefixes, 0);
    assert.equal(report.pools[0].archiveBalancesThroughBlocker['-60:60'], '0');
    assert.equal(JSON.parse(await fs.readFile(path.join(outputDir, 'report.json'))).completed, true);
    await runPreview(options, { ...deps, progress: () => {} });
    assert.equal(deps.scans.length, 2);
    await assert.rejects(runPreview({ ...options, throughBlock: '13' }, deps), /Checkpoint mismatch/);
    const rpc = { request: async (method, params) => method === 'eth_getBlockByNumber'
      ? { number: params[0], hash: ID } : deps.rpc.request(method, params) };
    await assert.rejects(runPreview(options, { ...deps, rpc }), /Canonical block mismatch/);
    saved.pools[0].nextBlock = '13';
    await fs.writeFile(path.join(outputDir, 'checkpoint.json'), JSON.stringify(saved));
    await assert.rejects(runPreview(options, deps), /Checkpoint mismatch/);
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});
it('rejects writes, invalid ranges, removed logs and conflicting duplicates', async () => {
  const env = { ROBINHOOD_V4_REPLAY_RPC_URL: 'http://localhost:8547' };
  assert.throws(() => parseArgs(['--mode=write'], env), /Unsupported/);
  assert.throws(() => parseArgs(['--range-size=10001'], env), /range-size/);
  assert.equal(parseArgs(['--through-block=12', '--output-dir=/tmp/v4-preview'], env).rangeSize, 10000);
  for (const logs of [[{ ...log(10, 1, 9), removed: true }], [log(9, 1, 9)],
    [log(10, 1, 9), log(10, 1, 8)]]) {
    const rpc = { request: async (method) => method === 'eth_getLogs' ? logs
      : { number: '10', hash: HASH, timestamp: '0x10' } };
    await assert.rejects(fetchRange(rpc, target, 10n, 2), /Removed|out-of-range|Conflicting/);
  }
});
it('compares exact delta payloads, not merely transaction identities', () => {
  const event = v4.decodeModifyLiquidity({ ...log(10, 1, 90071992547409931234n), blockTimestamp: '0x10' },
    { tracked: true, poolId: ID, marketKey: target.market_key, tickSpacing: 60,
      poolManagerAddress: target.origin_address });
  const row = { block_number: '10', block_hash: HASH, pool_id: ID, market_key: target.market_key,
    sender: address, tick_lower: -60, tick_upper: 60, liquidity_delta: '90071992547409931234',
    salt: `0x${word(0)}`, observed_at: '1970-01-01T00:00:16Z' };
  assert.equal(matchesLedger(event, row), true);
  for (const changed of [{ liquidity_delta: '90071992547409931235' }, { block_hash: ID },
    { observed_at: '1970-01-01T00:00:17Z' }, { tick_upper: 120 }]) {
    assert.equal(matchesLedger(event, { ...row, ...changed }), false);
  }
});
it('shrinks RPC timeouts without skipping ranges and refuses a larger target cohort', async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'v4-preview-'));
  try {
    const deps = fixture();
    const request = deps.rpc.request;
    let timeouts = 0;
    deps.rpc.request = async (method, params) => {
      if (method === 'eth_getLogs' && params[0].topics[0] === v4.TOPICS.modifyLiquidity
        && BigInt(params[0].toBlock) > BigInt(params[0].fromBlock)) {
        timeouts += 1;
        throw Object.assign(new Error('timeout'), { code: 'timeout' });
      }
      return request(method, params);
    };
    const options = { outputDir, throughBlock: '12', rangeSize: 2 };
    await assert.rejects(runPreview(options, { ...deps,
      repository: { targets: async () => Array(8).fill(target) } }), /More than 7/);
    const result = await runPreview(options, { ...deps, progress: () => {} });
    assert.equal(timeouts, 1);
    assert.deepEqual(deps.scans, ['0xa', '0xb', '0xc']);
    assert.equal(result.pools[0].archiveEvents, 2);
  } finally { await fs.rm(outputDir, { recursive: true, force: true }); }
});
