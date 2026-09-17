'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { __private } = require('../src/models/robinhood-holder-ledger');

it('anchors only tracked recovery gaps at the locked live cursor', () => {
  const state = { tail_capture_from_block: null };
  assert.equal(__private.recoveryTail({
    captureMode: 'legacy', cursor: { next_block: '200' },
  }, state), null);
  assert.equal(__private.recoveryTail({
    captureMode: 'tracked', cursor: { next_block: '200' },
  }, state), '200');
  assert.equal(__private.recoveryTail({
    captureMode: 'tracked', cursor: { next_block: '200' },
  }, { tail_capture_from_block: '150' }), '150');
  assert.equal(__private.recoveryTail({
    captureMode: 'tracked', cursor: { next_block: '200' },
  }, { tail_capture_from_block: '150' }, true), '200');
});
