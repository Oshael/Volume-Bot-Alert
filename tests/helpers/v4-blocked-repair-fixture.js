const v4 = require('../../src/services/uniswap-v4-decoder');
const { digest } = require('../../src/utils/preview-robinhood-v4-blocked');
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const HASH = `0x${'a'.repeat(64)}`; const ID = `0x${'b'.repeat(64)}`;
const AMOUNT = '90071992547409931234';
function fixture() {
  const target = { pool_id: ID, market_key: `robinhood:uniswap-v4:${ID}`, discovery_block: '10',
    blocked_block: '12', log_index: '3', transaction_hash: `0x${word(12)}`, block_hash: HASH,
    tick_spacing: 60, origin_address: v4.ROBINHOOD_V4_POOL_MANAGER };
  const logs = [10, 12].map((n, i) => ({ address: target.origin_address, blockNumber: String(n),
    blockHash: HASH, transactionHash: `0x${word(n)}`, logIndex: i ? '3' : '1', blockTimestamp: '16',
    topics: [v4.TOPICS.modifyLiquidity, ID, `0x${word(1)}`],
    data: `0x${word(-60)}${word(60)}${word(i ? -BigInt(AMOUNT) : AMOUNT)}${word(0)}` }));
  const item = { target, nextBlock: '13', events: logs.map((log) => v4.decodeModifyLiquidity(log,
    { tracked: true, poolId: ID, marketKey: target.market_key, tickSpacing: 60, poolManagerAddress: target.origin_address })) };
  const state = { version: 1, mode: 'read-only', throughBlock: '12', pools: [item] };
  const checkpoint = { ...state, checksum: digest(state) };
  const report = { mode: 'read-only', throughBlock: '12', checkpointChecksum: checkpoint.checksum,
    completed: true, pools: [{ marketKey: target.market_key, conflicts: 0, negativePrefixes: 0, processedWithoutDelta: 0 }] };
  return { item, logs, checkpoint, report };
}
module.exports = { fixture, AMOUNT };
