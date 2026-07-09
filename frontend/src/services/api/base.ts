import {
  API_RESPONSE_DEBUG_EVENT,
  readApiResponseMetadata,
  shouldEmitApiResponseDebug,
  type ApiResponseMetadata,
} from './response-metadata';
import {
  ApiRateLimitBackoffError,
  getApiRateLimitBackoffRemainingMs,
  noteApiRateLimitResponse,
  type ApiRateLimitScope,
} from './rate-limit-backoff';

const PROD_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '')
  || 'https://api.trendscope.pro';
const PROD_API_ORIGIN = new URL(PROD_API_BASE).origin.toLowerCase();

function stripTrailingSlashes(value: string) {
  return value.replace(/\/+$/, '');
}

function isLoopbackHost(hostname: string) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1';
}

function getLocationOrigin(locationLike: Location) {
  if (locationLike.origin) {
    return locationLike.origin;
  }
  return `${locationLike.protocol}//${locationLike.host}`;
}

function resolveApiOverride(override: string, locationLike: Location) {
  const raw = String(override || '').trim();
  if (!raw) {
    return null;
  }

  try {
    const currentOrigin = getLocationOrigin(locationLike);
    const url = new URL(raw, currentOrigin);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return null;
    }

    url.hash = '';
    url.search = '';

    const targetOrigin = url.origin.toLowerCase();
    const isLocalPage = isLoopbackHost(locationLike.hostname);
    const isAllowedLoopback = isLocalPage && isLoopbackHost(url.hostname);
    if (
      targetOrigin !== PROD_API_ORIGIN
      && targetOrigin !== currentOrigin.toLowerCase()
      && !isAllowedLoopback
    ) {
      return null;
    }

    return stripTrailingSlashes(url.toString());
  } catch (_) {
    return null;
  }
}

export function resolveApiBase(locationLike: Location = window.location): string {
  if (import.meta.env.DEV) {
    return getLocationOrigin(locationLike);
  }

  const params = new URLSearchParams(locationLike.search);
  const override = params.get('api');
  if (override) {
    const resolvedOverride = resolveApiOverride(override, locationLike);
    if (resolvedOverride) {
      return resolvedOverride;
    }
  }

  return PROD_API_BASE;
}

export interface ApiFetchOptions extends RequestInit {
  token?: string | null;
  onResponse?: (metadata: ApiResponseMetadata) => void;
  rateLimitScope?: ApiRateLimitScope;
}

function emitApiResponseDebug(path: string, init: RequestInit | undefined, metadata: ApiResponseMetadata) {
  if (typeof window === 'undefined' || !shouldEmitApiResponseDebug(metadata)) {
    return;
  }

  try {
    window.dispatchEvent(new CustomEvent(API_RESPONSE_DEBUG_EVENT, {
      detail: {
        path,
        method: String(init?.method || 'GET').toUpperCase(),
        response: metadata,
      },
    }));
  } catch (_) {
    // Debug-only response observers must not affect API requests.
  }
}

function assertApiRateLimitBackoffInactive(scope?: ApiRateLimitScope) {
  if (!scope) {
    return;
  }

  const backoffRemainingMs = getApiRateLimitBackoffRemainingMs(scope);
  if (backoffRemainingMs > 0) {
    throw new ApiRateLimitBackoffError(scope, backoffRemainingMs);
  }
}

function observeApiResponse(
  path: string,
  requestInit: RequestInit,
  metadata: ApiResponseMetadata,
  onResponse?: (metadata: ApiResponseMetadata) => void,
) {
  if (onResponse) {
    try {
      onResponse(metadata);
    } catch (_) {
      // Debug-only response observers must not affect API requests.
    }
    return;
  }

  emitApiResponseDebug(path, requestInit, metadata);
}

async function readApiErrorMessage(response: Response) {
  let message = `API request failed: ${response.status}`;
  try {
    const body = await response.json() as { error?: string; retryAfterSeconds?: number };
    if (body?.error) {
      message = body.error;
    }
    if (body?.retryAfterSeconds) {
      message = `${message} Try again in ${body.retryAfterSeconds}s.`;
    }
  } catch (_) {
    // Keep fallback message.
  }
  return message;
}

async function throwApiResponseError(
  response: Response,
  rateLimitScope: ApiRateLimitScope | undefined,
  rateLimitBackoffMs: number,
): Promise<never> {
  const message = await readApiErrorMessage(response);
  if (response.status === 429 && rateLimitScope) {
    throw new ApiRateLimitBackoffError(rateLimitScope, rateLimitBackoffMs, message);
  }
  throw new Error(message);
}

export async function apiFetch<T>(path: string, init?: ApiFetchOptions): Promise<T> {
  const headers = new Headers(init?.headers || {});
  const { onResponse, rateLimitScope, ...requestInit } = init || {};
  assertApiRateLimitBackoffInactive(rateLimitScope);

  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    const apiBase = resolveApiBase();
    response = await fetch(`${apiBase}${path}`, {
      ...requestInit,
      cache: 'no-store',
      credentials: 'include',
      headers,
    });
  } catch (error) {
    const message = error instanceof Error && error.message
      ? `Network error: ${error.message}`
      : 'Network error: unable to reach API';
    throw new Error(message);
  }

  const responseMetadata = readApiResponseMetadata(response);
  const rateLimitBackoffMs = rateLimitScope
    ? noteApiRateLimitResponse(rateLimitScope, responseMetadata)
    : 0;
  observeApiResponse(path, requestInit, responseMetadata, onResponse);

  if (!response.ok) {
    return throwApiResponseError(response, rateLimitScope, rateLimitBackoffMs);
  }

  return response.json() as Promise<T>;
}
