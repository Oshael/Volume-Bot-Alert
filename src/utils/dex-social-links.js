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
  isGenericWebsiteUrl,
  isCoinCommunitiesUrl,
  isCommunityUrl,
  isXCommunityUrl,
  normalizeSocialLinkFields,
};
