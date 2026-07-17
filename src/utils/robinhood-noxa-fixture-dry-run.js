const noxaFixture = require('../../data/fixtures/robinhood-noxa-launch.json');
const v3Fixture = require('../../data/fixtures/robinhood-uniswap-v3.json');
const { decodePoolCreated } = require('../services/uniswap-v3-decoder');
const {
  decodeAddressResult,
  decodeLaunchedTokenResult,
  decodeTokenLaunched,
  validateLaunch,
} = require('../services/noxa-launch-decoder');

function runFixtureDryRun() {
  const launch = decodeTokenLaunched(noxaFixture.tokenLaunched);
  const validation = validateLaunch(launch, {
    v3Pool: decodePoolCreated(v3Fixture.poolCreated),
    launchedToken: decodeLaunchedTokenResult(noxaFixture.getLaunchedTokenResult),
    canonicalPoolAddress: decodeAddressResult(noxaFixture.getPoolResult),
    tokenCodeBytes: noxaFixture.tokenCodeBytes,
    poolCodeBytes: noxaFixture.poolCodeBytes,
  });
  return {
    mode: 'fixture-read-only',
    source: noxaFixture.source,
    validation,
    summary: {
      launchesSeen: 1,
      launchesAccepted: validation.accepted ? 1 : 0,
      newMarkets: validation.isNewMarket ? 1 : 0,
      deduplicatedV3Pools: validation.deduplicatedWith === 'uniswap-v3' ? 1 : 0,
    },
  };
}

if (require.main === module) console.log(JSON.stringify(runFixtureDryRun(), null, 2));

module.exports = { runFixtureDryRun };
