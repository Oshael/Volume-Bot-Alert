const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SUPPORTED_CHAINS = new Set(['solana', 'ethereum', 'bsc', 'base']);

function normalizeText(value, maxLength = 256) {
  const raw = value == null ? '' : String(value);
  const normalized = raw.replace(CONTROL_CHARS_RE, '').trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, Math.max(1, maxLength));
}

function isPrivateIpv4(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return false;
  }

  const octets = value.split('.').map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 0) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  return false;
}

function isPrivateHostname(hostname) {
  const value = String(hostname || '').trim().toLowerCase();
  if (!value) {
    return true;
  }

  if (LOOPBACK_HOSTS.has(value) || value.endsWith('.localhost')) {
    return true;
  }

  if (value.endsWith('.local') || value.endsWith('.internal')) {
    return true;
  }

  if (value.includes(':')) {
    return value === '::1' || value === '[::1]' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd');
  }

  return isPrivateIpv4(value);
}

function sanitizeHttpUrl(value, options = {}) {
  const {
    maxLength = 2048,
    allowHttp = false,
    allowPrivateHosts = false,
  } = options;

  const raw = normalizeText(value, maxLength);
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'https:' && !(allowHttp && protocol === 'http:')) {
      return null;
    }
    if (url.username || url.password) {
      return null;
    }
    if (!allowPrivateHosts && isPrivateHostname(url.hostname)) {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch (_) {
    return null;
  }
}

function sanitizeAssetUrl(value, options = {}) {
  const raw = normalizeText(value, options.maxLength || 2048);
  if (!raw) {
    return null;
  }

  if (raw.startsWith('ipfs://')) {
    const cid = raw.slice('ipfs://'.length).replace(/^\/+/, '');
    if (!cid) {
      return null;
    }
    return sanitizeHttpUrl(`https://ipfs.io/ipfs/${cid}`, options);
  }

  return sanitizeHttpUrl(raw, options);
}

function normalizeChain(value, fallback = 'solana') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return SUPPORTED_CHAINS.has(normalized) ? normalized : fallback;
}

module.exports = {
  normalizeText,
  normalizeChain,
  sanitizeHttpUrl,
  sanitizeAssetUrl,
  isPrivateHostname,
};
