'use strict';

const SAMPLE_SQL = `SELECT NOW() AS observed_at, activity.state,
    activity.wait_event_type, activity.wait_event,
    pg_blocking_pids(activity.pid) AS blocking_pids,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'locktype', lock.locktype, 'mode', lock.mode,
      'relation', lock.relation::regclass::text))
      FROM pg_locks lock WHERE lock.pid=activity.pid AND NOT lock.granted),
      '[]'::jsonb) AS waiting_locks,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'pid', blocker.pid, 'application_name', blocker.application_name,
      'state', blocker.state, 'wait_event_type', blocker.wait_event_type,
      'wait_event', blocker.wait_event,
      'query_age_s', EXTRACT(EPOCH FROM NOW()-blocker.query_start)::int,
      'query', LEFT(REGEXP_REPLACE(blocker.query, '[[:space:]]+', ' ', 'g'), 180)))
      FROM pg_stat_activity blocker
      WHERE blocker.pid=ANY(pg_blocking_pids(activity.pid))),
      '[]'::jsonb) AS blockers
  FROM pg_stat_activity activity WHERE activity.pid=$1`;

function isTimeout(error) {
  return error?.code === '55P03' || error?.code === '57014'
    || /(?:lock|statement) timeout/i.test(String(error?.message || ''));
}

function createTimeoutDiagnostic(database, client, options = {}) {
  const pid = Number(client?.processID);
  const canSample = Number.isSafeInteger(pid) && pid > 0
    && typeof database?.query === 'function';
  const firstSampleMs = options.firstSampleMs ?? 150;
  const repeatSampleMs = options.repeatSampleMs ?? 2000;

  async function run(phase, operation) {
    let timer;
    let pending;
    let sample;
    let blockingSample;
    let samplingError;
    let stopped = false;
    let sampleCount = 0;
    const schedule = (delay) => {
      timer = setTimeout(async () => {
        try {
          pending = database.query(SAMPLE_SQL, [pid]);
          const result = await pending;
          if (result.rows[0]) {
            sample = result.rows[0];
            if (sample.blocking_pids?.length || sample.waiting_locks?.length) {
              blockingSample = sample;
            }
          }
        } catch (error) {
          samplingError = String(error.message || error);
        } finally {
          pending = null;
          sampleCount += 1;
          if (!stopped) schedule(sampleCount < 3 ? 150 : repeatSampleMs);
        }
      }, delay);
      timer.unref?.();
    };
    if (canSample) schedule(firstSampleMs);
    try {
      return await operation();
    } catch (error) {
      if (isTimeout(error)) {
        if (pending) {
          await Promise.race([
            pending.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 100)),
          ]);
        }
        error.retentionTimeoutDiagnostic = {
          phase, sqlState: error.code || null, backendPid: canSample ? pid : null,
          sampled: Boolean(sample),
          ...(blockingSample || sample || {}),
          ...(samplingError ? { samplingError } : {}),
        };
      }
      throw error;
    } finally {
      stopped = true;
      clearTimeout(timer);
    }
  }

  return { run };
}

module.exports = { createTimeoutDiagnostic };
