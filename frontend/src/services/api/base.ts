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
}

export async function apiFetch<T>(path: string, init?: ApiFetchOptions): Promise<T> {
  const headers = new Headers(init?.headers || {});

  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${resolveApiBase()}${path}`, {
      ...init,
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

  if (!response.ok) {
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
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}
