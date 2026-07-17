const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildTransactionSubscribeParams,
  estimateQuickNodeCredits,
  formatTrafficStats,
  resolveProgram,
} = require('../src/utils/quicknode-transaction-probe');

describe('quicknode transaction probe', () => {
  it('resolves official Raydium program aliases', () => {
    assert.deepEqual(resolveProgram('raydium-cpmm'), {
      label: 'raydium-cpmm',
      address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    });
    assert.deepEqual(resolveProgram('raydium-amm-v4'), {
      label: 'raydium-amm-v4',
      address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    });
    assert.deepEqual(resolveProgram('raydium-clmm'), {
      label: 'raydium-clmm',
      address: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    });
  });

  it('builds transactionSubscribe account filters for required and excluded accounts', () => {
    const [filter] = buildTransactionSubscribeParams('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', {
      exclude: ['blockedAccount111111111111111111111111111111'],
      required: ['So11111111111111111111111111111111111111112'],
    });

    assert.deepEqual(filter.accounts, {
      include: ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'],
      exclude: ['blockedAccount111111111111111111111111111111'],
      required: ['So11111111111111111111111111111111111111112'],
    });
  });

  it('estimates QuickNode metered WebSocket credits from received bytes', () => {
    assert.equal(estimateQuickNodeCredits(0), 0);
    assert.equal(estimateQuickNodeCredits(100000), 15);
    assert.equal(estimateQuickNodeCredits(250000), 37.5);
  });

  it('formats traffic stats with useful and noisy byte buckets', () => {
    assert.equal(formatTrafficStats({
      messages: 10,
      receivedBytes: 250000,
      notificationBytes: 240000,
      mentionOnlyBytes: 180000,
      matchBytes: 60000,
    }), 'messages=10 receivedBytes=250000 estimatedCredits=37.5 notificationBytes=240000 mentionOnlyBytes=180000 matchBytes=60000');
  });
});
