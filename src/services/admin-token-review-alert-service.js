const adminTokenReviewAlert = require('../models/admin-token-review-alert');
const dexscreener = require('./dexscreener');
const { extractDexSocialLinks, normalizeSocialLinkFields } = require('../utils/dex-social-links');

const ALERT_KIND_SOCIALS_PRESENT = 'manual-review-socials-present';

function normalizeReasonCodes(assessment = {}) {
  return Array.isArray(assessment.reasonCodes)
    ? assessment.reasonCodes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function hasSocialEvidence(snapshot = {}) {
  return Boolean(snapshot.twitterUrl || snapshot.communityUrl || snapshot.websiteUrl);
}

function shouldCreateManualReviewSocialAlert(label, assessment) {
  return String(label || '').trim().toLowerCase() === 'junk_probable'
    && assessment?.manualReviewRequired === true
    && assessment?.autoBlock !== true;
}

function buildSocialSnapshot(address, pair) {
  const links = extractDexSocialLinks(pair);
  return {
    address: String(address || '').trim() || null,
    dexId: pair?.dexId || null,
    pairAddress: pair?.pairAddress || null,
    pairUrl: pair?.url || null,
    imageUrl: pair?.info?.imageUrl || null,
    twitterUrl: links.twitterUrl || null,
    communityUrl: links.communityUrl || null,
    websiteUrl: links.websiteUrl || null,
  };
}

function buildCatalogSocialSnapshot(row = {}) {
  const links = normalizeSocialLinkFields({
    twitterUrl: row.last_twitter_url,
    communityUrl: row.last_community_url,
  });
  return {
    address: String(row.address || '').trim() || null,
    dexId: null,
    pairAddress: row.last_pair_address || null,
    pairUrl: row.last_pair_url || null,
    imageUrl: row.last_image_url || null,
    twitterUrl: links.twitterUrl || null,
    communityUrl: links.communityUrl || null,
    websiteUrl: links.websiteUrl || null,
  };
}

function resolvePriority(row = {}, assessment = {}, socialSnapshot = {}) {
  const marketCap = Number(assessment.marketCap ?? row.last_mcap);
  const hasWebsite = Boolean(socialSnapshot.websiteUrl);
  const hasTwitter = Boolean(socialSnapshot.twitterUrl);
  if ((hasWebsite || hasTwitter) && Number.isFinite(marketCap) && marketCap >= 400000) {
    return 'high';
  }
  return hasSocialEvidence(socialSnapshot) ? 'normal' : 'low';
}

async function fetchSocialSnapshot(address, deps = {}) {
  const dex = deps.dexscreenerService || dexscreener;
  const data = await dex.getTokenPairs(address, { priority: 'low-activity' });
  const pair = dex.getBestPair(data, 'solana');
  if (!pair) {
    return null;
  }
  return buildSocialSnapshot(address, pair);
}

async function maybeEnqueueManualReviewSocialAlert({
  row,
  label,
  assessment,
  marketSnapshot,
  riskSnapshot,
  meteoraSnapshot,
}, deps = {}) {
  const address = String(row?.address || '').trim();
  if (!address || !shouldCreateManualReviewSocialAlert(label, assessment)) {
    return null;
  }

  let socialSnapshot = buildCatalogSocialSnapshot(row);
  if (!hasSocialEvidence(socialSnapshot)) {
    if (deps.skipDexLookup === true) {
      return null;
    }
    try {
      socialSnapshot = await fetchSocialSnapshot(address, deps);
    } catch (err) {
      if (deps.logErrors === true) {
        console.warn(`[AdminTokenReviewAlert] Failed to fetch social metadata for ${address}: ${err.message}`);
      }
      return null;
    }
  }

  if (!hasSocialEvidence(socialSnapshot)) {
    return null;
  }

  const alertModel = deps.adminTokenReviewAlertModel || adminTokenReviewAlert;
  return alertModel.enqueue({
    tokenAddress: address,
    alertKind: ALERT_KIND_SOCIALS_PRESENT,
    priority: resolvePriority(row, assessment, socialSnapshot),
    pipeline: 'risk-review-sync',
    label: `auto-review:${label}`,
    reasonCodes: normalizeReasonCodes(assessment),
    assessment,
    socialSnapshot,
    marketSnapshot,
    riskSnapshot,
    meteoraSnapshot,
    notes: 'On-chain risk requires manual review and Dex social metadata is present.',
  });
}

module.exports = {
  ALERT_KIND_SOCIALS_PRESENT,
  buildSocialSnapshot,
  buildCatalogSocialSnapshot,
  fetchSocialSnapshot,
  hasSocialEvidence,
  maybeEnqueueManualReviewSocialAlert,
  shouldCreateManualReviewSocialAlert,
  __private: {
    normalizeReasonCodes,
    resolvePriority,
  },
};
