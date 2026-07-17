const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractDexSocialLinks,
  isCommunityUrl,
  isTelegramUrl,
  normalizeSocialLinkFields,
} = require('../src/utils/dex-social-links');

describe('Dex social link extraction', () => {
  it('separates an official X profile from a CoinCommunities website link', () => {
    const links = extractDexSocialLinks({
      info: {
        socials: [{ type: 'twitter', url: 'https://x.com/example' }],
        websites: [{ label: 'CC', url: 'https://coincommunities.org/communities/token123' }],
      },
    });

    assert.equal(links.twitterUrl, 'https://x.com/example');
    assert.equal(links.communityUrl, 'https://coincommunities.org/communities/token123');
    assert.equal(links.websiteUrl, null);
  });

  it('extracts a generic project website without treating it as a community link', () => {
    const links = extractDexSocialLinks({
      info: {
        socials: [{ type: 'twitter', url: 'https://x.com/nestusd' }],
        websites: [{ label: 'Website', url: 'https://nestusd.com/' }],
      },
    });

    assert.equal(links.twitterUrl, 'https://x.com/nestusd');
    assert.equal(links.communityUrl, null);
    assert.equal(links.websiteUrl, 'https://nestusd.com/');
  });

  it('keeps X communities out of the official profile URL', () => {
    const links = extractDexSocialLinks({
      info: {
        socials: [
          { type: 'twitter', url: 'https://x.com/i/communities/123456' },
          { type: 'twitter', url: 'https://x.com/example' },
        ],
      },
    });

    assert.equal(links.twitterUrl, 'https://x.com/example');
    assert.equal(links.communityUrl, 'https://x.com/i/communities/123456');
  });

  it('extracts only canonical Telegram links from Dex social metadata', () => {
    const links = extractDexSocialLinks({
      info: {
        socials: [
          { type: 'telegram', url: 'https://example.com/fake' },
          { type: 'telegram', url: 'https://t.me/example' },
        ],
      },
    });

    assert.equal(links.telegramUrl, 'https://t.me/example');
    assert.equal(isTelegramUrl('https://telegram.me/example'), true);
    assert.equal(isTelegramUrl('https://example.com/t.me/example'), false);
  });

  it('recognizes supported community URL formats', () => {
    assert.equal(isCommunityUrl('https://x.com/i/communities/123'), true);
    assert.equal(isCommunityUrl('https://twitter.com/i/communities/123'), true);
    assert.equal(isCommunityUrl('https://coincommunities.org/communities/token123'), true);
    assert.equal(isCommunityUrl('https://coincommunities.org/about'), false);
  });

  it('moves legacy X community links out of the profile field', () => {
    const links = normalizeSocialLinkFields({
      twitterUrl: 'https://x.com/i/communities/2009233131614724602',
      communityUrl: null,
    });

    assert.equal(links.twitterUrl, null);
    assert.equal(links.communityUrl, 'https://x.com/i/communities/2009233131614724602');
  });
});
