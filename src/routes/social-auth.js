const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../../config');
const User = require('../models/user');
const Session = require('../models/session');
const UserSocialIdentity = require('../models/user-social-identity');
const { authenticate } = require('../middleware/auth');
const userAccess = require('../models/user-access');
const { clearAuthCookie, createAuthenticatedSession } = require('../services/auth-session');
const { clearPreAccessCookie, issuePreAccessFlow, isBillingRecoveryAccess, isHardBlockedAccess } = require('../services/pre-access-session');
const {
  issueSocialLinkState,
  issueSocialLoginState,
  readSocialLinkCookie,
  readSocialLoginCookie,
  clearSocialLinkCookie,
  clearSocialLoginCookie,
  verifySocialLinkState,
  normalizeReturnTo,
  buildSocialLinkRedirect,
} = require('../services/social-link-session');
const {
  getProviderConfig,
  buildAuthorizationUrl,
  exchangeCodeForAccessToken,
  fetchProviderIdentity,
} = require('../services/social-oauth');

const router = express.Router();
const SOCIAL_LINK_RESULT_STORAGE_KEY = 'trend_scope_social_link_result';
const SOCIAL_LINK_RESULT_MESSAGE_TYPE = 'trend_scope_social_link_result';
const SOCIAL_LINK_BRIDGE_SCRIPT_PATH = '/api/auth/social/popup-bridge.js';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getProviderLabel(provider) {
  return provider === 'discord' ? 'Discord' : 'Google';
}

function buildSocialLinkPopupBridgeScript() {
  return `'use strict';

(function socialLinkBridge() {
  const root = document.querySelector('[data-social-link-bridge]');
  if (!root) {
    return;
  }

  const provider = String(root.getAttribute('data-provider') || '').trim();
  const status = String(root.getAttribute('data-status') || '').trim();
  const redirectUrl = String(root.getAttribute('data-redirect-url') || '').trim();
  const appOrigin = String(root.getAttribute('data-app-origin') || '').trim();

  if (!provider || !status || !redirectUrl || !appOrigin) {
    return;
  }

  const payload = {
    type: ${JSON.stringify(SOCIAL_LINK_RESULT_MESSAGE_TYPE)},
    provider,
    status,
  };

  let redirected = false;

  function fallbackRedirect() {
    if (redirected) return;
    redirected = true;
    window.location.replace(redirectUrl);
  }

  try {
    window.localStorage.setItem(
      ${JSON.stringify(SOCIAL_LINK_RESULT_STORAGE_KEY)},
      JSON.stringify({ status: payload.status, provider: payload.provider, ts: Date.now() })
    );
  } catch (_) {
    // Ignore localStorage failures and keep the popup flow moving.
  }

  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, appOrigin);
    }
  } catch (_) {
    // Ignore opener messaging failures and keep the popup flow moving.
  }

  let closeAttempts = 0;
  function tryClose() {
    closeAttempts += 1;
    try {
      window.close();
    } catch (_) {
      // Ignore close failures and retry a few times before redirect fallback.
    }
    if (window.closed) {
      return;
    }
    if (closeAttempts >= 6 || !window.opener || window.opener.closed) {
      fallbackRedirect();
      return;
    }
    window.setTimeout(tryClose, closeAttempts < 2 ? 80 : 180);
  }

  window.setTimeout(tryClose, 40);
}());`;
}

