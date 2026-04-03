export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHttpUrl(value: unknown, fallback = '#') {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return fallback;
  }

  try {
    const url = new URL(raw);
    const protocol = url.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:') {
      return url.toString();
    }
  } catch (_) {
    return fallback;
  }

  return fallback;
}

export function sanitizeAssetUrl(value: unknown, fallback = '') {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return fallback;
  }

  try {
    const url = new URL(raw);
    const protocol = url.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'data:' || protocol === 'blob:') {
      return url.toString();
    }
  } catch (_) {
    return fallback;
  }

  return fallback;
}

export function sanitizeOptionalHttpUrl(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }

  const sanitized = sanitizeHttpUrl(raw, '');
  return sanitized || null;
}
