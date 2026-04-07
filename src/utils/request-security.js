const net = require('net');
const proxyaddr = require('proxy-addr');
const config = require('../../config');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const TRUST_PROXY_SUBNETS = ['loopback', 'linklocal', 'uniquelocal'];
const trustProxy = proxyaddr.compile(TRUST_PROXY_SUBNETS);

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
  } catch (_) {
    return false;
  }

  return false;
}

function normalizeIpValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (raw === '[::1]') {
    return '::1';
  }

  if (raw.startsWith('::ffff:')) {
    const mappedIpv4 = raw.slice(7);
    if (net.isIP(mappedIpv4) === 4) {
      return mappedIpv4;
    }
  }

  return raw;
}

function resolveTrustedIp(reqLike) {
  if (!reqLike) return null;

  try {
    const resolved = proxyaddr(reqLike, trustProxy);
    if (resolved) {
      return normalizeIpValue(resolved);
    }
  } catch (_) {
    // Fall through to direct socket-derived IPs when request shape is partial.
  }

  return normalizeIpValue(
    reqLike.ip
      || reqLike.socket?.remoteAddress
      || reqLike.connection?.remoteAddress
      || reqLike.info?.remoteAddress
      || null
  );
}

function getRequestIp(req) {
  return resolveTrustedIp(req);
}

function getSocketClientIp(socket) {
  return resolveTrustedIp(socket?.request)
    || normalizeIpValue(socket?.handshake?.address)
    || normalizeIpValue(socket?.conn?.remoteAddress)
    || null;
}

module.exports = {
  getRequestIp,
  getSocketClientIp,
  isAllowedOrigin,
  normalizeOriginValue,
  trustProxySetting: [...TRUST_PROXY_SUBNETS],
};
