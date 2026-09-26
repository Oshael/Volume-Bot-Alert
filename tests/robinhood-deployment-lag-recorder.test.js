'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodDeploymentLagRecorder,
} = require('../src/services/robinhood-deployment-lag-recorder');

it('persists a bounded incident before probing PostgreSQL and limits repeated alerts', async () => {
  let clock = 100_000;
  let release;
  const lines = [];
  const recorder = createRobinhoodDeploymentLagRecorder({
    now: () => clock, logger: (line) => lines.push(JSON.parse(line.split('] ')[1])),
    activityProbe: () => new Promise((resolve) => { release = resolve; }),
  });
  assert.equal(recorder.record('run_stall', () => ({ phase: 'process' })), true);
  assert.equal(lines[0].event, 'snapshot');
  assert.equal(lines[0].phase, 'process');
  assert.equal(recorder.record('run_stall', {}), false);
  assert.equal(recorder.record('late_mint', { tokenAddress: '0x123' }), true);
  await Promise.resolve();
  release({ sessions: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines.map((item) => item.event), [
    'snapshot', 'snapshot', 'postgres_activity', 'postgres_activity',
  ]);
  assert.equal(lines[2].id, lines[0].id);
  assert.equal(lines[3].id, lines[1].id);
  clock += 30_000;
  assert.equal(recorder.record('run_stall', {}), true);
  assert.equal(lines[4].suppressed, 1);
});

it('keeps the incident snapshot when the PostgreSQL probe fails', async () => {
  const lines = [];
  const recorder = createRobinhoodDeploymentLagRecorder({
    logger: (line) => lines.push(JSON.parse(line.split('] ')[1])),
    activityProbe: async () => { throw Object.assign(new Error('connect timeout'), {
      code: 'ETIMEDOUT',
    }); },
  });
  assert.equal(recorder.record('late_mint', { tokenAddress: '0x123' }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines.map((item) => item.event),
    ['snapshot', 'postgres_activity_error']);
  assert.equal(lines[1].code, 'ETIMEDOUT');
  assert.equal(lines[1].id, lines[0].id);
});
