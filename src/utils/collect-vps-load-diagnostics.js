const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_SAMPLES = 120;
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'diagnostics');

let dbModule = null;

function getDb() {
  if (!dbModule) {
    dbModule = require('../models/db');
  }
  return dbModule;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    intervalMs: DEFAULT_INTERVAL_MS,
    samples: DEFAULT_SAMPLES,
    output: '',
    noDb: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    if (item === '--interval-ms' && next) {
      args.intervalMs = Math.max(1000, Number.parseInt(next, 10) || DEFAULT_INTERVAL_MS);
      index += 1;
    } else if (item === '--samples' && next) {
      args.samples = Math.max(1, Number.parseInt(next, 10) || DEFAULT_SAMPLES);
      index += 1;
    } else if (item === '--output' && next) {
      args.output = next;
      index += 1;
    } else if (item === '--no-db') {
      args.noDb = true;
    }
  }

  if (!args.output) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    args.output = path.join(DEFAULT_OUTPUT_DIR, `vps-load-${stamp}.jsonl`);
  }

  return args;
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    const done = (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        error: error ? String(error.message || error) : null,
        stderr: String(stderr || '').trim(),
        stdout: String(stdout || ''),
      });
    };

    try {
      child = execFile(file, args, {
        timeout: options.timeoutMs || 3000,
        maxBuffer: 1024 * 1024 * 4,
      }, done);
    } catch (err) {
      done(err);
      return;
    }

    child.once('error', done);
  });
}

function readFileText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function safeUptimeSeconds() {
  try {
    return os.uptime();
  } catch (_) {
    return null;
  }
}

function safeCpuCount() {
  try {
    return os.cpus().length;
  } catch (_) {
    return null;
  }
}

function parseLoadAverage() {
  const raw = readFileText('/proc/loadavg');
  if (!raw) {
    return os.loadavg();
  }
  const parts = raw.trim().split(/\s+/);
  return parts.slice(0, 3).map((value) => Number(value));
}

function parseMemInfo() {
  const raw = readFileText('/proc/meminfo');
  if (!raw) {
    return null;
  }
  return raw.split('\n').reduce((acc, line) => {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)/);
    if (match) {
      acc[match[1]] = Number(match[2]);
    }
    return acc;
  }, {});
}

function parsePsRows(output, fields, limit) {
  const rows = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parsePsLine(line, fields))
    .filter(Boolean)
    .sort((a, b) => b.pcpu - a.pcpu);
  return rows.slice(0, limit);
}

function parsePsLine(line, fields) {
  const parts = line.split(/\s+/);
  if (parts.length < fields.length) {
    return null;
  }

  const row = {};
  fields.forEach((field, index) => {
    row[field] = parts[index];
  });
  row.args = parts.slice(fields.length).join(' ');
  row.pid = Number(row.pid);
  row.ppid = Number(row.ppid);
  row.tid = row.tid == null ? null : Number(row.tid);
  row.pcpu = Number(row.pcpu) || 0;
  row.pmem = Number(row.pmem) || 0;
  return row;
}

async function collectProcesses() {
  const result = await execFileText('ps', [
    '-eo',
    'pid=,ppid=,stat=,pcpu=,pmem=,etime=,comm=,args=',
  ]);
  return {
    ok: result.ok,
    error: result.error,
    top: result.ok
      ? parsePsRows(result.stdout, ['pid', 'ppid', 'stat', 'pcpu', 'pmem', 'etime', 'comm'], 30)
      : [],
  };
}

async function collectThreads() {
  if (process.platform !== 'linux') {
    return { ok: false, error: 'thread ps collection is linux-only', top: [] };
  }

  const result = await execFileText('ps', [
    '-eLo',
    'pid=,tid=,ppid=,stat=,pcpu=,pmem=,comm=,args=',
  ]);
  return {
    ok: result.ok,
    error: result.error,
    top: result.ok
      ? parsePsRows(result.stdout, ['pid', 'tid', 'ppid', 'stat', 'pcpu', 'pmem', 'comm'], 40)
      : [],
  };
}

async function safeDbQuery(sql) {
  try {
    const { rows } = await getDb().queryWithStatementTimeout(sql, [], 2000);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: String(err.message || err), rows: [] };
  }
}

