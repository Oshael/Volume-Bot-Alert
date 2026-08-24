'use strict';

const { createHash } = require('node:crypto');

const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|auth[-_]?token|access[-_]?token|refresh[-_]?token|jwt|csrf|csrf[-_]?token|x-csrf-token|ct0|session[-_]?token)$/i;

function redactString(value) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/auth_token=[^;\s]+/gi, 'auth_token=[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
}

function sanitizeFomoPayload(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(sanitizeFomoPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, item]) => [key, sanitizeFomoPayload(item)]));
}

function firstText(...values) {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) return normalized;
  }
  return null;
}

function parseStructuredText(value) {
  try { return { payload: JSON.parse(value), protocolPrefix: null }; } catch (_error) {}
  const prefix = /^(\d+)/.exec(value)?.[1];
  const encoded = prefix ? value.slice(prefix.length) : '';
  if (encoded[0] !== '[' && encoded[0] !== '{') return null;
  try { return { payload: JSON.parse(encoded), protocolPrefix: prefix }; } catch (_error) { return null; }
}

function normalizeFomoFrame(raw, options = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  if (options.binary === true) {
    return { frameKind: 'binary', byteLength: bytes.length, fingerprint, payload: null };
  }

  const structured = parseStructuredText(bytes.toString('utf8'));
  if (!structured) {
    return { frameKind: 'opaque', byteLength: bytes.length, fingerprint, payload: null };
  }

  const safe = sanitizeFomoPayload(structured.payload);
  const topic = firstText(Array.isArray(safe) ? safe[0] : null, safe?.topic, safe?.channel, safe?.stream);
  const eventType = firstText(safe?.eventType, safe?.event, safe?.kind, safe?.type);
  const labels = [topic, eventType].filter(Boolean).map((value) => value.toLowerCase());
  return {
    frameKind: 'json',
    byteLength: bytes.length,
    fingerprint,
    protocolPrefix: structured.protocolPrefix,
    topic,
    eventType,
    tradingActivityCandidate: labels.some((value) => value.includes('trading_activity')),
    payload: safe,
  };
}

module.exports = { normalizeFomoFrame, sanitizeFomoPayload };
