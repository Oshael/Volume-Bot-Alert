const issuedAuthorizations = new WeakSet();

function issueAutomaticAlertPublicationAuthorization(input = {}) {
  const chain = String(input.chain || '').trim().toLowerCase();
  if (chain !== 'robinhood') {
    throw new Error('Automatic alert publication authorization requires Robinhood');
  }
  if (input.alertsRequested !== true || input.publishable !== true) {
    const error = new Error('Automatic alert publication is not authorized by rollout');
    error.code = 'AUTOMATIC_ALERT_PUBLICATION_DISABLED';
    throw error;
  }

  const authorization = Object.freeze({ chain, issuedAt: Date.now() });
  issuedAuthorizations.add(authorization);
  return authorization;
}

function assertAutomaticAlertPublicationAuthorized(authorization, chain) {
  if (!authorization || !issuedAuthorizations.has(authorization) || authorization.chain !== chain) {
    const error = new Error('Automatic alerts are disabled outside Solana');
    error.code = 'NON_SOLANA_ALERT_TRIGGER_DISABLED';
    throw error;
  }
}

module.exports = {
  assertAutomaticAlertPublicationAuthorized,
  issueAutomaticAlertPublicationAuthorization,
};
