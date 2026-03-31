const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../../config');

function setSocialLinkCookie(res, token, expiresAt) {
  setSocialCookie(res, config.socialAuth.linkCookie, token, expiresAt);
}

function setSocialLoginCookie(res, token, expiresAt) {
  setSocialCookie(res, config.socialAuth.loginCookie, token, expiresAt);
}

function setSocialCookie(res, cookieConfig, token, expiresAt) {
  res.cookie(cookieConfig.name, token, {
    httpOnly: true,
    secure: cookieConfig.secure,
    sameSite: cookieConfig.sameSite,
    domain: cookieConfig.domain,
    path: '/',
    expires: expiresAt,
  });
}

function clearSocialLinkCookie(res) {
  clearSocialCookie(res, config.socialAuth.linkCookie);
}

function clearSocialLoginCookie(res) {
  clearSocialCookie(res, config.socialAuth.loginCookie);
}

function clearSocialCookie(res, cookieConfig) {
  res.clearCookie(cookieConfig.name, {
    httpOnly: true,
    secure: cookieConfig.secure,
    sameSite: cookieConfig.sameSite,
    domain: cookieConfig.domain,
    path: '/',
  });
}

function normalizeReturnTo(value) {
  const raw = String(value || '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/alerts';
  }
  if (raw.startsWith('/api/') || raw.startsWith('/auth/')) {
    return '/alerts';
  }
  return raw;
}

function issueSocialLinkState({ userId, provider, sessionId, returnTo, res }) {
  const expiresMinutes = Math.max(5, Number.parseInt(config.socialAuth.linkCookie.expiresMinutes || 10, 10) || 10);
  const expiresAt = new Date(Date.now() + (expiresMinutes * 60 * 1000));
  const state = jwt.sign(
    {
      type: 'social_link',
      nonce: crypto.randomUUID(),
      userId,
      provider,
      sessionId,
      returnTo: normalizeReturnTo(returnTo),
    },
    config.jwt.secret,
    { expiresIn: `${expiresMinutes}m` }
  );

  setSocialLinkCookie(res, state, expiresAt);
  return state;
}

function issueSocialLoginState({ provider, returnTo, res }) {
  const expiresMinutes = Math.max(5, Number.parseInt(config.socialAuth.loginCookie.expiresMinutes || 10, 10) || 10);
  const expiresAt = new Date(Date.now() + (expiresMinutes * 60 * 1000));
  const state = jwt.sign(
    {
      type: 'social_login',
      nonce: crypto.randomUUID(),
      provider,
      returnTo: normalizeReturnTo(returnTo),
    },
    config.jwt.secret,
    { expiresIn: `${expiresMinutes}m` }
  );

  setSocialLoginCookie(res, state, expiresAt);
  return state;
}

function readSocialLinkCookie(req) {
  return req.cookies?.[config.socialAuth.linkCookie.name] || null;
}

function readSocialLoginCookie(req) {
  return req.cookies?.[config.socialAuth.loginCookie.name] || null;
}

function verifySocialLinkState(token) {
  return jwt.verify(token, config.jwt.secret);
}

function buildSocialLinkRedirect(path, params) {
  const base = config.socialAuth.appBaseUrl || '';
  const pathname = normalizeReturnTo(path);
  const url = new URL(`${base}${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

module.exports = {
  setSocialLinkCookie,
  setSocialLoginCookie,
  clearSocialLinkCookie,
  clearSocialLoginCookie,
  normalizeReturnTo,
  issueSocialLinkState,
  issueSocialLoginState,
  readSocialLinkCookie,
  readSocialLoginCookie,
  verifySocialLinkState,
  buildSocialLinkRedirect,
};
