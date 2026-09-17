'use strict';

async function lockCoverageRecoveryContext(client) {
  const cursor = (await client.query(
    `SELECT next_block, journal_floor_block FROM robinhood_holder_cursors
      WHERE chain = 'robinhood' AND stream = 'live' FOR UPDATE`
  )).rows[0];
  if (!cursor) {
    const error = new Error('holder live cursor is missing');
    error.code = 'holder_cursor_missing';
    throw error;
  }
  const policy = (await client.query(
    `SELECT capture_mode FROM robinhood_holder_capture_policy
      WHERE chain = 'robinhood' FOR SHARE`
  )).rows[0];
  if (!policy) {
    const error = new Error('holder capture policy is missing');
    error.code = 'holder_capture_policy_missing';
    throw error;
  }
  return Object.freeze({ cursor, captureMode: policy.capture_mode });
}

function recoveryTail(context, state, forceReanchor = false) {
  if (context.captureMode !== 'tracked') return state.tail_capture_from_block;
  if (!forceReanchor && state.tail_capture_from_block != null) {
    return state.tail_capture_from_block;
  }
  if (state.deployment_block == null) {
    const error = new Error('holder deployment block is missing for tracked recovery');
    error.code = 'holder_coverage_deployment_missing';
    throw error;
  }
  return BigInt(context.cursor.next_block) >= BigInt(state.deployment_block)
    ? String(context.cursor.next_block) : String(state.deployment_block);
}

module.exports = { lockCoverageRecoveryContext, recoveryTail };
