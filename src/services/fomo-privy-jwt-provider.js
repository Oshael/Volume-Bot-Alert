'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_SESSION_URL = 'https://auth.privy.io/api/v1/sessions';
const DEFAULT_APP_ID = 'cm6h485o300n3zj9yl6vpedq7';
const DEFAULT_CLIENT_ID = 'client-WY5gFSayQjxnQhG4rP6SnwPAyPZWZpNRhJ6b9rzMnYwqH';
const DEFAULT_PRIVY_CLIENT = 'react-auth:3.34.0';

function normalizeStoredSecret(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed.trim() : raw;
  } catch { return raw; }
}

function createAtomicSecretFileStore(filePath) {
  const resolved = path.resolve(String(filePath || '').trim());
  return {
    read: async () => normalizeStoredSecret(await fs.readFile(resolved, 'utf8')),
    write: async (value) => {
      const temporary = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${String(value).trim()}\n`, { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, resolved);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    },
  };
}

function jwtMetadata(value) {
  const jwt = String(value || '').trim();
  const segments = jwt.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? { jwt, exp: payload.exp } : null;
  } catch { return null; }
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function requiredStoredSecret(store, code, message, validate = Boolean) {
  let value = null;
  try { value = await store.read(); } catch { /* normalized below */ }
  if (!validate(value)) throw safeError(code, message);
  return value;
}

function requireSecretStores(options) {
  const { jwtStore, refreshTokenStore } = options;
  if (!jwtStore?.read || !jwtStore?.write || !refreshTokenStore?.read || !refreshTokenStore?.write) {
    throw new TypeError('Fomo Privy JWT provider requires readable and writable secret stores');
  }
  return { jwtStore, refreshTokenStore };
}

function sessionEndpoint(value) {
  const url = new URL(value || DEFAULT_SESSION_URL);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new TypeError('Fomo Privy session endpoint must be credential-free HTTPS');
  }
  return url;
}

function sessionHeaders(options) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: String(options.origin || 'https://fomo.family'),
    'privy-app-id': String(options.appId || DEFAULT_APP_ID),
    'privy-client-id': String(options.clientId || DEFAULT_CLIENT_ID),
    'privy-client': String(options.privyClient || DEFAULT_PRIVY_CLIENT),
    'privy-ca-id': String(options.clientAnalyticsId || crypto.randomUUID()),
  };
}

function createFomoPrivyJwtProvider(options = {}) {
  const { jwtStore, refreshTokenStore } = requireSecretStores(options);
  const fetchImpl = options.fetchImpl || global.fetch;
  const now = options.now || Date.now;
  const refreshSkewSeconds = Number(options.refreshSkewSeconds) || 30;
  const sessionUrl = sessionEndpoint(options.sessionUrl);
  const headers = sessionHeaders(options);
  let cached = null;
  let refreshPromise = null;
  const status = {
    refreshes: 0, failures: 0, lastRefreshAt: null, lastErrorCode: null,
    requiresReauth: false, tokenExpiresAt: null,
  };

  function unexpired(metadata) { return metadata && metadata.exp > (now() / 1000); }
  function active(metadata) {
    return unexpired(metadata) && metadata.exp > ((now() / 1000) + refreshSkewSeconds);
  }

  async function refresh() {
    const customerToken = await requiredStoredSecret(
      jwtStore, 'FOMO_PRIVY_CUSTOMER_TOKEN',
      'Fomo Privy customer credential is unavailable', jwtMetadata
    );
    const refreshToken = await requiredStoredSecret(
      refreshTokenStore, 'FOMO_PRIVY_REFRESH_TOKEN',
      'Fomo Privy refresh credential is unavailable'
    );
    let response;
    try {
      response = await fetchImpl(sessionUrl, {
        method: 'POST', headers: { ...headers, authorization: `Bearer ${customerToken}` },
        body: JSON.stringify({ refresh_token: refreshToken }),
        signal: AbortSignal.timeout(Number(options.timeoutMs) || 10_000),
      });
    } catch {
      throw safeError('FOMO_PRIVY_SESSION_REQUEST', 'Fomo Privy session refresh failed');
    }
    if (!response.ok) {
      const error = safeError(
        response.status === 401 || response.status === 403
          ? 'FOMO_PRIVY_REAUTH_REQUIRED' : 'FOMO_PRIVY_SESSION_REQUEST',
        'Fomo Privy session refresh was rejected'
      );
      error.statusCode = response.status;
      throw error;
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw safeError('FOMO_PRIVY_SESSION_RESPONSE', 'Fomo Privy session response was invalid');
    }
    const next = jwtMetadata(payload?.token);
    if (!active(next)) {
      if (payload?.session_update_action === 'ignore' && unexpired(cached)) return cached.jwt;
      throw safeError(
        payload?.session_update_action === 'ignore'
          ? 'FOMO_PRIVY_REAUTH_REQUIRED' : 'FOMO_PRIVY_SESSION_RESPONSE',
        'Fomo Privy session did not return a usable customer token'
      );
    }
    await jwtStore.write(next.jwt);
    if (payload.refresh_token && payload.refresh_token !== refreshToken) {
      await refreshTokenStore.write(payload.refresh_token);
    }
    cached = next;
    status.refreshes += 1;
    status.lastRefreshAt = new Date(now()).toISOString();
    return next.jwt;
  }

  async function getJwt() {
    if (active(cached)) return cached.jwt;
    let stored = null;
    try { stored = jwtMetadata(await jwtStore.read()); } catch { /* refresh may recover */ }
    if (unexpired(stored)) cached = stored;
    if (active(stored)) {
      cached = stored;
      status.tokenExpiresAt = new Date(stored.exp * 1000).toISOString();
      return stored.jwt;
    }
    if (!refreshPromise) refreshPromise = refresh().finally(() => { refreshPromise = null; });
    try {
      const jwt = await refreshPromise;
      status.requiresReauth = false;
      status.lastErrorCode = null;
      status.tokenExpiresAt = new Date(cached.exp * 1000).toISOString();
      return jwt;
    } catch (error) {
      status.failures += 1;
      status.lastErrorCode = String(error?.code || 'FOMO_PRIVY_SESSION_REQUEST');
      status.requiresReauth = status.lastErrorCode === 'FOMO_PRIVY_REAUTH_REQUIRED';
      throw error;
    }
  }

  return { getJwt, getStatus: () => ({ ...status }) };
}

module.exports = { createAtomicSecretFileStore, createFomoPrivyJwtProvider, jwtMetadata };