async function collectDatabase() {
  const [waits, active, indexProgress, vacuumProgress, dbStats] = await Promise.all([
    safeDbQuery(`
      SELECT
        COALESCE(wait_event_type, 'none') AS wait_event_type,
        COALESCE(wait_event, 'none') AS wait_event,
        COALESCE(state, 'unknown') AS state,
        COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY wait_event_type, wait_event, state
      ORDER BY count DESC
    `),
    safeDbQuery(`
      SELECT
        pid,
        usename,
        application_name,
        state,
        wait_event_type,
        wait_event,
        ROUND(EXTRACT(EPOCH FROM (NOW() - query_start))::numeric, 3)::float AS age_seconds,
        LEFT(REGEXP_REPLACE(query, '\\s+', ' ', 'g'), 500) AS query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
      ORDER BY
        CASE WHEN state = 'active' THEN 0 ELSE 1 END,
        query_start NULLS LAST
      LIMIT 30
    `),
    safeDbQuery(`
      SELECT
        pid,
        phase,
        lockers_total,
        lockers_done,
        blocks_total,
        blocks_done,
        ROUND((100.0 * blocks_done / NULLIF(blocks_total, 0))::numeric, 2)::float AS pct
      FROM pg_stat_progress_create_index
    `),
    safeDbQuery(`
      SELECT
        pid,
        phase,
        heap_blks_total,
        heap_blks_scanned,
        heap_blks_vacuumed,
        index_vacuum_count
      FROM pg_stat_progress_vacuum
    `),
    safeDbQuery(`
      SELECT
        numbackends,
        xact_commit,
        xact_rollback,
        blks_read,
        blks_hit,
        tup_returned,
        tup_fetched,
        tup_inserted,
        tup_updated,
        tup_deleted,
        temp_bytes,
        deadlocks
      FROM pg_stat_database
      WHERE datname = current_database()
    `),
  ]);

  return {
    waits,
    active,
    indexProgress,
    vacuumProgress,
    dbStats: dbStats.rows[0] || null,
  };
}

function summarizeSample(sample) {
  const topProcess = sample.processes.top[0];
  const topThread = sample.threads.top[0];
  const activeCount = sample.database?.active?.rows?.filter((row) => row.state === 'active').length || 0;
  return {
    sample: sample.sample,
    load: sample.loadAverage,
    topProcess: topProcess
      ? `${topProcess.pcpu}% ${topProcess.comm} ${String(topProcess.args || '').slice(0, 80)}`
      : 'none',
    topThread: topThread
      ? `${topThread.pcpu}% pid=${topThread.pid} tid=${topThread.tid} ${topThread.comm}`
      : 'none',
    activeQueries: activeCount,
  };
}

async function collectSample(sampleNumber, options) {
  const [processes, threads, database] = await Promise.all([
    collectProcesses(),
    collectThreads(),
    options.noDb ? Promise.resolve(null) : collectDatabase(),
  ]);

  return {
    sample: sampleNumber,
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    uptimeSeconds: safeUptimeSeconds(),
    cpuCount: safeCpuCount(),
    loadAverage: parseLoadAverage(),
    memory: parseMemInfo(),
    processes,
    threads,
    database,
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const options = parseArgs();
  fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
  console.log(`[vps-load-diagnostics] writing ${options.samples} samples to ${options.output}`);

  for (let index = 1; index <= options.samples; index += 1) {
    const sample = await collectSample(index, options);
    fs.appendFileSync(options.output, `${JSON.stringify(sample)}\n`);
    console.log('[vps-load-diagnostics]', JSON.stringify(summarizeSample(sample)));
    if (index < options.samples) {
      await sleep(options.intervalMs);
    }
  }

  if (dbModule) {
    await dbModule.pool.end();
  }
  console.log(`[vps-load-diagnostics] done: ${options.output}`);
}

if (require.main === module) {
  run().catch(async (err) => {
    console.error('[vps-load-diagnostics] failed:', err.message);
    try {
      if (dbModule) {
        await dbModule.pool.end();
      }
    } catch (_) {}
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parsePsLine,
  parsePsRows,
  summarizeSample,
};
