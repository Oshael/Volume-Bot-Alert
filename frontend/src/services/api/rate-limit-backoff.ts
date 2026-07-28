import type { ApiResponseMetadata } from './response-metadata';

export type ApiRateLimitScope = 'dashboard' | 'market-ticker';

const API_RATE_LIMIT_BACKOFF_MIN_MS = 1000;
const API_RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60 * 1000;

const backoffUntilByScope = new Map<ApiRateLimitScope, number>();

function clampBackoffMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(API_RATE_LIMIT_BACKOFF_MAX_MS, Math.max(API_RATE_LIMIT_BACKOFF_MIN_MS, Math.ceil(value)));
}

function parseRetryAfterMs(value: string | null, now: number) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 0;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : 0;
}

function parseRateLimitResetMs(value: string | null) {
  const seconds = Number(String(value || '').trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

export class ApiRateLimitBackoffError extends Error {
  readonly scope: ApiRateLimitScope;
  readonly retryAfterMs: number;

  constructor(scope: ApiRateLimitScope, retryAfterMs: number, message?: string) {
    const retryAfterSeconds = Math.ceil(Math.max(0, retryAfterMs) / 1000);
    const scopeLabel = scope === 'market-ticker' ? 'Market ticker' : 'Dashboard';
    super(message || `${scopeLabel} requests are paused by rate limit backoff for ${retryAfterSeconds}s.`);
    this.name = 'ApiRateLimitBackoffError';
    this.scope = scope;
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

export function isApiRateLimitBackoffError(error: unknown): error is ApiRateLimitBackoffError {
  return error instanceof ApiRateLimitBackoffError
    || (
      Boolean(error)
      && typeof error === 'object'
      && (error as { name?: unknown }).name === 'ApiRateLimitBackoffError'
    );
}

export function clearApiRateLimitBackoff(scope?: ApiRateLimitScope) {
  if (scope) {
    backoffUntilByScope.delete(scope);
    return;
  }
  backoffUntilByScope.clear();
}

export function getApiRateLimitBackoffRemainingMs(scope: ApiRateLimitScope, now = Date.now()) {
  const until = backoffUntilByScope.get(scope) || 0;
  const remaining = Math.max(0, until - now);
  if (remaining <= 0) {
    backoffUntilByScope.delete(scope);
  }
  return remaining;
}

export function getApiRateLimitResponseBackoffMs(metadata: ApiResponseMetadata, now = Date.now()) {
  const retryAfterMs = parseRetryAfterMs(metadata.retryAfter, now);
  if (retryAfterMs > 0) {
    return clampBackoffMs(retryAfterMs);
  }

  const remaining = Number(metadata.rateLimitRemaining);
  const resetMs = parseRateLimitResetMs(metadata.rateLimitReset);
  if (metadata.status === 429 && resetMs > 0) {
    return clampBackoffMs(resetMs);
  }
  if (Number.isFinite(remaining) && remaining <= 0 && resetMs > 0) {
    return clampBackoffMs(resetMs);
  }

  return 0;
}

export function noteApiRateLimitResponse(
  scope: ApiRateLimitScope,
  metadata: ApiResponseMetadata,
  now = Date.now(),
) {
  const backoffMs = getApiRateLimitResponseBackoffMs(metadata, now);
  if (backoffMs <= 0) {
    return 0;
  }

  const currentUntil = backoffUntilByScope.get(scope) || 0;
  const nextUntil = Math.max(currentUntil, now + backoffMs);
  backoffUntilByScope.set(scope, nextUntil);
  return Math.max(0, nextUntil - now);
}
