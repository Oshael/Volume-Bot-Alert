const { sanitizeAssetUrl, sanitizeHttpUrl } = require('./url-safety');
const { normalizeXHandle } = require('./x-handle');

const MAX_DESCRIPTION_LENGTH = 280;
const MAX_LOCATION_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

// normalizeText() from url-safety strips every control char, including the
// newlines that give a bio its shape. Keep line breaks, drop the rest.
const BIO_CONTROL_CHARS_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

function normalizeMultilineText(value, maxLength) {
  const raw = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(BIO_CONTROL_CHARS_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return raw ? raw.slice(0, maxLength) : null;
}

function normalizeSingleLineText(value, maxLength) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return raw ? raw.slice(0, maxLength) : null;
}

function normalizeCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
}

function normalizeJoinedAt(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeXProfile(payload, nowMs = Date.now()) {
  const user = payload?.user;
  const handle = normalizeXHandle(user?.screen_name);
  if (!handle) {
    return null;
  }

  const joinedAt = normalizeJoinedAt(user.joined);
  const accountAgeDays = joinedAt && joinedAt.getTime() <= nowMs
    ? Math.floor((nowMs - joinedAt.getTime()) / DAY_MS)
    : null;

  return {
    handle,
    name: normalizeSingleLineText(user.name, MAX_NAME_LENGTH) || handle,
    profileUrl: `https://x.com/${handle}`,
    avatarUrl: sanitizeAssetUrl(user.avatar_url),
    bannerUrl: sanitizeAssetUrl(user.banner_url),
    description: normalizeMultilineText(user.description, MAX_DESCRIPTION_LENGTH),
    location: normalizeSingleLineText(user.location, MAX_LOCATION_LENGTH),
    // X still hands out plain http:// links on profiles; dropping them would
    // silently hide the project website.
    websiteUrl: sanitizeHttpUrl(user.website?.url, { allowHttp: true }),
    verified: user.verification?.verified === true,
    verifiedType: normalizeSingleLineText(user.verification?.type, 32),
    isProtected: user.protected === true,
    followers: normalizeCount(user.followers),
    following: normalizeCount(user.following),
    tweets: normalizeCount(user.tweets),
    joinedAt: joinedAt ? joinedAt.toISOString() : null,
    accountAgeDays,
  };
}

module.exports = {
  normalizeXProfile,
  MAX_DESCRIPTION_LENGTH,
};
