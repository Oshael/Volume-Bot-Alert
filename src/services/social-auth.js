const config = require('../../config');

const PROVIDER_ORDER = ['google', 'discord'];
const PROVIDER_LABELS = {
  google: 'Google',
  discord: 'Discord',
};

function getProviderDefinitions() {
  return PROVIDER_ORDER.map((provider) => {
    const providerConfig = config.socialAuth?.providers?.[provider] || {};
    return {
      provider,
      label: PROVIDER_LABELS[provider] || provider,
      configured: Boolean(providerConfig.configured),
    };
  });
}

function buildIdentitySnapshot(identities, options = {}) {
  const byProvider = new Map(
    (Array.isArray(identities) ? identities : [])
      .map((entry) => [String(entry.provider || '').trim().toLowerCase(), entry])
  );

  return getProviderDefinitions().map((provider) => {
    const linked = byProvider.get(provider.provider) || null;
    return {
      provider: provider.provider,
      label: provider.label,
      configured: provider.configured,
      linked: Boolean(linked),
      providerEmail: linked?.provider_email || null,
      providerEmailVerified: Boolean(linked?.provider_email_verified),
      providerDisplayName: linked?.provider_display_name || null,
      linkedAt: linked?.linked_at || null,
      lastLoginAt: linked?.last_login_at || null,
      canUnlink: Boolean(linked && options.hasPasswordLogin),
      unlinkBlockedReason: linked && !options.hasPasswordLogin
        ? 'Set an account password before unlinking this sign-in method.'
        : null,
    };
  });
}

module.exports = {
  getProviderDefinitions,
  buildIdentitySnapshot,
};
