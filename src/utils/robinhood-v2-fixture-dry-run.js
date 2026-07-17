const fixture = require('../../data/fixtures/robinhood-uniswap-v2.json');
const { createUniswapV2Tracker } = require('../services/uniswap-v2-decoder');

function runFixtureDryRun() {
  const tracker = createUniswapV2Tracker();
  const discovery = tracker.processLog(fixture.pairCreated);
  const sync = tracker.processLog(fixture.sync);
  const swap = tracker.processLog(fixture.swap);
  return {
    mode: 'fixture-read-only',
    source: fixture.source,
    pairCodeBytesObserved: fixture.expected.codeBytes,
    discovery,
    sync,
    swap,
    summary: {
      trackedPairs: tracker.getTrackedPairs().length,
      swapsAccepted: swap.accepted ? 1 : 0,
      buys: swap.side === 'buy' ? 1 : 0,
      sells: swap.side === 'sell' ? 1 : 0,
      quoteVolumeRaw: swap.quoteAmountRaw || '0',
    },
  };
}

if (require.main === module) {
  console.log(JSON.stringify(runFixtureDryRun(), null, 2));
}

module.exports = { runFixtureDryRun };
