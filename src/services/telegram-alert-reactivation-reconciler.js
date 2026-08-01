const candidateModel = require('../models/telegram-alert-reactivation-candidate');
const userAccess = require('../models/user-access');
const {
  createTelegramAlertAccessStateRepository,
} = require('../models/telegram-alert-access-state');

function batchSize(value) {
  const parsed = value === undefined ? candidateModel.DEFAULT_LIMIT : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new TypeError('Telegram reactivation batch size must be between 1 and 500');
  }
  return parsed;
}

function checkPort(value, methods, message) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(message);
  }
  return value;
}

function createTelegramAlertReactivationReconciler(options = {}) {
  const candidates = checkPort(
    options.candidateModel || candidateModel,
    ['listWithoutEnabledSolana'],
    'Telegram reactivation candidate source is required',
  );
  const state = checkPort(
    options.stateRepository || createTelegramAlertAccessStateRepository(options),
    ['requestReactivation', 'completeReactivationWithoutEnabledSolana'],
    'Telegram reactivation state repository is required',
  );
  const resolveAccess = options.accessResolver || userAccess.buildResolvedAccessSnapshot;
  if (typeof resolveAccess !== 'function') {
    throw new TypeError('Telegram reactivation access resolver is required');
  }
  const limit = batchSize(options.batchSize);

  async function report(error, candidate) {
    if (typeof options.onCandidateError !== 'function') return;
    try { await options.onCandidateError({ error, candidate }); } catch (_) {}
  }

  async function reconcile(input = {}) {
    const found = await candidates.listWithoutEnabledSolana({ limit });
    if (!Array.isArray(found)) {
      throw new TypeError('Telegram reactivation candidates must be an array');
    }
    const summary = {
      scanned: found.length,
      denied: 0,
      reactivated: 0,
      deferred: 0,
      errors: 0,
    };
    for (const candidate of found) {
      try {
        const access = await resolveAccess(
          candidate.user,
          input.now,
          options.accessDeps || {},
        );
        if (!access?.hasProductAccess) {
          summary.denied += 1;
          continue;
        }
        const pending = await state.requestReactivation({
          connectionId: candidate.connectionId,
          userId: candidate.user.id,
        });
        if (!pending) {
          summary.deferred += 1;
          continue;
        }
        const completed = await state.completeReactivationWithoutEnabledSolana({
          connectionId: candidate.connectionId,
          userId: candidate.user.id,
          requestedAt: pending.requestedAt,
        });
        summary[completed ? 'reactivated' : 'deferred'] += 1;
      } catch (error) {
        summary.errors += 1;
        await report(error, candidate);
      }
    }
    return Object.freeze(summary);
  }

  return Object.freeze({ reconcile });
}

module.exports = {
  createTelegramAlertReactivationReconciler,
};
