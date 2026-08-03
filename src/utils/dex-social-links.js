const { sanitizeHttpUrl } = require('./url-safety');

function parseSafeUrl(value) {
  const safeUrl = sanitizeHttpUrl(value);
  if (!safeUrl) {
    return null;
  }
  try {
    return new URL(safeUrl);
  } catch (_) {
    return null;
  }
}

function normalizedHostname(url) {
  return String(url?.hostname || '').toLowerCase().replace(/^www\./, '');
}

function isXCommunityUrl(value) {
  const url = parseSafeUrl(value);
  if (!url) {
    return false;
  }
  const host = normalizedHostname(url);
  return (host === 'x.com' || host === 'twitter.com') && url.pathname.toLowerCase().startsWith('/i/communities/');
}

function isCoinCommunitiesUrl(value) {
  const url = parseSafeUrl(value);
  if (!url) {
    return false;
  }
  return normalizedHostname(url) === 'coincommunities.org'
    && url.pathname.toLowerCase().startsWith('/communities/');
}

function isCommunityUrl(value) {
  return isXCommunityUrl(value) || isCoinCommunitiesUrl(value);
}

function isTwitterProfileUrl(value) {
  const url = parseSafeUrl(value);
  if (!url || isXCommunityUrl(url.toString())) {
    return false;
  }
  const host = normalizedHostname(url);
  return host === 'x.com' || host === 'twitter.com';
}

function isTelegramUrl(value) {
  const url = parseSafeUrl(value);
  if (!url) return false;
  return ['t.me', 'telegram.me'].includes(normalizedHostname(url));
}

function isGenericWebsiteUrl(value) {
  const url = parseSafeUrl(value);
  if (!url || isCommunityUrl(url.toString()) || isTwitterProfileUrl(url.toString())) {
    return false;
  }
  return true;
}

function normalizeEntryUrl(entry) {
  return sanitizeHttpUrl(entry?.url);
}

function firstMatchingUrl(entries, predicate) {
  for (const entry of entries) {
    const url = normalizeEntryUrl(entry);
    if (url && predicate(url, entry)) {
      return url;
    }
  }
  return null;
}

function extractDexSocialLinks(pair) {
  const socials = Array.isArray(pair?.info?.socials) ? pair.info.socials : [];
  const websites = Array.isArray(pair?.info?.websites) ? pair.info.websites : [];

  const twitterUrl = firstMatchingUrl(
    socials,
    (url, entry) => String(entry?.type || '').toLowerCase() === 'twitter' && isTwitterProfileUrl(url),
  );
  const telegramUrl = firstMatchingUrl(
    socials,
    (url, entry) => String(entry?.type || '').toLowerCase() === 'telegram' && isTelegramUrl(url),
  );
  const communityUrl = firstMatchingUrl(socials, isCommunityUrl) || firstMatchingUrl(websites, isCommunityUrl);
  const websiteUrl = firstMatchingUrl(
    websites,
    (url, entry) => {
      const label = String(entry?.label || '').trim().toLowerCase();
      return (label === 'website' || !label) && isGenericWebsiteUrl(url);
    },
  ) || firstMatchingUrl(websites, isGenericWebsiteUrl);

  return {
    twitterUrl,
    telegramUrl,
    communityUrl,
    websiteUrl,
  };
}

// DexScreener Token Profiles expose links as a flat `[{ type, label, url }]`
// array, unlike the pair `info.socials`/`info.websites` split above. This reuses
// the same classification predicates so both feeds agree on how a URL is typed.
function extractTokenProfileSocialLinks(links) {
  const entries = Array.isArray(links) ? links : [];
  const twitterUrl = firstMatchingUrl(
    entries,
    (url, entry) => String(entry?.type || '').toLowerCase() === 'twitter' && isTwitterProfileUrl(url),
  );
  const telegramUrl = firstMatchingUrl(
    entries,
    (url, entry) => String(entry?.type || '').toLowerCase() === 'telegram' && isTelegramUrl(url),
  );
  const communityUrl = firstMatchingUrl(entries, isCommunityUrl);
  const websiteUrl = firstMatchingUrl(
    entries,
    (url, entry) => {
      const type = String(entry?.type || '').trim().toLowerCase();
      const label = String(entry?.label || '').trim().toLowerCase();
      return (type === 'website' || label === 'website' || (!type && !label))
        && isGenericWebsiteUrl(url);
    },
  ) || firstMatchingUrl(entries, isGenericWebsiteUrl);

  return {
    twitterUrl,
    telegramUrl,
    communityUrl,
    websiteUrl,
  };
}

function normalizeSocialLinkFields(fields = {}) {
  const twitterUrl = sanitizeHttpUrl(fields.twitterUrl);
  const communityUrl = sanitizeHttpUrl(fields.communityUrl);
  const websiteUrl = sanitizeHttpUrl(fields.websiteUrl);
  if (isCommunityUrl(twitterUrl)) {
    return {
      twitterUrl: null,
      communityUrl: communityUrl || twitterUrl,
      websiteUrl,
    };
  }
  return {
    twitterUrl,
    communityUrl,
    websiteUrl,
  };
}

module.exports = {
  extractDexSocialLinks,
  extractTokenProfileSocialLinks,
  isGenericWebsiteUrl,
  isCoinCommunitiesUrl,
  isCommunityUrl,
  isXCommunityUrl,
  isTelegramUrl,
  normalizeSocialLinkFields,
};
