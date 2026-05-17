const AUTO_BLOCK_LABEL_PREFIXES = Object.freeze({
  CATALOG_YOUNG_EXTREME_CHURN: 'catalog-volume:young-extreme-churn',
  GMGN_AUTO_JUNK: 'gmgn-auto-junk',
  GMGN_INFO_LOW_MCAP_HIGH_HOLDERS: 'gmgn-info:low-mcap-high-holders',
  GMGN_KLINE_STAIRCASE_PUMP: 'gmgn-kline:staircase-pump',
  GMGN_NEW_NON_PUMP_HIGH_LAUNCH_MCAP: 'gmgn-origin:new-non-pump-high-launch-mcap',
  GMGN_SECURITY_TOP10_HOLDER_RATE: 'gmgn-security:top10-holder-rate',
  GMGN_VOLUME_LOW_MCAP_EXTREME_VOL5M: 'gmgn-volume:low-mcap-extreme-vol5m',
  RISK_REVIEW_AUTO_JUNK_PROBABLE: 'auto-junk-probable',
});

const AUTO_BLOCK_REASON_CODES = Object.freeze({
  GMGN_CONFIRMED_MICRO_LIQUIDITY: 'gmgn_confirmed_micro_liquidity',
  GMGN_CONCENTRATED_STRUCTURE: 'gmgn_concentrated_structure',
  GMGN_HOLDER_COUNT_MCAP_ANOMALY: 'gmgn_holder_count_mcap_anomaly',
  GMGN_LOW_MCAP_EXTREME_24H_CHURN_THIN_LIQUIDITY: 'gmgn_low_mcap_extreme_24h_churn_thin_liquidity',
  GMGN_LOW_MCAP_THIN_SUPPORT: 'gmgn_low_mcap_thin_support',
  GMGN_UNPROTECTED_LIQUIDITY: 'gmgn_unprotected_liquidity',
  GMGN_YOUNG_EXTREME_CHURN: 'gmgn_young_extreme_churn',
  GMGN_YOUNG_LOW_CAP_HIGH_CHURN_THIN_LIQUIDITY: 'gmgn_young_low_cap_high_churn_thin_liquidity',
  LOW_LIQUIDITY_UNDER_1K: 'low_liquidity_under_1k',
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
