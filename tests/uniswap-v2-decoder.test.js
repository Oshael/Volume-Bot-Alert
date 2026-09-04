const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const fixture = require('../data/fixtures/robinhood-uniswap-v2.json');
const { buildDiscoveryEvidence } = require('../src/services/robinhood-head-evidence');
const {
  ROBINHOOD_USDG,
  ROBINHOOD_V2_FACTORY,
  ROBINHOOD_WETH,
  TOPICS,
  createUniswapV2Tracker,
  decodePairCreated,
  decodeSwap,
  selectQuote,
} = require('../src/services/uniswap-v2-decoder');

const MEME_LOW = '0x0000000000000000000000000000000000000001';
const MEME_HIGH = '0xffffffffffffffffffffffffffffffffffffffff';
const PAIR = '0x1111111111111111111111111111111111111111';
const SENDER = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const BLOCK_HASH = `0x${'aa'.repeat(32)}`;
const TX_HASH = `0x${'bb'.repeat(32)}`;

function addressWord(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function uintWord(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function dataWords(...values) {
  return `0x${values.map((value) => value.slice(2)).join('')}`;
}

function baseLog(overrides = {}) {
  return {
    address: PAIR,
    topics: [TOPICS.sync],
    data: dataWords(uintWord(1), uintWord(2)),
    blockNumber: '0x64',
    blockHash: BLOCK_HASH,
    transactionHash: TX_HASH,
    logIndex: '0x0',
    blockTimestamp: '0x10',
    removed: false,
    ...overrides,
  };
}

function pairCreatedLog(token0, token1, pair = PAIR) {
  return baseLog({
    address: ROBINHOOD_V2_FACTORY,
    topics: [TOPICS.pairCreated, addressWord(token0), addressWord(token1)],
    data: dataWords(addressWord(pair), uintWord(7)),
  });
}

function swapLog(pair, values) {
  return baseLog({
    address: pair,
    topics: [TOPICS.swap, addressWord(SENDER), addressWord(RECIPIENT)],
    data: dataWords(...values.map(uintWord)),
  });
}

describe('Robinhood Uniswap v2 decoder', () => {
  it('discovers the real WETH pair from the official factory fixture', () => {
    const event = decodePairCreated(fixture.pairCreated);

    assert.equal(event.kind, 'pair-created');
    assert.equal(event.factoryAddress, fixture.factory);
    assert.equal(event.token0, fixture.expected.token0);
    assert.equal(event.token1, fixture.expected.token1);
    assert.equal(event.pairAddress, fixture.expected.pair);
    assert.equal(event.marketKey, `robinhood:uniswap-v2:${fixture.expected.pair}`);
    assert.equal(event.pairIndex, fixture.expected.pairIndex);
    assert.equal(event.quoteAddress, ROBINHOOD_WETH);
    assert.equal(event.tokenAddress, fixture.expected.token1);
    assert.equal(event.quoteIndex, 0);
    assert.equal(event.tracked, true);
    assert.equal(event.blockNumber, '7474208');
    assert.equal(event.logIndex, '34');
  });

  it('maps the real Sync reserves to quote and token without Number conversion', () => {
    const tracker = createUniswapV2Tracker();
    tracker.processLog(fixture.pairCreated);
    const sync = tracker.processLog(fixture.sync);

    assert.equal(sync.kind, 'sync');
    assert.equal(sync.reserve0Raw, fixture.expected.reserve0Raw);
    assert.equal(sync.reserve1Raw, fixture.expected.reserve1Raw);
    assert.equal(sync.quoteReserveRaw, fixture.expected.reserve0Raw);
    assert.equal(sync.tokenReserveRaw, fixture.expected.reserve1Raw);
    assert.equal(typeof sync.quoteReserveRaw, 'string');
  });

  it('translates the real WETH-in swap into a buy with exact raw volume', () => {
    const tracker = createUniswapV2Tracker();
    const discovery = tracker.processLog(fixture.pairCreated);
    const swap = tracker.processLog(fixture.swap);

    assert.deepEqual(tracker.getPair(fixture.expected.pair), discovery);
    assert.equal(tracker.getTrackedPairs().length, 1);
    assert.equal(swap.kind, 'swap');
    assert.equal(swap.accepted, true);
    assert.equal(swap.side, fixture.expected.side);
    assert.equal(swap.quoteAmountRaw, fixture.expected.quoteAmountRaw);
    assert.equal(swap.tokenAmountRaw, fixture.expected.tokenAmountRaw);
    assert.equal(swap.amounts.amount0In, fixture.expected.quoteAmountRaw);
    assert.equal(swap.amounts.amount1Out, fixture.expected.tokenAmountRaw);
    assert.equal(swap.poolAddress, fixture.expected.pair);
    assert.equal(swap.marketKey, `robinhood:uniswap-v2:${fixture.expected.pair}`);
  });

  it('updates Sync reserves for swaps without mutating discovery evidence', () => {
    const tracker = createUniswapV2Tracker();
    const discovery = tracker.processLog(fixture.pairCreated);
    const { evidence } = buildDiscoveryEvidence({ event: discovery });
    const originalEvidence = JSON.stringify(evidence);
    const sync = tracker.processLog(fixture.sync);
    const swap = tracker.processLog(fixture.swap);

    assert.equal(swap.quoteReserveRaw, sync.quoteReserveRaw);
    assert.equal(swap.tokenReserveRaw, sync.tokenReserveRaw);
    assert.equal(tracker.getPair(fixture.expected.pair).quoteReserveRaw, sync.quoteReserveRaw);
    assert.equal(tracker.getPair(fixture.expected.pair).tokenReserveRaw, sync.tokenReserveRaw);
    assert.equal(JSON.stringify(evidence), originalEvidence);
    assert.deepEqual(discovery, decodePairCreated(fixture.pairCreated));
  });

  it('handles a sell when the quote is token1', () => {
    const tracker = createUniswapV2Tracker();
    const discovery = tracker.processLog(pairCreatedLog(MEME_LOW, ROBINHOOD_WETH));
    const swap = tracker.processLog(swapLog(PAIR, [123n, 0n, 0n, 7n]));

    assert.equal(discovery.quoteIndex, 1);
    assert.equal(discovery.tokenAddress, MEME_LOW);
    assert.equal(swap.accepted, true);
    assert.equal(swap.side, 'sell');
    assert.equal(swap.tokenAmountRaw, '123');
    assert.equal(swap.quoteAmountRaw, '7');
  });

  it('supports USDG as quote with the same direction rules', () => {
    const tracker = createUniswapV2Tracker();
    const discovery = tracker.processLog(pairCreatedLog(MEME_LOW, ROBINHOOD_USDG));
    const swap = tracker.processLog(swapLog(PAIR, [50n, 0n, 0n, 25n]));

    assert.equal(discovery.tracked, true);
    assert.equal(discovery.quoteAddress, ROBINHOOD_USDG);
    assert.equal(swap.side, 'sell');
    assert.equal(swap.quoteAmountRaw, '25');
    assert.equal(selectQuote(MEME_LOW.toUpperCase(), ROBINHOOD_USDG.toUpperCase()).quoteAddress, ROBINHOOD_USDG);
  });

  it('does not track pairs with no quote or two canonical quotes', () => {
    assert.deepEqual(selectQuote(MEME_LOW, MEME_HIGH), {
      tracked: false,
      reason: 'unsupported_quote_pair',
    });
    assert.deepEqual(selectQuote(ROBINHOOD_WETH, ROBINHOOD_USDG), {
      tracked: false,
      reason: 'ambiguous_quote_pair',
    });

    const tracker = createUniswapV2Tracker();
    const ignored = tracker.processLog(pairCreatedLog(MEME_LOW, MEME_HIGH));
    assert.equal(ignored.tracked, false);
    assert.equal(tracker.getTrackedPairs().length, 0);
  });

  it('rejects ambiguous swap flows instead of inventing a side or volume', () => {
    const tracker = createUniswapV2Tracker();
    tracker.processLog(pairCreatedLog(ROBINHOOD_WETH, MEME_HIGH));
    const swap = tracker.processLog(swapLog(PAIR, [10n, 2n, 0n, 5n]));

    assert.equal(swap.kind, 'swap');
    assert.equal(swap.accepted, false);
    assert.equal(swap.reason, 'ambiguous_swap_flow');
    assert.equal('side' in swap, false);
    assert.equal('quoteAmountRaw' in swap, false);
  });

  it('ignores unknown emitters and unrelated pair topics', () => {
    const tracker = createUniswapV2Tracker();
    tracker.processLog(pairCreatedLog(ROBINHOOD_WETH, MEME_HIGH));

    const unknown = tracker.processLog(swapLog(MEME_HIGH, [1n, 0n, 0n, 1n]));
    const unrelated = tracker.processLog(baseLog({
      address: PAIR,
      topics: [`0x${'44'.repeat(32)}`],
    }));
    assert.deepEqual(unknown, { kind: 'ignored', reason: 'unknown_pair' });
    assert.deepEqual(unrelated, { kind: 'ignored', reason: 'unsupported_pair_event' });
  });

  it('fails closed for matching events with malformed ABI data or wrong emitters', () => {
    const pair = decodePairCreated(pairCreatedLog(ROBINHOOD_WETH, MEME_HIGH));
    assert.throws(
      () => decodeSwap(swapLog(PAIR, [1n, 0n, 0n, 1n]), { ...pair, pairAddress: MEME_HIGH }),
      /Unexpected log emitter/
    );
    assert.throws(
      () => decodeSwap({ ...swapLog(PAIR, [1n, 0n, 0n, 1n]), data: '0x00' }, pair),
      /exactly 4 ABI words/
    );
    assert.throws(
      () => decodePairCreated({ ...pairCreatedLog(ROBINHOOD_WETH, MEME_HIGH), topics: [TOPICS.pairCreated] }),
      /Expected 3 event topics/
    );
  });

  it('preserves raw integers larger than Number.MAX_SAFE_INTEGER', () => {
    const huge = (2n ** 200n) + 123n;
    const tracker = createUniswapV2Tracker();
    tracker.processLog(pairCreatedLog(ROBINHOOD_WETH, MEME_HIGH));
    const swap = tracker.processLog(swapLog(PAIR, [huge, 0n, 0n, huge - 1n]));

    assert.equal(swap.quoteAmountRaw, huge.toString());
    assert.equal(swap.tokenAmountRaw, (huge - 1n).toString());
    assert.equal(Number.isSafeInteger(Number(swap.quoteAmountRaw)), false);
  });
});
