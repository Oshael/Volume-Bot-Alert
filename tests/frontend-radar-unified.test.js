const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

let createRadarUnifiedState;
let buildRadarUnifiedRequest;

before(async () => {
  ({ createRadarUnifiedState, buildRadarUnifiedRequest } = await import('../frontend/src/utils/radar-unified.ts'));
});

const RH = 'robinhood:0x1111111111111111111111111111111111111111';
const SOL = 'solana:So11111111111111111111111111111111111111112';

describe('unified Radar request state', () => {
  it('starts with one global page and an unbounded age range', () => {
    const state = createRadarUnifiedState();
    const request = buildRadarUnifiedRequest(state, { starred: [], dismissed: [] });

    assert.equal(request.page, 0);
    assert.equal(request.perPage, 15);
    assert.equal(request.ageMinMinutes, 0);
    assert.equal(request.ageMaxMinutes, undefined);
    assert.deepEqual(request.sorts, state.sorts);
    assert.equal(request.minMcap, 120_000);
    assert.equal(request.minFdv, 120_000);
  });

  it('retains Robinhood identities and caps the global pagination prefix', () => {
    const state = createRadarUnifiedState();
    state.page = 100;
    state.perPage = 25;
    state.searchQuery = '  ABC  ';
    state.starredOnly = true;
    state.ageMaxMinutes = 10_080;
    const request = buildRadarUnifiedRequest(state, {
      starred: [SOL, RH, RH, 'invalid'],
      dismissed: [SOL, RH],
      pinned: [RH, SOL],
    });

    assert.equal(request.page, 19);
    assert.equal(request.perPage, 25);
    assert.equal(request.searchQuery, 'ABC');
    assert.equal(request.starredOnly, true);
    assert.equal(request.ageMaxMinutes, 10_080);
    assert.deepEqual(request.starredIdentities, [RH]);
    assert.deepEqual(request.dismissedIdentities, [RH]);
    assert.deepEqual(request.pinnedIdentities, [RH]);
  });
});
