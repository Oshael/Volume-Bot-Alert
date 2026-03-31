const config = require('../../config');

const PROVIDER_ENDPOINTS = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
  },
  discord: {
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userinfoUrl: 'https://discord.com/api/users/@me',
  },
};

function getProviderConfig(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  const providerConfig = config.socialAuth?.providers?.[normalized] || null;
  const endpoints = PROVIDER_ENDPOINTS[normalized] || null;
  if (!providerConfig || !endpoints) {
    return null;
  }
  return {
    provider: normalized,
    ...providerConfig,
    ...endpoints,
  };
}

function normalizeFlow(flow) {
  return String(flow || '').trim().toLowerCase() === 'login'
    ? 'login'
    : 'link';
}

function buildRedirectUri(provider, flow) {
  const base = String(
    config.socialAuth?.callbackBaseUrl
    || config.socialAuth?.appBaseUrl
    || ''
  ).trim().replace(/\/+$/, '');
  const normalizedFlow = normalizeFlow(flow);
  return normalizedFlow === 'login'
    ? `${base}/api/auth/social/${provider}/login/callback`
    : `${base}/api/auth/social/${provider}/callback`;
}

function buildAuthorizationUrl(provider, state, flow) {
  const providerConfig = getProviderConfig(provider);
  if (!providerConfig) {
    throw Object.assign(new Error('Unsupported social provider'), { status: 400 });
  }
  if (!providerConfig.configured) {
    throw Object.assign(new Error(`${providerConfig.provider} OAuth is not configured`), { status: 503 });
  }

  const url = new URL(providerConfig.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', providerConfig.clientId);
  url.searchParams.set('redirect_uri', buildRedirectUri(providerConfig.provider, flow));
  url.searchParams.set('scope', providerConfig.scopes.join(' '));
  url.searchParams.set('state', state);

  if (providerConfig.provider === 'google') {
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent select_account');
  }

  if (providerConfig.provider === 'discord') {
    url.searchParams.set('prompt', 'consent');
  }

  return url.toString();
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function exchangeCodeForAccessToken(provider, code, flow) {
  const providerConfig = getProviderConfig(provider);
  if (!providerConfig) {
    throw Object.assign(new Error('Unsupported social provider'), { status: 400 });
  }

  const body = new URLSearchParams({
    code: String(code || '').trim(),
    client_id: providerConfig.clientId,
    client_secret: providerConfig.clientSecret,
    redirect_uri: buildRedirectUri(providerConfig.provider, flow),
    grant_type: 'authorization_code',
  });

  const response = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw Object.assign(new Error(`OAuth token exchange failed for ${providerConfig.provider}`), {
      status: 502,
      details: payload,
    });
  }

  const accessToken = String(payload.access_token || '').trim();
  if (!accessToken) {
    throw Object.assign(new Error(`OAuth token exchange returned no access token for ${providerConfig.provider}`), {
      status: 502,
      details: payload,
    });
  }

  return accessToken;
}

async function fetchProviderIdentity(provider, accessToken) {
  const providerConfig = getProviderConfig(provider);
  if (!providerConfig) {
    throw Object.assign(new Error('Unsupported social provider'), { status: 400 });
  }

  const response = await fetch(providerConfig.userinfoUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw Object.assign(new Error(`OAuth userinfo fetch failed for ${providerConfig.provider}`), {
      status: 502,
      details: payload,
    });
  }

  if (providerConfig.provider === 'google') {
    return {
      provider: 'google',
      providerUserId: String(payload.sub || '').trim(),
      providerEmail: String(payload.email || '').trim().toLowerCase() || null,
      providerEmailVerified: Boolean(payload.email_verified),
      providerDisplayName: String(payload.name || payload.email || '').trim() || null,
      metadata: {
        picture: payload.picture || null,
      },
    };
  }

  return {
    provider: 'discord',
    providerUserId: String(payload.id || '').trim(),
    providerEmail: String(payload.email || '').trim().toLowerCase() || null,
    providerEmailVerified: Boolean(payload.verified),
    providerDisplayName: String(payload.global_name || payload.username || payload.email || '').trim() || null,
    metadata: {
      username: payload.username || null,
      globalName: payload.global_name || null,
      avatar: payload.avatar || null,
    },
  };
}

module.exports = {
  getProviderConfig,
  buildRedirectUri,
  buildAuthorizationUrl,
  exchangeCodeForAccessToken,
  fetchProviderIdentity,
};
