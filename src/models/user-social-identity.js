const { query } = require('./db');

const ALLOWED_PROVIDERS = new Set(['google', 'discord']);

function normalizeProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ALLOWED_PROVIDERS.has(normalized) ? normalized : '';
}

const UserSocialIdentity = {
  normalizeProvider,

  async listByUserId(userId) {
    const { rows } = await query(
      `SELECT id, user_id, provider, provider_user_id, provider_email, provider_email_verified,
              provider_display_name, linked_at, last_login_at, updated_at
       FROM user_social_identities
       WHERE user_id = $1
       ORDER BY linked_at ASC`,
      [userId]
    );
    return rows;
  },

  async findByUserAndProvider(userId, provider) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) {
      return null;
    }

    const { rows } = await query(
      `SELECT id, user_id, provider, provider_user_id, provider_email, provider_email_verified,
              provider_display_name, linked_at, last_login_at, updated_at
       FROM user_social_identities
       WHERE user_id = $1 AND provider = $2
       LIMIT 1`,
      [userId, normalizedProvider]
    );
    return rows[0] || null;
  },

  async findByProviderIdentity(provider, providerUserId) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedProviderUserId = String(providerUserId || '').trim();
    if (!normalizedProvider || !normalizedProviderUserId) {
      return null;
    }

    const { rows } = await query(
      `SELECT id, user_id, provider, provider_user_id, provider_email, provider_email_verified,
              provider_display_name, linked_at, last_login_at, updated_at
       FROM user_social_identities
       WHERE provider = $1 AND provider_user_id = $2
       LIMIT 1`,
      [normalizedProvider, normalizedProviderUserId]
    );
    return rows[0] || null;
  },

  async upsertLinkForUser(userId, provider, identity) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedProviderUserId = String(identity?.providerUserId || '').trim();
    if (!normalizedProvider || !normalizedProviderUserId) {
      throw Object.assign(new Error('Invalid social identity payload'), { status: 400 });
    }

    const providerEmail = String(identity?.providerEmail || '').trim().toLowerCase() || null;
    const providerDisplayName = String(identity?.providerDisplayName || '').trim() || null;
    const providerEmailVerified = Boolean(identity?.providerEmailVerified);
    const metadata = identity?.metadata && typeof identity.metadata === 'object'
      ? identity.metadata
      : {};

    const existing = await this.findByUserAndProvider(userId, normalizedProvider);
    let rows;

    if (existing) {
      ({ rows } = await query(
        `UPDATE user_social_identities
         SET provider_user_id = $3,
             provider_email = $4,
             provider_email_verified = $5,
             provider_display_name = $6,
             metadata = $7::jsonb,
             updated_at = NOW()
         WHERE user_id = $1 AND provider = $2
         RETURNING id, user_id, provider, provider_user_id, provider_email, provider_email_verified,
                   provider_display_name, linked_at, last_login_at, updated_at`,
        [
          userId,
          normalizedProvider,
          normalizedProviderUserId,
          providerEmail,
          providerEmailVerified,
          providerDisplayName,
          JSON.stringify(metadata),
        ]
      ));
    } else {
      ({ rows } = await query(
        `INSERT INTO user_social_identities (
          user_id,
          provider,
          provider_user_id,
          provider_email,
          provider_email_verified,
          provider_display_name,
          metadata,
          linked_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
        RETURNING id, user_id, provider, provider_user_id, provider_email, provider_email_verified,
                  provider_display_name, linked_at, last_login_at, updated_at`,
        [
          userId,
          normalizedProvider,
          normalizedProviderUserId,
          providerEmail,
          providerEmailVerified,
          providerDisplayName,
          JSON.stringify(metadata),
        ]
      ));
    }

    return rows[0] || null;
  },

  async markLastLogin(id) {
    const { rows } = await query(
      `UPDATE user_social_identities
       SET last_login_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, user_id, provider, provider_user_id, provider_email, provider_email_verified,
                 provider_display_name, linked_at, last_login_at, updated_at`,
      [id]
    );
    return rows[0] || null;
  },

  async removeLinkForUser(userId, provider) {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) {
      return null;
    }

    const { rows } = await query(
      `DELETE FROM user_social_identities
       WHERE user_id = $1 AND provider = $2
       RETURNING id, user_id, provider, provider_user_id, provider_email, provider_email_verified,
                 provider_display_name, linked_at, last_login_at, updated_at`,
      [userId, normalizedProvider]
    );
    return rows[0] || null;
  },
};

module.exports = UserSocialIdentity;
