const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const noxaFixture = require('../data/fixtures/robinhood-noxa-launch.json');
const v3Fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const { decodeTokenLaunched } = require('../src/services/noxa-launch-decoder');
const { decodePoolCreated } = require('../src/services/uniswap-v3-decoder');
const {
  codeByteLength,
  createNoxaLaunchValidator,
  toBlockTag,
} = require('../src/services/noxa-launch-validator');

describe('NOXA onchain launch validator', () => {
  it('validates factory state and bytecode at the launch block', async () => {
    const calls = [];
    const validator = createNoxaLaunchValidator({
      rpcClient: {
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === 'eth_getCode') {
            return params[0] === noxaFixture.expected.token
              ? `0x${'11'.repeat(noxaFixture.tokenCodeBytes)}`
              : `0x${'22'.repeat(noxaFixture.poolCodeBytes)}`;
          }
          if (calls.filter((call) => call.method === 'eth_call').length === 1) {
            return noxaFixture.getLaunchedTokenResult;
          }
          return noxaFixture.getPoolResult;
        },
      },
    });
    const launch = decodeTokenLaunched(noxaFixture.tokenLaunched);

    const result = await validator.validateOnchain(launch, {
      v3Pool: decodePoolCreated(v3Fixture.poolCreated),
    });

    assert.equal(result.accepted, true);
    assert.equal(result.marketDiscoveryKey, `robinhood:uniswap-v3:${noxaFixture.expected.pool}`);
    assert.equal(calls.length, 4);
    assert.equal(calls.every(({ params }) => params.at(-1) === noxaFixture.tokenLaunched.blockNumber), true);
  });

  it('rejects malformed bytecode and block quantities before accepting a launch', () => {
    assert.equal(codeByteLength('0x0011', 'code'), 2);
    assert.throws(() => codeByteLength('0x0', 'code'), /invalid bytecode/);
    assert.equal(toBlockTag('6880646'), noxaFixture.tokenLaunched.blockNumber);
    assert.throws(() => toBlockTag('latest'), /must be a quantity/);
  });
});
