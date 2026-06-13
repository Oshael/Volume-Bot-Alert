const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/gmgn-claim-signal-worker');

const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

describe('gmgn claim signal worker', () => {
  beforeEach(() => {
    worker.__private.resetStatus();
  });

  it('polls Pump and Bags claim signals and summarizes persistence decisions', async () => {
    const signalTypeCalls = [];
    const persistedSignals = [];
    const result = await worker.runOnce({
      enabled: true,
      chain: 'sol',
      signalTypes: [17, 18],
      client: {
        fetchMarketSignal: async (request) => {
          signalTypeCalls.push(request.signalType);
          return request.signalType === 17
            ? [{ tokenAddress: TOKEN_A, signalType: 17, claimId: 'bags-1' }]
            : [
                { tokenAddress: TOKEN_A, signalType: 18, claimId: 'pump-1' },
                { tokenAddress: TOKEN_B, signalType: 18, claimId: 'pump-2' },
              ];
        },
      },
      alertService: {
        recordClaimSignal: async (signal) => {
          persistedSignals.push(signal);
          if (signal.claimId === 'pump-2') {
            return { action: 'suppressed' };
          }
          if (signal.claimId === 'pump-1') {
            return { action: 'deduped' };
          }
          return { action: 'triggered' };
        },
      },
    });

    assert.deepEqual(signalTypeCalls, [17, 18]);
    assert.equal(persistedSignals.length, 3);
    assert.equal(result.skipped, false);
    assert.deepEqual(result.summary, {
      requests: 2,
      signals: 3,
      triggered: 1,
      deduped: 1,
      suppressed: 1,
    });
  });
});
