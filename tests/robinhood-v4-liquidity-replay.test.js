const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage100 = require('../src/utils/db-init-stage100');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  createRobinhoodV4LiquidityReplayRepository,
} = require('../src/models/robinhood-v4-liquidity-replay');
const {
  createRobinhoodV4LiquidityReplay,
} = require('../src/services/robinhood-v4-liquidity-replay');
const v4 = require('../src/services/uniswap-v4-decoder');

const HASH = `0x${'a'.repeat(64)}`;
const OTHER_HASH = `0x${'b'.repeat(64)}`;
const POOL_ID = `0x${'3'.repeat(64)}`;
const ADDRESS = `0x${'1'.repeat(40)}`;
const MARKET = `robinhood:uniswap-v4:${POOL_ID}`;
const word = (value) => {
  const number = BigInt(value);
  return (number < 0n ? (1n << 256n) + number : number).toString(16).padStart(64, '0');
};
const log = () => ({
  address: v4.ROBINHOOD_V4_POOL_MANAGER,
  topics: [v4.TOPICS.modifyLiquidity, POOL_ID, `0x${'0'.repeat(24)}${ADDRESS.slice(2)}`],
  data: `0x${word(-120)}${word(120)}${word(500)}${word(9)}`,
  blockNumber: '0x64', blockHash: HASH, transactionHash: OTHER_HASH,
  transactionIndex: '0x0', logIndex: '0x1', blockTimestamp: '0x10', removed: false,
});
const pool = {
  poolId: POOL_ID, marketKey: MARKET, tokenAddress: ADDRESS,
  quoteAddress: `0x${'2'.repeat(40)}`, tickSpacing: 60,
  poolManagerAddress: v4.ROBINHOOD_V4_POOL_MANAGER,
};

describe('Robinhood V4 liquidity replay', () => {
  it('registers the independent resumable cursor in the runtime schema', () => {
    const sql = stage100.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage100-robinhood-v4-liquidity-replay');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_v4_liquidity_replay_state/);
    assert.match(sql, /status = 'completed'/);
    assert.equal(group.repair, 'node src/utils/db-init-stage100.js');
  });

  it('replays only registered pools and commits a contiguous local-RPC range', async () => {
    const commits = [];
    const repository = {
      ensureState: async () => ({
        state: { nextBlock: '100', targetBlock: '100', checkpointBlock: null, status: 'running' },
        pools: [pool],
      }),
      async commitRange(input) {
        commits.push(input);
        return {
          persisted: input.events.length,
          state: { nextBlock: '101', targetBlock: '100', checkpointBlock: '100', status: 'completed' },
        };
      },
    };
    const rpcClient = { async request(method) {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_blockNumber') return '0x66';
      if (method === 'eth_getLogs') return [log()];
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: HASH };
      throw new Error(`unexpected ${method}`);
    } };
    const result = await createRobinhoodV4LiquidityReplay({ repository, rpcClient }).run();
    assert.equal(result.persisted, 1);
    assert.equal(commits[0].events[0].liquidityDelta, '500');
    assert.deepEqual([commits[0].fromBlock, commits[0].toBlock], ['100', '100']);
  });

  it('fails closed when the persisted checkpoint changed', async () => {
    const repository = {
      ensureState: async () => ({
        state: {
          nextBlock: '101', targetBlock: '102', checkpointBlock: '100',
          checkpointHash: HASH, status: 'running',
        },
        pools: [pool],
      }),
      commitRange: async () => { throw new Error('must not commit'); },
    };
    const rpcClient = { async request(method) {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_blockNumber') return '0x66';
      return { number: '0x64', hash: OTHER_HASH };
    } };
    await assert.rejects(
      createRobinhoodV4LiquidityReplay({ repository, rpcClient }).run(),
      /checkpoint no longer matches/
    );
  });

  it('writes deltas and advances the cursor in one transaction', async () => {
    const calls = [];
    const client = { async query(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO robinhood_v4_liquidity_deltas/.test(sql)) return { rowCount: 1, rows: [{}] };
      if (/UPDATE robinhood_v4_liquidity_replay_state/.test(sql)) return {
        rowCount: 1,
        rows: [{ start_block: 100, next_block: 101, target_block: 100,
          checkpoint_block: 100, checkpoint_hash: HASH, status: 'completed', version: 1 }],
      };
      return { rowCount: 0, rows: [] };
    }, release() {} };
    const repository = createRobinhoodV4LiquidityReplayRepository({
      database: { getClient: async () => client },
    });
    const event = v4.createUniswapV4Tracker({ seedPools: [pool] }).processLog(log());
    const result = await repository.commitRange({
      fromBlock: '100', toBlock: '100', checkpointHash: HASH, events: [event],
    });
    assert.equal(result.state.status, 'completed');
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls.at(-1).sql, 'COMMIT');
  });
});
