const REQUIRED_PORTS = Object.freeze([
  'buildRuleDecision',
  'buildRearmRuleKeys',
  'evaluateLifecycle',
  'evaluateContinuation',
]);

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function validatePorts(ports) {
  for (const name of REQUIRED_PORTS) {
    if (typeof ports[name] !== 'function') {
      throw new TypeError(`Solana alert profile evaluator port is required: ${name}`);
    }
  }
}

function validateInput(input) {
  const profile = requireObject(input.profile, 'profile');
  const tokenAfter = requireObject(input.tokenAfter, 'tokenAfter');
  if (!String(tokenAfter.address || '').trim()) {
    throw new TypeError('tokenAfter.address is required');
  }
  const nowMs = Number(input.nowMs);
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('nowMs must be finite');
  }
  return {
    profile,
    tokenAfter,
    signals: requireObject(input.signals, 'signals'),
    deps: requireObject(input.deps, 'deps'),
    summary: requireObject(input.summary, 'summary'),
    nowMs,
  };
}

function createSolanaAlertProfileEvaluator(ports = {}) {
  validatePorts(ports);

  async function evaluate(input = {}) {
    const context = validateInput(input);
    const ruleDecision = ports.buildRuleDecision(context);
    requireObject(ruleDecision, 'ruleDecision');
    if (!Array.isArray(ruleDecision.candidates)) {
      throw new TypeError('ruleDecision.candidates must be an array');
    }
    if (!Array.isArray(ruleDecision.qualifiedRuleKeys)) {
      throw new TypeError('ruleDecision.qualifiedRuleKeys must be an array');
    }
    const qualifiedRuleKeys = ruleDecision.qualifiedRuleKeys;
    const rearmRuleKeys = ports.buildRearmRuleKeys({
      profile: context.profile,
      qualifiedRuleKeys,
    });
    if (!Array.isArray(rearmRuleKeys)) {
      throw new TypeError('rearmRuleKeys must be an array');
    }

    await ports.evaluateLifecycle({
      ...context,
      candidates: ruleDecision.candidates,
      rearmRuleKeys,
    });
    await ports.evaluateContinuation(context);

    return Object.freeze({
      candidates: Object.freeze([...ruleDecision.candidates]),
      qualifiedRuleKeys: Object.freeze([...qualifiedRuleKeys]),
      rearmRuleKeys: Object.freeze([...rearmRuleKeys]),
    });
  }

  return Object.freeze({ evaluate });
}

module.exports = {
  createSolanaAlertProfileEvaluator,
};
