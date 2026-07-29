const { sanitizeHttpUrl } = require('./url-safety');

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const X_HOSTS = new Set(['x.com', 'twitter.com']);

// Paths served by X itself, never a profile.
const RESERVED_SEGMENTS = new Set([
  'i', 'home', 'explore', 'search', 'settings', 'notifications', 'messages',
  'compose', 'intent', 'share', 'hashtag', 'login', 'signup', 'about',
]);

function normalizeXHandle(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^@+/, '');
  if (!HANDLE_RE.test(raw)) {
    return null;
  }
  if (RESERVED_SEGMENTS.has(raw.toLowerCase())) {
    return null;
  }
  return raw;
}

function extractXHandleFromUrl(value) {
  const safeUrl = sanitizeHttpUrl(value);
  if (!safeUrl) {
    return null;
  }

  let url;
  try {
    url = new URL(safeUrl);
  } catch (_) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!X_HOSTS.has(host)) {
    return null;
  }

  const [segment] = url.pathname.split('/').filter(Boolean);
  return normalizeXHandle(segment);
}

module.exports = {
  normalizeXHandle,
  extractXHandleFromUrl,
};
