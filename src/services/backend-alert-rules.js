const GMGN_CLAIM_SIGNAL_RULE_KEY = 'gmgn-claim-signal';
const MONITORED_VOL_RULE_KEY = 'monitored-vol';
const GMGN_VOL_1M_RULE_KEY = 'gmgn-vol-1m';
const MONITORED_MCAP_RULE_KEY = 'monitored-mcap';
const MONITORED_FDV_RULE_KEY = 'monitored-fdv';
const HVNC_RULE_KEY = 'hvnc';
const RECENT_SURGE_1H_RULE_KEY = 'recent-surge-1h';
const RECENT_SURGE_6H_RULE_KEY = 'recent-surge-6h';
const OLD_WEEK_SURGE_1H_RULE_KEY = 'old-week-surge-1h';
const OLD_WEEK_SURGE_6H_RULE_KEY = 'old-week-surge-6h';
const SURGE_CONTINUATION_6H_RULE_KEY = 'surge-continuation-6h';
const METEORA_SURGE_RULE_KEY = 'meteora-surge';
const CUSTOM_ALERT_RULE_KEY = 'custom-alert';
const ROBINHOOD_HVNC_V2_RULE_KEY = 'robinhood-hvnc-v2';

const BACKEND_ALERT_RULES = Object.freeze({
  [GMGN_CLAIM_SIGNAL_RULE_KEY]: Object.freeze({
    ruleKey: GMGN_CLAIM_SIGNAL_RULE_KEY,
    kind: 'gmgn-claim-signal',
    displayName: 'GMGN Claim Signal',
    scope: 'global-signal',
    dashboardFeedEnabled: true,
    historicalReplayEnabled: false,
    defaults: Object.freeze({
      maxAlertsPerToken: 2,
      minMcapUsd: 4000,
      signalTypes: Object.freeze([17, 18]),
    }),
  }),
  [MONITORED_VOL_RULE_KEY]: Object.freeze({
    ruleKey: MONITORED_VOL_RULE_KEY,
    kind: 'monitored-vol',
    displayName: 'Monitored Vol 5M',
    scope: 'user-token',
    chains: Object.freeze(['solana', 'robinhood']),
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [GMGN_VOL_1M_RULE_KEY]: Object.freeze({
    ruleKey: GMGN_VOL_1M_RULE_KEY,
    kind: 'monitored-vol',
    displayName: 'GMGN Vol 1M',
    scope: 'user-token',
    dashboardFeedEnabled: true,
    defaults: Object.freeze({
      thresholdPct: 50,
      cooldownMs: 60 * 1000,
      repeatStepPct: 50,
    }),
  }),
  [MONITORED_MCAP_RULE_KEY]: Object.freeze({
    ruleKey: MONITORED_MCAP_RULE_KEY,
    kind: 'monitored-mcap',
    displayName: 'Monitored MCap 5M',
    scope: 'user-token',
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [MONITORED_FDV_RULE_KEY]: Object.freeze({
    ruleKey: MONITORED_FDV_RULE_KEY,
    kind: 'monitored-fdv',
    displayName: 'Monitored FDV 5M',
    scope: 'user-token',
    chain: 'robinhood',
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [HVNC_RULE_KEY]: Object.freeze({
    ruleKey: HVNC_RULE_KEY,
    kind: 'hvnc',
    displayName: 'HVNC',
    scope: 'user-token',
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [RECENT_SURGE_1H_RULE_KEY]: Object.freeze({
    ruleKey: RECENT_SURGE_1H_RULE_KEY,
    kind: 'old-surge',
    displayName: 'Recent Surge 1H',
    scope: 'user-token',
    chains: Object.freeze(['solana', 'robinhood']),
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [RECENT_SURGE_6H_RULE_KEY]: Object.freeze({
    ruleKey: RECENT_SURGE_6H_RULE_KEY,
    kind: 'old-surge',
    displayName: 'Recent Surge 6H',
    scope: 'user-token',
    chains: Object.freeze(['solana', 'robinhood']),
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [OLD_WEEK_SURGE_1H_RULE_KEY]: Object.freeze({
    ruleKey: OLD_WEEK_SURGE_1H_RULE_KEY,
    kind: 'old-surge',
    displayName: 'Old Week Surge 1H',
    scope: 'user-token',
    chains: Object.freeze(['solana', 'robinhood']),
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [OLD_WEEK_SURGE_6H_RULE_KEY]: Object.freeze({
    ruleKey: OLD_WEEK_SURGE_6H_RULE_KEY,
    kind: 'old-surge',
    displayName: 'Old Week Surge 6H',
    scope: 'user-token',
    chains: Object.freeze(['solana', 'robinhood']),
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [SURGE_CONTINUATION_6H_RULE_KEY]: Object.freeze({
    ruleKey: SURGE_CONTINUATION_6H_RULE_KEY,
    kind: 'old-surge',
    displayName: 'Surge Continuation 6H',
    scope: 'user-token',
    chains: Object.freeze(['solana', 'robinhood']),
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [METEORA_SURGE_RULE_KEY]: Object.freeze({
    ruleKey: METEORA_SURGE_RULE_KEY,
    kind: 'meteora-surge',
    displayName: 'Meteora Surge 1H',
    scope: 'user-token',
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [CUSTOM_ALERT_RULE_KEY]: Object.freeze({
    ruleKey: CUSTOM_ALERT_RULE_KEY,
    kind: 'custom-alert',
    displayName: 'Custom Alert',
    scope: 'user-token',
    chains: Object.freeze(['solana', 'robinhood']),
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
  [ROBINHOOD_HVNC_V2_RULE_KEY]: Object.freeze({
    ruleKey: ROBINHOOD_HVNC_V2_RULE_KEY,
    kind: 'hvnc',
    displayName: 'Robinhood HVNC',
    scope: 'user-token',
    chain: 'robinhood',
    dashboardFeedEnabled: true,
    defaults: Object.freeze({}),
  }),
});

function normalizeBackendAlertRuleKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

function getBackendAlertRule(value) {
  const ruleKey = normalizeBackendAlertRuleKey(value);
  if (!ruleKey) {
    return null;
  }

  return BACKEND_ALERT_RULES[ruleKey] || null;
}

function listBackendAlertRules(filters = {}) {
  let rules = Object.values(BACKEND_ALERT_RULES);

  if (filters.dashboardFeedEnabled === true) {
    rules = rules.filter((rule) => rule.dashboardFeedEnabled);
  }

  return rules;
}

function getDefaultDashboardAlertRuleKey() {
  return GMGN_CLAIM_SIGNAL_RULE_KEY;
}

module.exports = {
  BACKEND_ALERT_RULES,
  CUSTOM_ALERT_RULE_KEY,
  GMGN_CLAIM_SIGNAL_RULE_KEY,
  GMGN_VOL_1M_RULE_KEY,
  HVNC_RULE_KEY,
  METEORA_SURGE_RULE_KEY,
  MONITORED_FDV_RULE_KEY,
  MONITORED_MCAP_RULE_KEY,
  MONITORED_VOL_RULE_KEY,
  OLD_WEEK_SURGE_1H_RULE_KEY,
  OLD_WEEK_SURGE_6H_RULE_KEY,
  RECENT_SURGE_1H_RULE_KEY,
  RECENT_SURGE_6H_RULE_KEY,
  ROBINHOOD_HVNC_V2_RULE_KEY,
  getBackendAlertRule,
  getDefaultDashboardAlertRuleKey,
  listBackendAlertRules,
  normalizeBackendAlertRuleKey,
};
