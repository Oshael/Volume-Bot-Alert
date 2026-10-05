const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGmgnCooldown } = require('../src/services/gmgn-cooldown');
const gmgn = require('../src/services/gmgn-client');

it('shares vendor cooldowns across processes and resumes only after reset plus buffer', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-cooldown-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let nowMs = 100000;
  const cooldown = createGmgnCooldown({ directory, now: () => nowMs });
  let calls = 0;
  const client = gmgn.createGmgnClient({
    cooldown,
    execFileImpl: async () => {
      calls += 1;
      const error = new Error('failed');
      error.stderr = '{"code":429,"reset_at":400}';
      throw error;
    },
  });
  await assert.rejects(client.fetchMarketSignal(), gmgn.GmgnRateLimitError);
  assert.equal(calls, 1);
  const other = createGmgnCooldown({ directory, now: () => nowMs });
  await Promise.all([other.block(200), cooldown.block(400)]);
  assert.equal(await other.getUntilMs(), 401000);

  const childCode = `
    const { createGmgnCooldown } = require('./src/services/gmgn-cooldown');
    const gmgn = require('./src/services/gmgn-client');
    const cooldown = createGmgnCooldown({ directory: process.argv[1], now: () => Number(process.argv[2]) });
    let calls = 0;
    const client = gmgn.createGmgnClient({ cooldown, execFileImpl: async () => {
      calls += 1; return { stdout: '{"data":{"rank":[]}}' };
    } });
    client.fetchTrending().then(() => console.log(JSON.stringify({ calls })))
      .catch(error => console.log(JSON.stringify({ calls, code: error.code, retryAt: error.retryAt })));
  `;
  const probe = (time) => JSON.parse(execFileSync(process.execPath, ['-e', childCode, directory, String(time)], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
  }));
  assert.deepEqual(probe(400000), { calls: 0, code: 'GMGN_RATE_LIMIT', retryAt: 401000 });
  assert.deepEqual(probe(401000), { calls: 1 });
  nowMs = 401000;
  assert.equal((await fs.readdir(directory)).length, 0);
});

it('uses a bounded fallback when 429 has no usable reset time and keeps cached data available', async () => {
  let nowMs = 100000;
  const cooldown = createGmgnCooldown({ directory: null, now: () => nowMs });
  const cache = gmgn.__private.createRiskLookupCache({ ttlMs: 600000, now: () => nowMs });
  const address = 'So11111111111111111111111111111111111111112';
  let calls = 0;
  const client = gmgn.createGmgnClient({
    cooldown, riskLookupCache: cache,
    execFileImpl: async () => {
      calls += 1;
      if (calls === 1) return { stdout: JSON.stringify({ address, holder_count: 123 }) };
      throw Object.assign(new Error('HTTP 429 RATE_LIMIT_BANNED'), { stderr: 'unknown reset' });
    },
  });
  await client.fetchTokenInfo({ address });
  await assert.rejects(client.fetchMarketSignal(), gmgn.GmgnRateLimitError);
  assert.equal(await cooldown.getUntilMs(), 401000);
  assert.equal((await client.fetchTokenInfo({ address })).holderCount, 123);
  await assert.rejects(client.fetchTokenInfo({ address, skipCache: true }), gmgn.GmgnRateLimitError);
  assert.equal(calls, 2);
  nowMs = 401000;
  await assert.rejects(client.fetchMarketSignal(), gmgn.GmgnRateLimitError);
  assert.equal(calls, 3);
});

it('fails closed when shared cooldown storage cannot be read', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'file');
  await fs.writeFile(file, '');
  let calls = 0;
  const client = gmgn.createGmgnClient({
    cooldown: createGmgnCooldown({ directory: file }),
    execFileImpl: async () => { calls += 1; return { stdout: '{}' }; },
  });
  await assert.rejects(client.fetchTrending(), (error) => error instanceof gmgn.GmgnCliError && error.exitCode === 'ENOTDIR');
  assert.equal(calls, 0);
});
