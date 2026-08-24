'use strict';

// Read-only comparison of the Following lists from two existing X browser
// sessions. It captures each session's current web query, paginates it, and
// compares stable user IDs without persisting cookies or request headers.

const { chromium } = require('@playwright/test');
const { graphqlOperation } = require('./x-push-latency-probe');

const OPERATION = 'Following';
const SAFE_HEADERS = new Set([
  'accept', 'authorization', 'content-type', 'referer', 'user-agent', 'x-client-transaction-id',
  'x-csrf-token', 'x-twitter-active-user', 'x-twitter-auth-type', 'x-twitter-client-language',
]);

function readPositiveInt(name, fallback) {
  const value = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeHandle(value, name) {
  const handle = String(value || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error(`${name} must be a valid X handle`);
  return handle;
}

function normalizeEndpoint(value, name) {
  const endpoint = String(value || '').trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+\/?$/i.test(endpoint)) {
    throw new Error(`${name} must be a localhost CDP URL`);
  }
  return endpoint;
}

function followingUser(content) {
  const result = content?.itemContent?.user_results?.result;
  if (!result?.rest_id) return null;
  return {
    restId: result.rest_id,
    screenName: result.core?.screen_name || result.legacy?.screen_name || null,
  };
}

function parseFollowingPage(body) {
  const instructions = body?.data?.user?.result?.timeline?.timeline?.instructions || [];
  const contents = instructions.flatMap((instruction) => instruction.entries || [])
    .map((entry) => entry.content || {});
  const users = contents.map(followingUser).filter(Boolean);
  const bottom = contents.find((content) => String(content.cursorType).toLowerCase() === 'bottom');
  return { users, bottomCursor: bottom?.value || null };
}

function paginatedUrl(rawUrl, count, cursor) {
  const url = new URL(rawUrl);
  const variables = JSON.parse(url.searchParams.get('variables') || '{}');
  variables.count = count;
  if (cursor) variables.cursor = cursor;
  else delete variables.cursor;
  url.searchParams.set('variables', JSON.stringify(variables));
  return url.toString();
}

function isFollowMutation(request) {
  if (request.method() !== 'POST') return false;
  const url = request.url();
  const operation = graphqlOperation(url) || '';
  return /\/friendships\/create(?:\.json)?(?:[?]|$)/i.test(url)
    || /^(CreateFriendship|FollowUser)$/i.test(operation);
}

function requestTarget(request) {
  const raw = request.postData() || '';
  try {
    const parsed = JSON.parse(raw);
    const variables = typeof parsed.variables === 'string' ? JSON.parse(parsed.variables) : parsed.variables;
    return {
      restId: String(variables?.target_user_id || variables?.userId || parsed.user_id || '') || null,
      screenName: variables?.screen_name || parsed.screen_name || null,
    };
  } catch {
    const params = new URLSearchParams(raw);
    return {
      restId: params.get('user_id') || null,
      screenName: params.get('screen_name') || null,
    };
  }
}

function responseTarget(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  const restId = value.rest_id || value.id_str;
  const screenName = value.core?.screen_name || value.legacy?.screen_name || value.screen_name;
  if (restId && screenName) return { restId: String(restId), screenName };
  for (const nested of Object.values(value)) {
    const found = responseTarget(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function followTarget(request, body) {
  const fromRequest = requestTarget(request);
  const fromResponse = responseTarget(body) || {};
  return {
    restId: fromRequest.restId || fromResponse.restId || null,
    screenName: fromRequest.screenName || fromResponse.screenName || null,
  };
}

function compareFollowing(accountA, accountB, candidates = []) {
  const aById = new Map(accountA.users.map((user) => [user.restId, user]));
  const bById = new Map(accountB.users.map((user) => [user.restId, user]));
  const overlap = [...aById].filter(([id]) => bById.has(id)).map(([restId, user]) => ({
    restId,
    screenName: user.screenName || bById.get(restId).screenName,
  })).sort((left, right) => String(left.screenName).localeCompare(String(right.screenName)));
  const followedByHandle = new Map();
  for (const [label, account] of [[accountA.label, accountA], [accountB.label, accountB]]) {
    for (const user of account.users) {
      if (!user.screenName) continue;
      const key = user.screenName.toLowerCase();
      if (!followedByHandle.has(key)) followedByHandle.set(key, []);
      followedByHandle.get(key).push(label);
    }
  }
  return {
    accounts: [accountA, accountB].map(({ label, handle, users, pages, complete }) => ({
      label, handle, followingRead: users.length, pages, complete,
    })),
    overlapCount: overlap.length,
    overlap,
    candidates: candidates.map((handle) => ({
      handle,
      followedBy: followedByHandle.get(handle.toLowerCase()) || [],
    })),
  };
}

async function captureTemplate(page, handle) {
  const pending = page.waitForResponse((response) => graphqlOperation(response.url()) === OPERATION, {
    timeout: 30000,
  });
  await page.goto(`https://x.com/${handle}/following`, { waitUntil: 'domcontentloaded' });
  const response = await pending;
  if (!response.ok()) throw new Error(`Following initial request returned HTTP ${response.status()}`);
  const allHeaders = await response.request().allHeaders();
  const headers = Object.fromEntries(Object.entries(allHeaders)
    .filter(([key]) => SAFE_HEADERS.has(key.toLowerCase())));
  return { url: response.url(), headers, initialBody: await response.json() };
}

async function readFollowing(config, count, maxPages, delayMs) {
  const browser = await chromium.connectOverCDP(config.cdp);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`${config.label}: Chromium has no browser context`);
  const page = await context.newPage();
  try {
    const template = await captureTemplate(page, config.handle);
    const usersById = new Map();
    const seenCursors = new Set();
    let body = template.initialBody;
    let pages = 0;
    let complete = false;
    while (pages < maxPages) {
      pages += 1;
      const parsed = parseFollowingPage(body);
      for (const user of parsed.users) usersById.set(user.restId, user);
      if (!parsed.bottomCursor) {
        complete = true;
        break;
      }
      if (seenCursors.has(parsed.bottomCursor)) throw new Error(`${config.label}: repeated pagination cursor`);
      seenCursors.add(parsed.bottomCursor);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const response = await context.request.get(
        paginatedUrl(template.url, count, parsed.bottomCursor),
        { headers: template.headers },
      );
      if (!response.ok()) throw new Error(`${config.label}: pagination returned HTTP ${response.status()}`);
      body = await response.json();
    }
    return { ...config, users: [...usersById.values()], pages, complete, context };
  } finally {
    await page.close().catch(() => {});
  }
}

function accountHas(account, target) {
  return account.users.some((user) => (
    (target.restId && user.restId === target.restId)
    || (target.screenName && user.screenName?.toLowerCase() === target.screenName.toLowerCase())
  ));
}

function watchFollows(account, other) {
  account.context.on('response', async (response) => {
    const request = response.request();
    if (!isFollowMutation(request) || !response.ok()) return;
    const body = await response.json().catch(() => null);
    const target = followTarget(request, body);
    if (!target.restId && !target.screenName) {
      console.log(`[${account.label}] Follow detected, but target identity was unreadable.`);
      return;
    }
    const duplicate = accountHas(other, target);
    const identity = target.screenName ? `@${target.screenName}` : `id=${target.restId}`;
    process.stdout.write('\u0007');
    console.log(duplicate
      ? `[DUPLICATE] ${account.label} followed ${identity}, already followed by ${other.label}.`
      : `[OK] ${account.label} followed ${identity}; not present in ${other.label}.`);
    if (!accountHas(account, target)) account.users.push(target);
  });
}

function readConfig() {
  const accountA = {
    label: 'X',
    handle: normalizeHandle(process.env.X_FOLLOWING_A_HANDLE, 'X_FOLLOWING_A_HANDLE'),
    cdp: normalizeEndpoint(process.env.X_FOLLOWING_A_CDP, 'X_FOLLOWING_A_CDP'),
  };
  const accountB = {
    label: 'Y',
    handle: normalizeHandle(process.env.X_FOLLOWING_B_HANDLE, 'X_FOLLOWING_B_HANDLE'),
    cdp: normalizeEndpoint(process.env.X_FOLLOWING_B_CDP, 'X_FOLLOWING_B_CDP'),
  };
  if (accountA.cdp === accountB.cdp) throw new Error('X and Y must use distinct Chromium sessions');
  const candidates = String(process.env.X_FOLLOWING_CANDIDATES || '').split(',')
    .map((handle) => handle.trim().replace(/^@/, '')).filter(Boolean);
  for (const handle of candidates) normalizeHandle(handle, 'X_FOLLOWING_CANDIDATES');
  return { accountA, accountB, candidates };
}

async function main() {
  const { accountA, accountB, candidates } = readConfig();
  const count = readPositiveInt('X_FOLLOWING_PAGE_SIZE', 100);
  const maxPages = readPositiveInt('X_FOLLOWING_MAX_PAGES', 50);
  const delayMs = readPositiveInt('X_FOLLOWING_PAGE_DELAY_MS', 500);
  const [resultA, resultB] = await Promise.all([
    readFollowing(accountA, count, maxPages, delayMs),
    readFollowing(accountB, count, maxPages, delayMs),
  ]);
  console.log(JSON.stringify(compareFollowing(resultA, resultB, candidates), null, 2));
  watchFollows(resultA, resultB);
  watchFollows(resultB, resultA);
  console.log('WATCHING: follow in either Chromium; Ctrl+C stops.');
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`X following overlap probe failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  compareFollowing, followTarget, isFollowMutation, paginatedUrl, parseFollowingPage,
};
