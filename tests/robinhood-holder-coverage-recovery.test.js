'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { recoveryTail } = require('../src/models/robinhood-holder-coverage');

it('anchors only tracked recovery gaps at the locked live cursor', () => {
  const state = { deployment_block: '100', tail_capture_from_block: null };
  assert.equal(recoveryTail({
    captureMode: 'legacy', cursor: { next_block: '200' },
  }, state), null);
  assert.equal(recoveryTail({
    captureMode: 'tracked', cursor: { next_block: '200' },
  }, state), '200');
  assert.equal(recoveryTail({
    captureMode: 'tracked', cursor: { next_block: '200' },
  }, { deployment_block: '100', tail_capture_from_block: '150' }), '150');
  assert.equal(recoveryTail({
    captureMode: 'tracked', cursor: { next_block: '200' },
  }, { deployment_block: '100', tail_capture_from_block: '150' }, true), '200');
  assert.equal(recoveryTail({
    captureMode: 'tracked', cursor: { next_block: '200' },
  }, { deployment_block: '250', tail_capture_from_block: null }), '250');
});
