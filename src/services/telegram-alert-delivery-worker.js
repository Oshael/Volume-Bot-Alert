const deliveryModel = require('../models/telegram-alert-delivery');
const { decideTelegramDeliveryFailure } = require('./telegram-error-policy');

function integer(value, field, fallback, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function requiredText(value, field, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new TypeError(`${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function phaseError(error, code) {
  const wrapped = new Error(String(error?.message || error || code));
  wrapped.name = 'TelegramDeliveryPhaseError';
  wrapped.code = code;
  wrapped.retryable = true;
  return wrapped;
}

function settlementError(error, code = 'delivery_settlement_error') {
  const wrapped = phaseError(error, code);
  wrapped.isSettlementError = true;
  return wrapped;
}

function denial(value) {
  return {
    code: requiredText(value?.code || 'access_denied', 'access denial code', 64),
    message: requiredText(
      value?.message || 'TrendScope access is unavailable',
      'access denial message',
      2000,
    ),
  };
}

function emptySummary(claimed = 0) {
  return {
    claimed,
    sent: 0,
    retry: 0,
    failed: 0,
    cancelled: 0,
    stale: 0,
    errors: 0,
  };
}

function summarize(results, claimed) {
  const summary = emptySummary(claimed);
  for (const status of results) {
    if (Object.hasOwn(summary, status)) summary[status] += 1;
    else summary.errors += 1;
  }
  return Object.freeze(summary);
}

async function mapConcurrent(items, concurrency, task) {
  let nextIndex = 0;
  const results = new Array(items.length);
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await task(items[index]);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

function createClaimHeartbeat(input) {
  let tail = Promise.resolve();
  let failure = null;
  const tick = () => {
    tail = tail.then(async () => {
      if (failure) return;
      const renewed = await input.deliveries.renewClaims({
        ids: [input.delivery.id], owner: input.owner, leaseMs: input.leaseMs,
      });
      const retained = Array.isArray(renewed)
        && renewed.some(({ id }) => String(id) === String(input.delivery.id));
      if (!retained) {
        throw settlementError(
          new Error('Telegram delivery lease was lost during send'),
          'delivery_lease_lost',
        );
      }
    }).catch((error) => {
      failure = error?.isSettlementError ? error : settlementError(error);
    });
  };
  const handle = input.schedule(tick, input.intervalMs);
  handle?.unref?.();
  return {
    async stop() {
      input.cancel(handle);
      await tail;
      if (failure) throw failure;
    },
  };
}

function requireMethods(value, methods, message) {
  if (!value || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(message);
  }
  return value;
}

function requireFunction(value, message) {
  if (typeof value !== 'function') throw new TypeError(message);
  return value;
}

function normalizeOptions(options) {
  const deliveries = options.deliveryModel || deliveryModel;
  const decideFailure = options.decideFailure || decideTelegramDeliveryFailure;
  const now = options.now || Date.now;
  const leaseMs = integer(
    options.leaseMs, 'Telegram delivery lease duration', 60_000, 1_000, 10 * 60_000,
  );
  return {
    deliveries: requireMethods(deliveries, [
      'claimReadyBatch', 'renewClaims', 'markSent', 'scheduleRetry', 'markFailed', 'cancelClaim',
    ], 'Telegram delivery persistence port is required'),
    contexts: requireMethods(
      options.contextSource, ['load'], 'Telegram delivery context source is required',
    ),
    accessGate: requireMethods(
      options.accessGate, ['authorize'], 'Telegram delivery access gate is required',
    ),
    sender: requireMethods(options.sender, ['send'], 'Telegram delivery sender is required'),
    decideFailure: requireFunction(
      decideFailure, 'Telegram delivery worker failure policy is required',
    ),
    now: requireFunction(now, 'Telegram delivery worker clock is required'),
    scheduleHeartbeat: requireFunction(
      options.scheduleHeartbeat || setInterval,
      'Telegram delivery heartbeat scheduler is required',
    ),
    cancelHeartbeat: requireFunction(
      options.cancelHeartbeat || clearInterval,
      'Telegram delivery heartbeat canceller is required',
    ),
    owner: requiredText(options.owner, 'Telegram delivery worker owner', 128),
    batchSize: integer(options.batchSize, 'Telegram delivery batch size', 25, 1, 100),
    concurrency: integer(options.concurrency, 'Telegram delivery concurrency', 4, 1, 20),
    leaseMs,
    renewalIntervalMs: integer(
      options.renewalIntervalMs,
      'Telegram delivery renewal interval',
      Math.max(100, Math.floor(leaseMs / 2)),
      100,
      leaseMs - 1,
    ),
    maxAttempts: integer(options.maxAttempts, 'Telegram delivery attempts', 5, 1, 20),
  };
}

function createTelegramAlertDeliveryWorker(options = {}) {
  const {
    deliveries, contexts, accessGate, sender, decideFailure, now,
    scheduleHeartbeat, cancelHeartbeat, owner, batchSize, concurrency,
    leaseMs, renewalIntervalMs, maxAttempts,
  } = normalizeOptions(options);

  async function report(error, delivery, phase) {
    if (typeof options.onDeliveryError !== 'function') return;
    try {
      await options.onDeliveryError({ error, delivery, phase });
    } catch (_) {}
  }

  async function settle(method, input) {
    try {
      const result = await deliveries[method](input);
      return result ? result.status : 'stale';
    } catch (error) {
      throw settlementError(error);
    }
  }

  async function settleFailure(delivery, error) {
    const decision = decideFailure({
      attempts: delivery.attempts,
      maxAttempts,
      nowMs: Number(now()),
      error,
    });
    if (decision.status === 'retry') {
      return settle('scheduleRetry', {
        id: delivery.id,
        owner,
        nextAttemptAt: decision.nextAttemptAt,
        errorCode: decision.errorCode,
        error: decision.error,
      });
    }
    return settle('markFailed', {
      id: delivery.id,
      owner,
      errorCode: decision.errorCode,
      error: decision.error,
    });
  }

  async function loadContext(delivery) {
    try {
      return await contexts.load({ delivery, owner });
    } catch (error) {
      throw phaseError(error, 'delivery_context_error');
    }
  }

  async function authorize(delivery, context) {
    try {
      return await accessGate.authorize({
        delivery,
        context,
        now: new Date(Number(now())),
      });
    } catch (error) {
      throw phaseError(error, 'access_check_error');
    }
  }

  async function renewLease(delivery) {
    const renewed = await deliveries.renewClaims({ ids: [delivery.id], owner, leaseMs });
    if (!Array.isArray(renewed)) {
      throw new TypeError('Telegram delivery lease renewal must return an array');
    }
    return renewed.some((value) => String(value.id) === String(delivery.id));
  }

  async function sendWithHeartbeat(delivery, input) {
    const heartbeat = createClaimHeartbeat({
      deliveries,
      delivery,
      owner,
      leaseMs,
      intervalMs: renewalIntervalMs,
      schedule: scheduleHeartbeat,
      cancel: cancelHeartbeat,
    });
    let result;
    try {
      result = await sender.send(input);
    } catch (caught) {
      let error = caught;
      try {
        await heartbeat.stop();
      } catch (heartbeatError) {
        error = heartbeatError;
      }
      throw error;
    }
    await heartbeat.stop();
    return result;
  }

  async function deliver(delivery) {
    const context = await loadContext(delivery);
    if (!context) return 'stale';
    const authorization = await authorize(delivery, context);
    if (authorization?.allowed !== true) {
      const denied = denial(authorization);
      return settle('cancelClaim', {
        id: delivery.id,
        owner,
        errorCode: denied.code,
        error: denied.message,
      });
    }
    if (!await renewLease(delivery)) return 'stale';
    const result = await sendWithHeartbeat(delivery, {
      delivery, ...context.senderInput,
    });
    return settle('markSent', {
      id: delivery.id,
      owner,
      messageId: result.messageId,
      fileId: result.fileId,
    });
  }

  async function processDelivery(delivery) {
    try {
      return await deliver(delivery);
    } catch (error) {
      if (error?.isSettlementError) {
        await report(error, delivery, 'settlement');
        return 'errors';
      }
      try {
        return await settleFailure(delivery, error);
      } catch (settlementError) {
        await report(settlementError, delivery, 'settlement');
        return 'errors';
      }
    }
  }

  async function runOnce() {
    const claimed = await deliveries.claimReadyBatch({ owner, limit: batchSize, leaseMs });
    if (!Array.isArray(claimed)) {
      throw new TypeError('Telegram delivery claim must return an array');
    }
    if (!claimed.length) return Object.freeze(emptySummary());
    const results = await mapConcurrent(claimed, concurrency, processDelivery);
    return summarize(results, claimed.length);
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  createTelegramAlertDeliveryWorker,
};
