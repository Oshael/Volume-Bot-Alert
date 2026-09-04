'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { runTransfer } = require('../services/robinhood-holder-journal-transfer');
const RECEIVER = 'root@159.195.17.104';
const IDENTITY = '/root/.ssh/holder-journal-transfer';
const REMOTE = '/opt/holder-journal-receiver/src/utils/receive-robinhood-holder-journal.js';
const FLAGS = new Set(['--write', '--allow-holder-lock', '--allow-remote-write', '--full',
  '--pilot-validated', '--allow-unattended']);

function collectArg(values, flags, arg) {
  const match = /^--(database|run-id|from-page|end-page|pause-ms|receiver)=(.+)$/.exec(arg);
  if (match) {
    if (Object.hasOwn(values, match[1])) throw new Error('repeated transfer argument');
    values[match[1]] = match[1].includes('page') || match[1] === 'pause-ms' ? Number(match[2]) : match[2];
    return;
  }
  if (!FLAGS.has(arg)) throw new Error('unknown transfer argument');
  if (flags.has(arg)) throw new Error('repeated transfer flag');
  flags.add(arg);
}

function validMode(values, flags, full) {
  return full
    ? values['from-page'] === 0 && values['pause-ms'] === 50
      && flags.has('--pilot-validated') && flags.has('--allow-unattended')
    : values['end-page'] - values['from-page'] <= 32768 && values['pause-ms'] === 100
      && !flags.has('--pilot-validated') && !flags.has('--allow-unattended');
}

function validCommon(values, flags) {
  return values.database === 'volume_alert' && values.receiver === RECEIVER
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(values['run-id'] || '')
    && Number.isSafeInteger(values['from-page']) && Number.isSafeInteger(values['end-page'])
    && values['from-page'] >= 0 && values['end-page'] > values['from-page']
    && values['end-page'] <= 4294967295
    && ['--write', '--allow-holder-lock', '--allow-remote-write'].every(flag => flags.has(flag));
}

function parseArgs(args) {
  const values = {}; const flags = new Set();
  for (const arg of args) collectArg(values, flags, arg);
  const full = flags.has('--full');
  if (!validCommon(values, flags) || !validMode(values, flags, full)) {
    throw new Error('use the explicit pilot or full transfer contract with all acknowledgements');
  }
  return { database: values.database, runId: values['run-id'], fromPage: values['from-page'], full,
    endPage: values['end-page'], pauseMs: values['pause-ms'], schema: 'public', write: true, allowHolderLock: true,
    pilotValidated: flags.has('--pilot-validated'), allowUnattended: flags.has('--allow-unattended') };
}

function createSshTransport(host = RECEIVER, spawnImpl = spawn) {
  if (host !== RECEIVER) throw new Error('unexpected receiver host');
  const child = spawnImpl('ssh', ['-T', '-C', '-i', IDENTITY, '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', host,
    'sudo', '-u', 'postgres', 'env',
    'HOLDER_JOURNAL_RECEIVER_DATABASE_URL=postgresql:///holder_compaction?host=/var/run/postgresql',
    '/usr/bin/node', REMOTE, '--database=holder_compaction', '--write', '--stream'],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  let pending; let stderr = ''; let closed = false;
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  lines.on('line', line => {
    if (!pending) { child.kill(); return; }
    const current = pending; pending = null; clearTimeout(current.timer);
    try { current.resolve(JSON.parse(line)); } catch { current.reject(new Error('receiver returned invalid JSON')); }
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      closed = true;
      if (pending) { const current = pending; pending = null; clearTimeout(current.timer); current.reject(new Error(`receiver exited ${code}: ${stderr}`)); }
      code === 0 ? resolve() : reject(new Error(`receiver exited ${code}: ${stderr}`));
    });
  });
  exited.catch(() => {});
  return {
    async send(frame) {
      if (closed || pending) throw new Error('receiver unavailable or request already pending');
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('receiver response timeout')); }, 15000);
        pending = { resolve, reject, timer };
      });
      if (!child.stdin.write(`${JSON.stringify(frame)}\n`)) await new Promise(resolve => child.stdin.once('drain', resolve));
      return response;
    },
    async close() { if (!closed) child.stdin.end(); await exited; },
  };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args); const connectionString = process.env.HOLDER_JOURNAL_SOURCE_DATABASE_URL;
  if (!connectionString) throw new Error('HOLDER_JOURNAL_SOURCE_DATABASE_URL is required; .env is not loaded');
  const { Pool } = require('pg'); const pool = new Pool({ connectionString, max: 2,
    connectionTimeoutMillis: 5000, application_name: `holder-journal-transfer-${process.pid}` });
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    let batchEvents = 0;
    const result = await runTransfer(pool, options, { signal: controller.signal,
      transport: createSshTransport(), progress: event => {
        if (event.phase !== 'batch' || ++batchEvents % 64 === 0 || event.page === options.endPage) {
          console.error(JSON.stringify(event));
        }
      } });
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); await pool.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'transfer_error', message: error.message }));
  process.exitCode = 1;
});
module.exports = { RECEIVER, IDENTITY, parseArgs, createSshTransport, main };
