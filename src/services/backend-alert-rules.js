const HIGH_CAP_DUMP_RULE_KEY = 'high-cap-dump-5m';

const BACKEND_ALERT_RULES = Object.freeze({
  [HIGH_CAP_DUMP_RULE_KEY]: Object.freeze({
    ruleKey: HIGH_CAP_DUMP_RULE_KEY,
    kind: 'high-cap-dump-5m',
    displayName: 'High Cap Dump 5M',
    scope: 'global-token',
    dashboardFeedEnabled: true,
    defaults: Object.freeze({
      windowMinutes: 5,
      thresholdPct: 50,
      minBaselineMcap: 2_000_000,
      maxLatestBucketAgeMs: 90_000,
      minBucketCount: 4,
      rearmRecoveryPct: 85,
      rearmAfterMs: 6 * 60 * 60 * 1000,
    }),
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
  const [firstRule] = listBackendAlertRules({ dashboardFeedEnabled: true });
  return firstRule?.ruleKey || HIGH_CAP_DUMP_RULE_KEY;
}

module.exports = {
  BACKEND_ALERT_RULES,
  HIGH_CAP_DUMP_RULE_KEY,
  getBackendAlertRule,
  getDefaultDashboardAlertRuleKey,
  listBackendAlertRules,
  normalizeBackendAlertRuleKey,
};
