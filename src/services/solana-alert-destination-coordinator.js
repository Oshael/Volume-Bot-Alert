const REQUIRED_PORTS = Object.freeze([
  'loadSignals',
  'evaluateDashboardProfile',
]);

function createSolanaAlertDestinationCoordinator(ports = {}) {
  for (const name of REQUIRED_PORTS) {
    if (typeof ports[name] !== 'function') {
      throw new TypeError(`Solana alert destination coordinator port is required: ${name}`);
    }
  }

  async function reportDestinationError(error, phase, context) {
    if (typeof ports.onDestinationError === 'function') {
      await ports.onDestinationError({ error, phase, ...context });
    }
  }

  async function discoverDestinationProfiles(destination, context) {
    if (!destination) return [];
    try {
      if (typeof destination.listSignalProfiles !== 'function') {
        throw new TypeError('Telegram destination listSignalProfiles port is required');
      }
      const profiles = await destination.listSignalProfiles(context);
      if (!Array.isArray(profiles)) {
        throw new TypeError('Telegram destination signal profiles must be an array');
      }
      return profiles;
    } catch (error) {
      await reportDestinationError(error, 'profile-discovery', context);
      return [];
    }
  }

  async function evaluateDashboardProfiles(profiles, context) {
    let evaluated = 0;
    for (const profile of profiles) {
      try {
        await ports.evaluateDashboardProfile({ profile, ...context });
        evaluated += 1;
      } catch (error) {
        if (typeof ports.onDashboardError === 'function') {
          await ports.onDashboardError({ error, profile, ...context });
        }
      }
    }
    return evaluated;
  }

  async function evaluateDestination(destination, profiles, context) {
    if (!destination || !profiles.length) return false;
    try {
      if (typeof destination.evaluate !== 'function') {
        throw new TypeError('Telegram destination evaluate port is required');
      }
      await destination.evaluate({ profiles, ...context });
      return true;
    } catch (error) {
      await reportDestinationError(error, 'evaluation', context);
      return false;
    }
  }

  async function evaluate(input = {}) {
    const dashboardProfiles = Array.isArray(input.dashboardProfiles)
      ? input.dashboardProfiles
      : [];
    const baseContext = {
      tokenBefore: input.tokenBefore || null,
      tokenAfter: input.tokenAfter || null,
      nowMs: input.nowMs,
      alertSource: input.alertSource || null,
      deps: input.deps,
      summary: input.summary,
    };
    const destinationProfiles = await discoverDestinationProfiles(
      input.destination,
      baseContext
    );
    const signalProfiles = [...dashboardProfiles, ...destinationProfiles];
    if (!signalProfiles.length) {
      return Object.freeze({
        dashboardEvaluated: 0,
        destinationEvaluated: false,
        signals: null,
      });
    }

    const signals = await ports.loadSignals({ profiles: signalProfiles, ...baseContext });
    const context = { ...baseContext, signals };
    const dashboardEvaluated = await evaluateDashboardProfiles(dashboardProfiles, context);
    const destinationEvaluated = await evaluateDestination(
      input.destination,
      destinationProfiles,
      context
    );
    return Object.freeze({ dashboardEvaluated, destinationEvaluated, signals });
  }

  return Object.freeze({ evaluate });
}

module.exports = {
  createSolanaAlertDestinationCoordinator,
};
