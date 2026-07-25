const AUTO_BLOCK_LABEL_PREFIXES = Object.freeze({
  CATALOG_LIQUIDITY_UNDER_1K_48H: 'catalog-liquidity:under-1k-48h',
  CATALOG_SPAM_TICKER_LAUNCH: 'catalog-ticker:spam-launch',
  CATALOG_YOUNG_EXTREME_CHURN: 'catalog-volume:young-extreme-churn',
  GMGN_AUTO_JUNK: 'gmgn-auto-junk',
  GMGN_INFO_LOW_MCAP_HIGH_HOLDERS: 'gmgn-info:low-mcap-high-holders',
  GMGN_KLINE_STAIRCASE_PUMP: 'gmgn-kline:staircase-pump',
  GMGN_LIQUIDITY_BAD_STATUS_MCAP_BAND: 'gmgn-liquidity:bad-status-mcap-band',
  GMGN_LIQUIDITY_UNDER_1K_SPAM: 'gmgn-liquidity:under-1k-spam',
  GMGN_NEW_NON_PUMP_HIGH_LAUNCH_MCAP: 'gmgn-origin:new-non-pump-high-launch-mcap',
  GMGN_SECURITY_TOP10_HOLDER_RATE: 'gmgn-security:top10-holder-rate',
  GMGN_SECURITY_TOP20_HOLDER_RATE: 'gmgn-security:top20-holder-rate',
  GMGN_VOLUME_LOW_MCAP_EXTREME_VOL5M: 'gmgn-volume:low-mcap-extreme-vol5m',
  RISK_REVIEW_AUTO_JUNK_PROBABLE: 'auto-junk-probable',
});

const AUTO_BLOCK_REASON_CODES = Object.freeze({
  GMGN_CONCENTRATED_STRUCTURE: 'gmgn_concentrated_structure',
  GMGN_HOLDER_COUNT_MCAP_ANOMALY: 'gmgn_holder_count_mcap_anomaly',
  GMGN_YOUNG_EXTREME_CHURN: 'gmgn_young_extreme_churn',
  NEW_LOW_MCAP_EXTREME_VOL5M_CHURN: 'new_low_mcap_extreme_vol5m_churn',
});

function buildPrefixedAutoBlockLabel(prefix, parts = []) {
  const suffix = (Array.isArray(parts) ? parts : [parts])
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  return suffix.length ? `${prefix}:${suffix.join(':')}` : prefix;
}

function buildCommaSuffixAutoBlockLabel(prefix, reasonCodes = [], limit = 3) {
  const suffix = (Array.isArray(reasonCodes) ? reasonCodes : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, limit)
    .join(',');
  return suffix ? `${prefix}:${suffix}` : prefix;
}

module.exports = {
  AUTO_BLOCK_LABEL_PREFIXES,
  AUTO_BLOCK_REASON_CODES,
  buildCommaSuffixAutoBlockLabel,
  buildPrefixedAutoBlockLabel,
};
