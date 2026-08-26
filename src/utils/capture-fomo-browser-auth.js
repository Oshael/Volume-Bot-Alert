'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { chromium } = require('@playwright/test');

const SESSION_URL = 'https://auth.privy.io/api/v1/sessions';
const CURRENT_USER_URL = 'https://prod-api.fomo.family/v2/users';
const FOMO_URL = 'https://fomo.family/';
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isJwt(value) {
  return typeof value === 'string'
    && value.split('.').length === 3
    && value.split('.').every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}

function jwtSessionIdentity(value) {
  if (!isJwt(value)) return null;
  try {
    const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
    if (typeof payload.sub !== 'string' || !payload.sub
      || typeof payload.sid !== 'string' || !payload.sid) return null;
    return { sub: payload.sub, sid: payload.sid };
  } catch (_error) {
    return null;
  }
}

function sessionCapture(body, headers = {}) {
  const privyAccessToken = body?.privy_access_token;
  const appToken = isJwt(body?.token) ? body.token : null;
  const refreshToken = body?.refresh_token;
  const caId = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === 'privy-ca-id')?.[1];
  if (!isJwt(privyAccessToken) || typeof refreshToken !== 'string' || !refreshToken.trim()
    || typeof caId !== 'string' || !caId.trim()) return null;
  return { privyAccessToken, appToken, refreshToken: refreshToken.trim(), caId: caId.trim() };
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
  if ((payload?.type === 'subscribe' || payload?.type === 'subscribed')
    && payload.topicType === 'trading_activity'
    && UUID.test(String(payload.topicId || ''))) {
    return { topicId: payload.topicId };
  }
  return null;
}

function profileTopicCapture(body) {
  const topicId = body?.responseObject?.id;
  return UUID.test(String(topicId || '')) ? { topicId } : null;
}

function createCaptureAccumulator() {
  let session = null;
  let socketAccessToken = null;
  let topicId = null;
  const waiters = new Set();

  function snapshot() {
    if (!session || !socketAccessToken || !topicId) return null;
    const privyIdentity = jwtSessionIdentity(session.privyAccessToken);
    const socketIdentity = jwtSessionIdentity(socketAccessToken);
    const sameSession = session.appToken
      ? session.appToken === socketAccessToken
      : privyIdentity && socketIdentity
        && privyIdentity.sub === socketIdentity.sub && privyIdentity.sid === socketIdentity.sid;
    if (!sameSession) return null;
    return {
      accessToken: socketAccessToken,
      refreshToken: session.refreshToken,
      caId: session.caId,
      topicId,
    };
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
    getStatus: () => ({
      privySession: Boolean(session),
      websocketJwt: Boolean(socketAccessToken),
      topicId: Boolean(topicId),
      sessionMatched: Boolean(snapshot()),
    }),
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

function attachCapture(page, accumulator, onProgress = () => {}) {
  page.on('response', async (response) => {
    const isPrivySession = response.url() === SESSION_URL
      && response.request().method() === 'POST';
    const isCurrentUser = response.url() === CURRENT_USER_URL
      && response.request().method() === 'GET';
    if (!isPrivySession && !isCurrentUser) return;
    try {
      const body = await response.json();
      if (isPrivySession) {
        const headers = await response.request().allHeaders();
        accumulator.acceptSession(sessionCapture(body, headers));
      } else {
        accumulator.acceptSocket(profileTopicCapture(body));
      }
      onProgress(accumulator.getStatus());
    } catch (_error) {}
  });
  page.on('websocket', (socket) => {
    if (!socket.url().includes('prod-api.fomo.family/ws')) return;
    socket.on('framesent', ({ payload }) => {
      accumulator.acceptSocket(socketCapture(payload));
      onProgress(accumulator.getStatus());
    });
    socket.on('framereceived', ({ payload }) => {
      accumulator.acceptSocket(socketCapture(payload));
      onProgress(accumulator.getStatus());
    });
  });
}

function progressReporter() {
  let last = '';
  return (status) => {
    const current = JSON.stringify(status);
    if (current === last) return;
    last = current;
    console.log(`[captura] Privy=${status.privySession ? 'ok' : '...'} `
      + `JWT-WS=${status.websocketJwt ? 'ok' : '...'} `
      + `topicId=${status.topicId ? 'ok' : '...'} `
      + `sessão=${status.sessionMatched ? 'validada' : 'aguardando'}`);
  };
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
    const reportProgress = progressReporter();
    context.on('page', (page) => attachCapture(page, accumulator, reportProgress));
    const [fomoPage] = context.pages();
    if (!fomoPage) throw new Error('Chrome did not expose its initial page');
    attachCapture(fomoPage, accumulator, reportProgress);
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
  jwtSessionIdentity,
  parseArgs,
  profileTopicCapture,
  sessionCapture,
  socketCapture,
  writeBundle,
};
