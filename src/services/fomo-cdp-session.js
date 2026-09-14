'use strict';

const DEFAULT_CDP_DETACH_TIMEOUT_MS = 5_000;

function positiveInteger(value, fallback, max = 60_000) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

async function detachCdpSession(session, options = {}) {
  if (typeof session?.detach !== 'function') {
    return { ok: true, timedOut: false, errorCode: null };
  }
  const timeoutMs = positiveInteger(
    options.timeoutMs, DEFAULT_CDP_DETACH_TIMEOUT_MS,
  );
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  let timeoutHandle = null;
  const detachResult = Promise.resolve().then(() => session.detach()).then(
    () => ({ ok: true, timedOut: false, errorCode: null }),
    (error) => ({
      ok: false,
      timedOut: false,
      errorCode: String(error?.code || 'FOMO_BROWSER_DETACH'),
    }),
  );
  const timeoutResult = new Promise((resolve) => {
    timeoutHandle = schedule(() => resolve({
      ok: false,
      timedOut: true,
      errorCode: 'FOMO_BROWSER_DETACH_TIMEOUT',
    }), timeoutMs);
    timeoutHandle?.unref?.();
  });
  const result = await Promise.race([detachResult, timeoutResult]);
  if (timeoutHandle != null) cancelSchedule(timeoutHandle);
  return result;
}

module.exports = { DEFAULT_CDP_DETACH_TIMEOUT_MS, detachCdpSession };
