const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { parseArgs, createSshTransport, RECEIVER, IDENTITY } = require('../src/utils/transfer-robinhood-holder-journal');
const { sourceSql } = require('../src/services/robinhood-holder-journal-transfer');
const runId = '12345678-1234-1234-1234-123456789abc';
const base = [`--database=volume_alert`, `--run-id=${runId}`, '--from-page=0', '--end-page=32768',
  '--pause-ms=100', `--receiver=${RECEIVER}`, '--write', '--allow-holder-lock', '--allow-remote-write'];

test('transfer CLI requires the fixed receiver, bounded pilot range and all acknowledgements', () => {
  assert.deepEqual(parseArgs(base), { database: 'volume_alert', runId, fromPage: 0, full: false,
    endPage: 32768, pauseMs: 100, schema: 'public', write: true, allowHolderLock: true,
    pilotValidated: false, allowUnattended: false });
  for (const replacement of ['--pause-ms=0', '--end-page=32769', '--receiver=root@example.com']) {
    assert.throws(() => parseArgs(base.map(arg => arg.split('=')[0] === replacement.split('=')[0] ? replacement : arg)));
  }
  for (const flag of ['--write', '--allow-holder-lock', '--allow-remote-write']) {
    assert.throws(() => parseArgs(base.filter(arg => arg !== flag)));
  }
});

test('full CLI requires the whole-heap shape, pause 50 and explicit pilot/unattended acknowledgements', () => {
  const full = base.map(arg => arg === '--end-page=32768' ? '--end-page=18143575'
    : arg === '--pause-ms=100' ? '--pause-ms=50' : arg)
    .concat('--full', '--pilot-validated', '--allow-unattended');
  assert.equal(parseArgs(full).full, true);
  assert.throws(() => parseArgs(full.filter(arg => arg !== '--pilot-validated')));
  assert.throws(() => parseArgs(full.map(arg => arg === '--from-page=0' ? '--from-page=1' : arg)));
  assert.throws(() => parseArgs(full.map(arg => arg === '--pause-ms=50' ? '--pause-ms=0' : arg)));
});

test('source query projects exact text values and retains the bounded compaction filter', () => {
  const sql = sourceSql('public', [{ name: 'amount_raw' }, { name: 'captured_at' }, { name: 'applied' }]);
  assert.match(sql, /b\."amount_raw"::text AS "amount_raw"/);
  assert.match(sql, /j\.ctid >= \$1::tid AND j\.ctid < \$2::tid/);
  assert.match(sql, /block_number >= \$3::bigint/);
  assert.match(sql, /applied=false AND p\.token_address IS NOT NULL/);
  assert.throws(() => sourceSql('public;drop', []), /schema/);
});

test('SSH transport uses one compressed fixed receiver session with line-delimited replies', async () => {
  let command; let args; let child;
  const spawn = (nextCommand, nextArgs) => {
    command = nextCommand; args = nextArgs; child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    child.stdin.once('finish', () => child.emit('close', 0));
    return child;
  };
  const transport = createSshTransport(RECEIVER, spawn);
  const reply = transport.send({ op: 'status' });
  child.stdout.write('{"outcome":"status"}\n');
  assert.deepEqual(await reply, { outcome: 'status' });
  await transport.close();
  assert.equal(command, 'ssh'); assert.ok(args.includes('-C'));
  assert.equal(args[args.indexOf('-i') + 1], IDENTITY); assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes(RECEIVER)); assert.ok(args.includes('--stream'));
  assert.ok(args.includes('/opt/holder-journal-receiver/src/utils/receive-robinhood-holder-journal.js'));
});
