const config = require('../../config');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

function normalizeOriginValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    return new URL(raw).origin.replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  return LOOPBACK_HOSTS.has(value);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null' && config.nodeEnv === 'development') {
    return true;
  }

  const normalizedOrigin = normalizeOriginValue(origin);
  if (!normalizedOrigin) {
    return false;
  }

  const allowedOrigins = new Set(
    (config.corsOrigins || [])
      .map((value) => normalizeOriginValue(value))
      .filter(Boolean)
  );

  if (allowedOrigins.has(normalizedOrigin)) {
    return true;
  }

  try {
    const parsed = new URL(normalizedOrigin);
    const hostname = parsed.hostname.toLowerCase();

    if (config.nodeEnv === 'development' && isLoopbackHost(hostname)) {
      return true;
    }

    if (hostname === 'volume-bot-alert-frontend.vercel.app') {
      return true;
    }

    if (hostname.endsWith('.vercel.app') && hostname.startsWith('volume-bot-alert-frontend-')) {
      return true;
    }
  } catch (_) {
    return false;
  }

  return false;
}

function extractForwardedIp(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : String(value).split(',')[0];
  const ip = String(raw || '').trim();
  return ip || null;
}

function getRequestIp(req) {
  return extractForwardedIp(req?.headers?.['x-forwarded-for'])
    || String(req?.ip || '').trim()
    || String(req?.socket?.remoteAddress || '').trim()
    || null;
}

function getSocketClientIp(socket) {
  return extractForwardedIp(socket?.handshake?.headers?.['x-forwarded-for'])
    || String(socket?.handshake?.address || '').trim()
    || null;
}

module.exports = {
  getRequestIp,
  getSocketClientIp,
  isAllowedOrigin,
  normalizeOriginValue,
};
