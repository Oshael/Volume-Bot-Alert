'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('@playwright/test');

const SESSION_URL = 'https://auth.privy.io/api/v1/sessions';
const FOMO_URL = 'https://fomo.family/';
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isJwt(value) {
  return typeof value === 'string'
    && value.split('.').length === 3
    && value.split('.').every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}

function sessionCapture(body, headers = {}) {
  const accessToken = body?.privy_access_token;
  const refreshToken = body?.refresh_token;
  const caId = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === 'privy-ca-id')?.[1];
  if (!isJwt(accessToken) || typeof refreshToken !== 'string' || !refreshToken.trim()
    || typeof caId !== 'string' || !caId.trim()) return null;
  return { accessToken, refreshToken: refreshToken.trim(), caId: caId.trim() };
}

function socketCapture(raw) {
  let payload;
  try {
    payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch (_error) {
    return null;
  }
  if (payload?.type === 'challengeResponse' && isJwt(payload.jwt)) {
    return { accessToken: payload.jwt };
  }
  if (payload?.type === 'subscribe' && payload.topicType === 'trading_activity'
    && UUID.test(String(payload.topicId || ''))) {
    return { topicId: payload.topicId };
  }
  return null;
}

function createCaptureAccumulator() {
  let session = null;
  let socketAccessToken = null;
  let topicId = null;
  const waiters = new Set();

  function snapshot() {
    if (!session || !socketAccessToken || !topicId || session.accessToken !== socketAccessToken) {
      return null;
    }
    return { ...session, topicId };
  }

  function notify() {
    const result = snapshot();
    if (!result) return;
    for (const resolve of waiters) resolve(result);
    waiters.clear();
  }

  return {
    acceptSession(value) {
      if (value) session = value;
      notify();
    },
    acceptSocket(value) {
      if (value?.accessToken) socketAccessToken = value.accessToken;
      if (value?.topicId) topicId = value.topicId;
      notify();
    },
    getSnapshot: snapshot,
    wait(timeoutMs = DEFAULT_TIMEOUT_MS) {
      const current = snapshot();
      if (current) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        let timer;
        const complete = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        waiters.add(complete);
        timer = setTimeout(() => {
          waiters.delete(complete);
          reject(new Error('Timed out waiting for a complete Fomo authentication session'));
        }, timeoutMs);
      });
    },
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const args = { outputDir: path.join(os.tmpdir(), `trendscope-fomo-auth-${timestamp()}`) };
  for (const value of argv) {
    if (value.startsWith('--output-dir=')) args.outputDir = path.resolve(value.slice(13));
    else if (value.startsWith('--timeout-minutes=')) {
      const minutes = Number(value.slice(18));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
        throw new TypeError('timeout minutes must be between 1 and 60');
      }
      args.timeoutMs = Math.round(minutes * 60_000);
    } else if (value.startsWith('--chrome-path=')) args.chromePath = path.resolve(value.slice(14));
    else throw new TypeError(`Unknown argument: ${value}`);
  }
  return args;
}

async function findChrome(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_error) {}
  }
  throw new Error('Google Chrome was not found; pass --chrome-path=/absolute/path');
}

function chromeArgs(profileDir, url, remoteDebugging = false) {
  return [
    ...(remoteDebugging ? ['--remote-debugging-port=0'] : []),
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    url,
  ];
}

async function stopChrome(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 5_000)),
  ]);
  if (!timedOut || child.exitCode !== null) return;
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

async function waitForDevTools(profileDir, child, timeoutMs = 15_000) {
  const activePort = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome exited before startup (${child.exitCode})`);
    try {
      const [port] = (await fs.readFile(activePort, 'utf8')).trim().split('\n');
      if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
    } catch (_error) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chrome DevTools endpoint did not become ready');
}

async function writeBundle(outputDir, capture) {
  await fs.mkdir(outputDir, { mode: 0o700 });
  const files = {
    'fomo-customer-token': `${capture.accessToken}\n`,
    'fomo-refresh-token': `${capture.refreshToken}\n`,
    'callouts.env.fragment': [
      `FOMO_WS_TOPIC_ID=${capture.topicId}`,
      `FOMO_PRIVY_CA_ID=${capture.caId}`,
      '',
    ].join('\n'),
  };
  for (const [name, contents] of Object.entries(files)) {
    const handle = await fs.open(path.join(outputDir, name), 'wx', 0o600);
    try { await handle.writeFile(contents, 'utf8'); } finally { await handle.close(); }
  }
  return outputDir;
}

function attachCapture(page, accumulator) {
  page.on('response', async (response) => {
    if (response.url() !== SESSION_URL || response.request().method() !== 'POST') return;
    try {
      const [body, headers] = await Promise.all([
        response.json(), response.request().allHeaders(),
      ]);
      accumulator.acceptSession(sessionCapture(body, headers));
    } catch (_error) {}
  });
  page.on('websocket', (socket) => {
    if (!socket.url().includes('prod-api.fomo.family/ws')) return;
    socket.on('framesent', ({ payload }) => accumulator.acceptSocket(socketCapture(payload)));
  });
}

async function promptForGoogleLogin() {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await terminal.question('Faça login no Gmail no Chrome aberto. Quando terminar, pressione Enter aqui... ');
  } finally {
    terminal.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const chromePath = await findChrome(options.chromePath);
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trendscope-fomo-browser-'));
  await fs.chmod(profileDir, 0o700);
  let browser;
  let child;
  try {
    child = spawn(chromePath, chromeArgs(profileDir, 'https://accounts.google.com/'),
      { stdio: 'ignore' });
    await promptForGoogleLogin();
    await stopChrome(child);

    child = spawn(chromePath, chromeArgs(profileDir, 'about:blank', true), { stdio: 'ignore' });
    const cdpUrl = await waitForDevTools(profileDir, child);
    browser = await chromium.connectOverCDP(cdpUrl);

    const context = browser.contexts()[0];
    const accumulator = createCaptureAccumulator();
    context.on('page', (page) => attachCapture(page, accumulator));
    const [fomoPage] = context.pages();
    if (!fomoPage) throw new Error('Chrome did not expose its initial page');
    attachCapture(fomoPage, accumulator);
    await fomoPage.goto(FOMO_URL, { waitUntil: 'domcontentloaded' });
    console.log('Agora faça login na Fomo com o Google. A captura terminará automaticamente.');

    const capture = await accumulator.wait(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const outputDir = await writeBundle(options.outputDir, capture);
    console.log(`Captura concluída e validada: ${outputDir}`);
    console.log('O Chrome isolado será fechado sem logout; nenhum segredo foi impresso.');
  } finally {
    try { await browser?.close(); } catch (_error) {}
    await stopChrome(child);
    const expectedPrefix = path.join(os.tmpdir(), 'trendscope-fomo-browser-');
    if (profileDir.startsWith(expectedPrefix)) {
      try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (_error) {}
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Fomo auth capture failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  chromeArgs,
  createCaptureAccumulator,
  isJwt,
  parseArgs,
  sessionCapture,
  socketCapture,
  writeBundle,
};
