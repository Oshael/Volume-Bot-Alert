const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const noxaFixture = require('../data/fixtures/robinhood-noxa-launch.json');
const v3Fixture = require('../data/fixtures/robinhood-uniswap-v3.json');
const { decodePoolCreated } = require('../src/services/uniswap-v3-decoder');
const {
  GET_LAUNCHED_TOKEN_SELECTOR,
  GET_POOL_SELECTOR,
  NOXA_FACTORY,
  ROBINHOOD_WETH,
  TOKEN_LAUNCHED_TOPIC,
  UNISWAP_V3_FACTORY,
  buildGetLaunchedTokenCall,
  buildGetPoolCall,
  decodeAddressResult,
  decodeLaunchedTokenResult,
  decodeTokenLaunched,
  validateLaunch,
} = require('../src/services/noxa-launch-decoder');

const OTHER = '0x1111111111111111111111111111111111111111';

function validContext() {
  return {
    v3Pool: decodePoolCreated(v3Fixture.poolCreated),
    launchedToken: decodeLaunchedTokenResult(noxaFixture.getLaunchedTokenResult),
    canonicalPoolAddress: decodeAddressResult(noxaFixture.getPoolResult),
    tokenCodeBytes: noxaFixture.tokenCodeBytes,
    poolCodeBytes: noxaFixture.poolCodeBytes,
  };
}

function replaceWord(data, index, word) {
  const raw = data.slice(2);
  return `0x${raw.slice(0, index * 64)}${word.slice(2)}${raw.slice((index + 1) * 64)}`;
}

