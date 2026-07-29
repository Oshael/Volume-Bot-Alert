const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeXProfile } = require('../src/utils/x-profile-normalize');
const { normalizeXHandle, extractXHandleFromUrl } = require('../src/utils/x-handle');

// Captured from api.fxtwitter.com/pipedog_.
function buildPayload(overrides = {}) {
  return {
    code: 200,
    user: {
      screen_name: 'pipedog_',
      name: 'pipedog',
      description: 'this pipedog\nhe has pipe\nhe has question',
      location: 'Robinhood',
      followers: 10924,
      following: 12,
      tweets: 7,
      joined: 'Wed Jul 15 01:18:25 +0000 2026',
      protected: false,
      avatar_url: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png',
      banner_url: 'https://pbs.twimg.com/profile_banners/2077200744386633728/1785269702',
      website: { url: 'http://pipedog.xyz' },
      verification: { verified: true, type: 'individual' },
      ...overrides,
    },
  };
}

const NOW = Date.parse('2026-07-28T00:00:00.000Z');

describe('X handle extraction', () => {
  it('reads the handle from a stored profile URL', () => {
    assert.equal(extractXHandleFromUrl('https://x.com/pipedog_'), 'pipedog_');
    assert.equal(extractXHandleFromUrl('https://www.twitter.com/pipedog_/status/123'), 'pipedog_');
  });

  it('rejects community links and X-owned paths that are not profiles', () => {
    assert.equal(extractXHandleFromUrl('https://x.com/i/communities/1234'), null);
    assert.equal(extractXHandleFromUrl('https://x.com/search?q=abc'), null);
    assert.equal(extractXHandleFromUrl('https://example.com/pipedog_'), null);
  });

  it('rejects handles outside the X character and length rules', () => {
    assert.equal(normalizeXHandle('@pipedog_'), 'pipedog_');
    assert.equal(normalizeXHandle('a'.repeat(16)), null);
    assert.equal(normalizeXHandle('bad-handle'), null);
    assert.equal(normalizeXHandle(''), null);
  });
});

describe('X profile normalization', () => {
  it('maps the upstream payload into the card contract', () => {
    const profile = normalizeXProfile(buildPayload(), NOW);

    assert.equal(profile.handle, 'pipedog_');
    assert.equal(profile.name, 'pipedog');
    assert.equal(profile.profileUrl, 'https://x.com/pipedog_');
    assert.equal(profile.followers, 10924);
    assert.equal(profile.following, 12);
    assert.equal(profile.location, 'Robinhood');
    assert.equal(profile.verified, true);
    assert.equal(profile.joinedAt, '2026-07-15T01:18:25.000Z');
    assert.equal(profile.accountAgeDays, 12);
  });

  it('keeps bio line breaks that url-safety normalizeText would strip', () => {
    const profile = normalizeXProfile(buildPayload(), NOW);
    assert.equal(profile.description, 'this pipedog\nhe has pipe\nhe has question');
  });

  it('keeps plain http project websites instead of dropping them', () => {
    const profile = normalizeXProfile(buildPayload(), NOW);
    assert.equal(profile.websiteUrl, 'http://pipedog.xyz/');
  });

  it('drops asset and website URLs that are not safe to render', () => {
    const profile = normalizeXProfile(buildPayload({
      avatar_url: 'javascript:alert(1)',
      banner_url: 'http://127.0.0.1/banner.png',
      website: { url: 'javascript:alert(1)' },
    }), NOW);

    assert.equal(profile.avatarUrl, null);
    assert.equal(profile.bannerUrl, null);
    assert.equal(profile.websiteUrl, null);
  });

  it('truncates an oversized bio and strips control characters', () => {
    const bell = String.fromCharCode(7);
    const profile = normalizeXProfile(buildPayload({
      description: `${bell}${'a'.repeat(400)}`,
    }), NOW);

    assert.equal(profile.description.length, 280);
    assert.ok(!profile.description.includes(bell));
  });

  it('returns null when the payload carries no usable handle', () => {
    assert.equal(normalizeXProfile({ code: 404, message: 'User not found' }, NOW), null);
    assert.equal(normalizeXProfile(buildPayload({ screen_name: 'bad-handle' }), NOW), null);
  });

  it('leaves account age unset when the join date is missing or in the future', () => {
    assert.equal(normalizeXProfile(buildPayload({ joined: null }), NOW).accountAgeDays, null);
    assert.equal(normalizeXProfile(buildPayload({ joined: 'not a date' }), NOW).joinedAt, null);
    assert.equal(
      normalizeXProfile(buildPayload({ joined: 'Wed Jul 15 01:18:25 +0000 2027' }), NOW).accountAgeDays,
      null
    );
  });
});
