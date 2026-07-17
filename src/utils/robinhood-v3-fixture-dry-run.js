const fixture = require('../../data/fixtures/robinhood-uniswap-v3.json');
const { createUniswapV3Tracker } = require('../services/uniswap-v3-decoder');

function runFixtureDryRun() {
  const tracker = createUniswapV3Tracker();
  const discovery = tracker.processLog(fixture.poolCreated);
  const initialize = tracker.processLog(fixture.initialize);
  const swap = tracker.processLog(fixture.swap);
  return {
    mode: 'fixture-read-only',
    source: fixture.source,
    poolCodeBytesObserved: fixture.expected.codeBytes,
    discovery,
    initialize,
    swap,
    summary: {
      trackedPools: tracker.getTrackedPools().length,
      swapsAccepted: swap.accepted ? 1 : 0,
      buys: swap.side === 'buy' ? 1 : 0,
      sells: swap.side === 'sell' ? 1 : 0,
      quoteVolumeRaw: swap.quoteAmountRaw || '0',
    },
  };
}

if (require.main === module) console.log(JSON.stringify(runFixtureDryRun(), null, 2));

module.exports = { runFixtureDryRun };