function uintWord(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

describe('Robinhood NOXA launch decoder', () => {
  it('decodes the real TokenLaunched fields and labels the restriction block as L1', () => {
    const launch = decodeTokenLaunched(noxaFixture.tokenLaunched);
    const expected = noxaFixture.expected;

    assert.equal(launch.kind, 'token-launched');
    assert.equal(launch.factoryAddress, NOXA_FACTORY);
    assert.equal(launch.tokenAddress, expected.token);
    assert.equal(launch.deployerAddress, expected.deployer);
    assert.equal(launch.dexFactoryAddress, expected.dexFactory);
    assert.equal(launch.pairTokenAddress, expected.pairToken);
    assert.equal(launch.poolAddress, expected.pool);
    assert.equal(launch.positionId, expected.positionId);
    assert.equal(launch.dexId, expected.dexId);
    assert.equal(launch.launchConfigId, expected.launchConfigId);
    assert.equal(launch.restrictionsEndBlockL1, expected.restrictionsEndBlockL1);
    assert.equal(launch.initialBuyAmountRaw, expected.initialBuyAmount);
    assert.equal(launch.launchSource, 'noxa-fun');
  });

  it('decodes all 13 fields returned by getLaunchedToken', () => {
    const record = decodeLaunchedTokenResult(noxaFixture.getLaunchedTokenResult);
    const expected = noxaFixture.expected;

    assert.equal(record.tokenAddress, expected.token);
    assert.equal(record.deployerAddress, expected.deployer);
    assert.equal(record.pairedTokenAddress, expected.pairToken);
    assert.equal(record.positionManagerAddress, expected.positionManager);
    assert.equal(record.positionId, expected.positionId);
    assert.equal(record.dexId, expected.dexId);
    assert.equal(record.launchConfigId, expected.launchConfigId);
    assert.equal(record.restrictionsEndBlockL1, expected.restrictionsEndBlockL1);
    assert.equal(record.supplyRaw, expected.supply);
    assert.equal(record.isToken0, expected.isToken0);
    assert.equal(record.poolFee, expected.poolFee);
    assert.equal(record.exists, true);
    assert.equal(record.initialBuyAmountRaw, expected.initialBuyAmount);
  });

  it('accepts the real launch only after every NOXA and Uniswap gate agrees', () => {
    const launch = decodeTokenLaunched(noxaFixture.tokenLaunched);
    const validated = validateLaunch(launch, validContext());

    assert.equal(validated.accepted, true);
    assert.deepEqual(validated.validationErrors, []);
    assert.equal(validated.dexFactoryAddress, UNISWAP_V3_FACTORY);
    assert.equal(validated.pairTokenAddress, ROBINHOOD_WETH);
    assert.equal(validated.factoryRecord.exists, true);
    assert.equal(validated.isNewMarket, false);
    assert.equal(validated.deduplicatedWith, 'uniswap-v3');
    assert.equal(validated.marketDiscoveryKey, `robinhood:uniswap-v3:${noxaFixture.expected.pool}`);
  });

  it('builds the exact factory read calls used by the live validation', () => {
    const launchedCall = buildGetLaunchedTokenCall(noxaFixture.expected.token);
    const poolCall = buildGetPoolCall(
      noxaFixture.expected.token,
      noxaFixture.expected.pairToken,
      noxaFixture.expected.poolFee
    );

    assert.equal(launchedCall.slice(0, 10), GET_LAUNCHED_TOKEN_SELECTOR);
    assert.equal(launchedCall.length, 10 + 64);
    assert.equal(poolCall.slice(0, 10), GET_POOL_SELECTOR);
    assert.equal(poolCall.length, 10 + (64 * 3));
    assert.equal(decodeAddressResult(noxaFixture.getPoolResult), noxaFixture.expected.pool);
  });

  it('rejects a lookalike event with the wrong DEX factory or pair token', () => {
    const launch = decodeTokenLaunched(noxaFixture.tokenLaunched);

    const wrongLaunchFactory = validateLaunch({ ...launch, factoryAddress: OTHER }, validContext());
    const wrongFactory = validateLaunch({ ...launch, dexFactoryAddress: OTHER }, validContext());
    const wrongPair = validateLaunch({ ...launch, pairTokenAddress: OTHER }, validContext());
    assert.equal(wrongLaunchFactory.validationErrors.includes('unexpected_launch_factory'), true);
    assert.equal(wrongLaunchFactory.deduplicatedWith, null);
    assert.equal(wrongLaunchFactory.marketDiscoveryKey, null);
    assert.equal(wrongFactory.accepted, false);
    assert.equal(wrongFactory.validationErrors.includes('unexpected_dex_factory'), true);
    assert.equal(wrongPair.accepted, false);
    assert.equal(wrongPair.validationErrors.includes('unexpected_pair_token'), true);
  });

  it('rejects mismatches against PoolCreated, getPool, and bytecode', () => {
    const launch = decodeTokenLaunched(noxaFixture.tokenLaunched);
    const poolMismatch = validContext();
    poolMismatch.v3Pool = { ...poolMismatch.v3Pool, poolAddress: OTHER };
    const canonicalMismatch = { ...validContext(), canonicalPoolAddress: OTHER };
    const missingCode = { ...validContext(), tokenCodeBytes: 0, poolCodeBytes: 0 };

    assert.equal(validateLaunch(launch, poolMismatch).validationErrors.includes('pool_event_mismatch'), true);
    assert.equal(validateLaunch(launch, canonicalMismatch).validationErrors.includes('canonical_pool_mismatch'), true);
    const codeErrors = validateLaunch(launch, missingCode).validationErrors;
    assert.equal(codeErrors.includes('token_without_code'), true);
    assert.equal(codeErrors.includes('pool_without_code'), true);
  });

  it('requires an existing factory record and matching launch fields', () => {
    const launch = decodeTokenLaunched(noxaFixture.tokenLaunched);
    assert.equal(validateLaunch(launch, { ...validContext(), launchedToken: null }).accepted, false);

    const context = validContext();
    context.launchedToken = {
      ...context.launchedToken,
      exists: false,
      deployerAddress: OTHER,
      initialBuyAmountRaw: '1',
    };
    const errors = validateLaunch(launch, context).validationErrors;
    assert.equal(errors.includes('factory_record_missing'), true);
    assert.equal(errors.includes('record_deployer_mismatch'), true);
    assert.equal(errors.includes('record_initial_buy_mismatch'), true);
  });

  it('fails closed for wrong emitter/topic and malformed event data', () => {
    assert.throws(
      () => decodeTokenLaunched({ ...noxaFixture.tokenLaunched, address: OTHER }),
      /Unexpected NOXA emitter/
    );
    assert.throws(
      () => decodeTokenLaunched({
        ...noxaFixture.tokenLaunched,
        topics: [`0x${'44'.repeat(32)}`, ...noxaFixture.tokenLaunched.topics.slice(1)],
      }),
      /Unexpected NOXA topic/
    );
    assert.throws(
      () => decodeTokenLaunched({ ...noxaFixture.tokenLaunched, data: '0x00' }),
      /exactly 7 ABI words/
    );
    assert.equal(noxaFixture.tokenLaunched.topics[0], TOKEN_LAUNCHED_TOPIC);
  });

  it('rejects malformed bool and uint24 values in the factory record', () => {
    const badBool = replaceWord(noxaFixture.getLaunchedTokenResult, 11, uintWord(2));
    const badFee = replaceWord(noxaFixture.getLaunchedTokenResult, 10, uintWord(1n << 24n));

    assert.throws(() => decodeLaunchedTokenResult(badBool), /not an ABI bool/);
    assert.throws(() => decodeLaunchedTokenResult(badFee), /exceeds uint24/);
    assert.throws(
      () => buildGetPoolCall(noxaFixture.expected.token, ROBINHOOD_WETH, 1n << 24n),
      /exceeds uint24/
    );
  });
});