function buildSocialLinkPopupBridge(path, provider, code) {
  const redirectUrl = buildSocialLinkRedirect(path, {
    socialLink: code,
    socialProvider: provider,
  });
  const appOrigin = new URL(redirectUrl).origin;
  const providerLabel = getProviderLabel(provider);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(providerLabel)} Linking</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07111d; color: #e9f1ff; font-family: Arial, sans-serif; }
      main { width: min(92vw, 520px); padding: 32px; border-radius: 20px; background: #0f1b2b; border: 1px solid #214064; }
      h1 { margin: 0 0 12px; font-size: 28px; }
      p { margin: 0; color: #b8c9e2; line-height: 1.6; }
      a { color: #00f58c; font-weight: 700; }
    </style>
  </head>
  <body>
    <main
      data-social-link-bridge
      data-provider="${escapeHtml(provider)}"
      data-status="${escapeHtml(code)}"
      data-redirect-url="${escapeHtml(redirectUrl)}"
      data-app-origin="${escapeHtml(appOrigin)}"
    >
      <h1>${escapeHtml(providerLabel)} linking complete</h1>
      <p>This window should close automatically. If it stays open, <a href="${escapeHtml(redirectUrl)}">return to the app</a>.</p>
    </main>
    <script src="${SOCIAL_LINK_BRIDGE_SCRIPT_PATH}" defer></script>
  </body>
</html>`;
}

function sendSocialLinkPopupResult(res, path, provider, code) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buildSocialLinkPopupBridge(path, provider, code));
}

router.get('/popup-bridge.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buildSocialLinkPopupBridgeScript());
});

async function readAuthenticatedUserFromCookie(req) {
  const token = req.cookies?.[config.authCookie.name] || null;
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    const sessionValid = await Session.isValid(token);
    if (!sessionValid) {
      return null;
    }

    const user = await User.findById(decoded.userId);
    if (!user || !user.is_active) {
      return null;
    }

    return {
      token,
      user,
      sessionId: Session.getSessionIdentity(token, decoded),
    };
  } catch (_) {
    return null;
  }
}

function buildErrorRedirect(path, provider, code) {
  return buildSocialLinkRedirect(path, {
    socialLink: code,
    socialProvider: provider,
  });
}

function buildLoginRedirect(path, provider, code) {
  return buildSocialLinkRedirect(path, {
    socialLogin: code,
    socialProvider: provider,
  });
}

function normalizeAuthenticatedSocialLoginReturnTo(path) {
  const normalized = normalizeReturnTo(path);
  return normalized === '/login'
    || normalized.startsWith('/login/')
    || normalized === '/access'
    || normalized.startsWith('/access/')
    ? '/alerts'
    : normalized;
}

function buildSocialLoginBlockedCode(user, access) {
  if (!user?.is_active) {
    return 'deactivated';
  }
  if (isHardBlockedAccess(access)) {
    return 'revoked';
  }
  if (!user?.is_email_verified) {
    return 'email_unverified';
  }
  return 'blocked';
}

router.get('/:provider/start', authenticate, async (req, res) => {
  try {
    const provider = UserSocialIdentity.normalizeProvider(req.params.provider);
    const providerConfig = getProviderConfig(provider);
    if (!providerConfig) {
      return res.status(400).json({ error: 'Unsupported social provider' });
    }
    if (!providerConfig.configured) {
      return res.status(503).json({ error: `${providerConfig.provider} OAuth is not configured` });
    }

    const returnTo = normalizeReturnTo(req.query?.returnTo);
    const state = issueSocialLinkState({
      userId: req.user.id,
      provider,
      sessionId: req.sessionId,
      returnTo,
      res,
    });

    return res.redirect(302, buildAuthorizationUrl(provider, state, 'link'));
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Social auth start error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:provider/login/start', async (req, res) => {
  try {
    const provider = UserSocialIdentity.normalizeProvider(req.params.provider);
    const providerConfig = getProviderConfig(provider);
    const returnTo = normalizeReturnTo(req.query?.returnTo);

    if (!providerConfig) {
      return res.redirect(302, buildLoginRedirect(returnTo, provider || 'google', 'unsupported_provider'));
    }
    if (!providerConfig.configured) {
      return res.redirect(302, buildLoginRedirect(returnTo, provider, 'provider_unavailable'));
    }

    const state = issueSocialLoginState({
      provider,
      returnTo,
      res,
    });

    return res.redirect(302, buildAuthorizationUrl(provider, state, 'login'));
  } catch (err) {
    console.error('Social login start error:', err);
    return res.redirect(302, buildLoginRedirect('/alerts', 'google', 'start_error'));
  }
});

router.get('/:provider/callback', async (req, res) => {
  const provider = UserSocialIdentity.normalizeProvider(req.params.provider);
  const stateParam = String(req.query?.state || '').trim();
  const code = String(req.query?.code || '').trim();
  const providerError = String(req.query?.error || '').trim();
  const providerConfig = getProviderConfig(provider);
  const cookieState = readSocialLinkCookie(req);

  if (!provider || !providerConfig) {
    return res.status(400).json({ error: 'Unsupported social provider' });
  }

  if (!cookieState || !stateParam || cookieState !== stateParam) {
    clearSocialLinkCookie(res);
    return sendSocialLinkPopupResult(res, '/alerts', provider, 'state_mismatch');
  }

  let decodedState;
  try {
    decodedState = verifySocialLinkState(cookieState);
  } catch (_) {
    clearSocialLinkCookie(res);
    return sendSocialLinkPopupResult(res, '/alerts', provider, 'state_invalid');
  }

  const returnTo = normalizeReturnTo(decodedState.returnTo);

  if (decodedState.type !== 'social_link' || decodedState.provider !== provider) {
    clearSocialLinkCookie(res);
    return sendSocialLinkPopupResult(res, returnTo, provider, 'state_invalid');
  }

  if (providerError) {
    clearSocialLinkCookie(res);
    return sendSocialLinkPopupResult(res, returnTo, provider, 'provider_denied');
  }

  if (!code) {
    clearSocialLinkCookie(res);
    return sendSocialLinkPopupResult(res, returnTo, provider, 'missing_code');
  }

  try {
    const authSession = await readAuthenticatedUserFromCookie(req);
    if (!authSession) {
      clearSocialLinkCookie(res);
      return sendSocialLinkPopupResult(res, returnTo, provider, 'session_missing');
    }

    if (authSession.user.id !== decodedState.userId || authSession.sessionId !== decodedState.sessionId) {
      clearSocialLinkCookie(res);
      return sendSocialLinkPopupResult(res, returnTo, provider, 'session_mismatch');
    }

    const accessToken = await exchangeCodeForAccessToken(provider, code, 'link');
    const identity = await fetchProviderIdentity(provider, accessToken);

    if (!identity.providerUserId) {
      clearSocialLinkCookie(res);
      return sendSocialLinkPopupResult(res, returnTo, provider, 'identity_missing');
    }

    const existingIdentity = await UserSocialIdentity.findByProviderIdentity(provider, identity.providerUserId);
    if (existingIdentity && existingIdentity.user_id !== authSession.user.id) {
      clearSocialLinkCookie(res);
      return sendSocialLinkPopupResult(res, returnTo, provider, 'identity_conflict');
    }

    if (identity.providerEmail) {
      const emailOwner = await User.findByEmail(identity.providerEmail);
      if (emailOwner && emailOwner.id !== authSession.user.id) {
        clearSocialLinkCookie(res);
        return sendSocialLinkPopupResult(res, returnTo, provider, 'email_conflict');
      }
    }

    await UserSocialIdentity.upsertLinkForUser(authSession.user.id, provider, identity);
    clearSocialLinkCookie(res);
    return sendSocialLinkPopupResult(res, returnTo, provider, 'success');
  } catch (err) {
    clearSocialLinkCookie(res);
    console.error('Social auth callback error:', err);
    return sendSocialLinkPopupResult(res, returnTo, provider, 'callback_error');
  }
});

router.get('/:provider/login/callback', async (req, res) => {
  const provider = UserSocialIdentity.normalizeProvider(req.params.provider);
  const stateParam = String(req.query?.state || '').trim();
  const code = String(req.query?.code || '').trim();
  const providerError = String(req.query?.error || '').trim();
  const providerConfig = getProviderConfig(provider);
  const cookieState = readSocialLoginCookie(req);

  if (!provider || !providerConfig) {
    return res.status(400).json({ error: 'Unsupported social provider' });
  }

  if (!cookieState || !stateParam || cookieState !== stateParam) {
    clearSocialLoginCookie(res);
    return res.redirect(302, buildLoginRedirect('/alerts', provider, 'state_mismatch'));
  }

  let decodedState;
  try {
    decodedState = verifySocialLinkState(cookieState);
  } catch (_) {
    clearSocialLoginCookie(res);
    return res.redirect(302, buildLoginRedirect('/alerts', provider, 'state_invalid'));
  }

  const returnTo = normalizeReturnTo(decodedState.returnTo);

  if (decodedState.type !== 'social_login' || decodedState.provider !== provider) {
    clearSocialLoginCookie(res);
    return res.redirect(302, buildLoginRedirect(returnTo, provider, 'state_invalid'));
  }

  if (providerError) {
    clearSocialLoginCookie(res);
    return res.redirect(302, buildLoginRedirect(returnTo, provider, 'provider_denied'));
  }

  if (!code) {
    clearSocialLoginCookie(res);
    return res.redirect(302, buildLoginRedirect(returnTo, provider, 'missing_code'));
  }

  try {
    const accessToken = await exchangeCodeForAccessToken(provider, code, 'login');
    const identity = await fetchProviderIdentity(provider, accessToken);

    if (!identity.providerUserId) {
      clearSocialLoginCookie(res);
      return res.redirect(302, buildLoginRedirect(returnTo, provider, 'identity_missing'));
    }

    const linkedIdentity = await UserSocialIdentity.findByProviderIdentity(provider, identity.providerUserId);
    if (!linkedIdentity) {
      clearSocialLoginCookie(res);
      return res.redirect(302, buildLoginRedirect(returnTo, provider, 'not_linked'));
    }

    const user = await User.findById(linkedIdentity.user_id);
    const access = user ? userAccess.buildAccessSnapshot(user) : null;
    if (!user || !user.is_active || !user.is_email_verified || isHardBlockedAccess(access)) {
      clearAuthCookie(res);
      clearPreAccessCookie(res);
      clearSocialLoginCookie(res);
      return res.redirect(302, buildLoginRedirect(returnTo, provider, buildSocialLoginBlockedCode(user, access)));
    }

    await UserSocialIdentity.markLastLogin(linkedIdentity.id);

    if (access.hasProductAccess) {
      clearPreAccessCookie(res);
      clearSocialLoginCookie(res);
      await createAuthenticatedSession({
        user,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        res,
      });
      return res.redirect(302, buildLoginRedirect(normalizeAuthenticatedSocialLoginReturnTo(returnTo), provider, 'success'));
    }

    if (isBillingRecoveryAccess(access)) {
      clearAuthCookie(res);
      clearSocialLoginCookie(res);
      issuePreAccessFlow({ user, res });
      return res.redirect(302, buildLoginRedirect('/access', provider, 'success'));
    }

    clearAuthCookie(res);
    clearPreAccessCookie(res);
    clearSocialLoginCookie(res);
    return res.redirect(302, buildLoginRedirect(returnTo, provider, 'blocked'));
  } catch (err) {
    clearAuthCookie(res);
    clearPreAccessCookie(res);
    clearSocialLoginCookie(res);
    console.error('Social login callback error:', err);
    return res.redirect(302, buildLoginRedirect(returnTo, provider, 'callback_error'));
  }
});

module.exports = router;
