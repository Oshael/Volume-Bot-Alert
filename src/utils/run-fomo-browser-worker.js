'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_CHROME_PATH = '/usr/bin/google-chrome-stable';
const DEFAULT_PROFILE_DIR = '/var/lib/fomo-browser/profile';
const DEFAULT_START_URL = 'https://fomo.family/tokens/robinhood/0x39dbed3a2bd333467115de45665cc57f813c4571';

function absolutePath(value, fallback, name) {
  const normalized = String(value || fallback).trim();
  if (!path.isAbsolute(normalized)) throw new TypeError(`${name} must be an absolute path`);
  return normalized;
}

function port(value) {
  const parsed = Number.parseInt(String(value || '9222'), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new TypeError('FOMO_BROWSER_CDP_PORT must be between 1 and 65535');
  }
  return parsed;
}

function startUrl(value) {
  const parsed = new URL(String(value || DEFAULT_START_URL).trim());
  if (parsed.protocol !== 'https:' || !['fomo.family', 'www.fomo.family'].includes(parsed.hostname)) {
    throw new TypeError('FOMO_BROWSER_START_URL must be an HTTPS fomo.family URL');
  }
  return parsed.toString();
}

function optionsFromEnv(env = process.env) {
  return Object.freeze({
    chromePath: absolutePath(env.FOMO_BROWSER_CHROME_PATH, DEFAULT_CHROME_PATH,
      'FOMO_BROWSER_CHROME_PATH'),
    profileDir: absolutePath(env.FOMO_BROWSER_PROFILE_DIR, DEFAULT_PROFILE_DIR,
      'FOMO_BROWSER_PROFILE_DIR'),
    cdpPort: port(env.FOMO_BROWSER_CDP_PORT),
    startUrl: startUrl(env.FOMO_BROWSER_START_URL),
  });
}

function chromeArgs(options) {
  return [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${options.cdpPort}`,
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    options.startUrl,
  ];
}

async function assertPreconditions(options, fileSystem = fs) {
  await fileSystem.access(options.chromePath, constants.X_OK);
  const profile = await fileSystem.stat(options.profileDir);
  if (!profile.isDirectory()) throw new Error('Fomo browser profile path must be a directory');
  await fileSystem.access(options.profileDir, constants.R_OK | constants.W_OK);
  await fileSystem.access(
    path.join(options.profileDir, 'Local State'), constants.R_OK | constants.W_OK
  );
}

async function main(deps = {}) {
  const options = deps.options || optionsFromEnv(deps.env);
  const fileSystem = deps.fileSystem || fs;
  const spawnProcess = deps.spawn || spawn;
  const runtimeProcess = deps.process || process;
  const logger = deps.logger || console;
  await assertPreconditions(options, fileSystem);

  const child = spawnProcess(options.chromePath, chromeArgs(options), { stdio: 'inherit' });
  let stopping = false;
  let exited = false;
  let resolveExit;
  const exit = new Promise((resolve) => { resolveExit = resolve; });

  child.once('error', (error) => {
    logger.error('[FomoBrowserProcess] Chrome failed:', error.message);
    runtimeProcess.exitCode = 1;
    if (!exited) { exited = true; resolveExit(); }
  });
  child.once('exit', (code, signal) => {
    if (!stopping && !exited) {
      logger.error(`[FomoBrowserProcess] Chrome exited unexpectedly; code=${code ?? 'null'} signal=${signal || 'none'}`);
      runtimeProcess.exitCode = 1;
    }
    if (!exited) { exited = true; resolveExit(); }
  });

  async function shutdown(signal = 'SIGTERM') {
    if (stopping) return exit;
    stopping = true;
    if (!exited) child.kill(signal);
    return exit;
  }

  runtimeProcess.once('SIGINT', () => { void shutdown('SIGINT'); });
  runtimeProcess.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  logger.log(`[FomoBrowserProcess] Started Chrome CDP on 127.0.0.1:${options.cdpPort}`);
  return Object.freeze({ child, exit, shutdown });
}

if (require.main === module) main().catch((error) => {
  console.error('[FomoBrowserProcess] Fatal:', error.message);
  process.exitCode = 1;
});

module.exports = {
  DEFAULT_CHROME_PATH, DEFAULT_PROFILE_DIR, DEFAULT_START_URL,
  assertPreconditions, chromeArgs, main, optionsFromEnv,
};
