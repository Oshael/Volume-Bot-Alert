'use strict';

/** Reparent remaining event children without rewriting or deleting historical rows. */
const db = require('../models/db');

const PLANS = Object.freeze([
  {
    table: 'robinhood_chain_v3_balance_snapshots',
    old: 'rh_chain_v3_balance_snapshots_event_fkey',
    next: 'rh_chain_v3_balance_snapshots_block_fkey',
    parent: 'robinhood_chain_blocks',
    columns: '(chain, block_hash)',
    reference: '(chain, block_hash)',
  },
  {
    table: 'token_launchpad_lifecycle_events',
    old: 'token_launchpad_lifecycle_events_event_fkey',
    next: 'token_launchpad_lifecycle_events_block_fkey',
    parent: 'robinhood_chain_blocks',
    columns: '(chain, block_hash)',
    reference: '(chain, block_hash)',
  },
  {
    table: 'robinhood_canonical_head_candidates',
    old: 'rh_canonical_head_candidates_event_fkey',
    next: 'rh_canonical_head_candidates_shadow_event_fkey',
    parent: 'robinhood_chain_events_shadow',
    columns: '(chain, block_number, block_hash, log_index)',
    reference: '(chain, block_number, block_hash, log_index)',
  },
]);

async function inspect(client) {
  const result = await client.query(`SELECT conrelid::regclass::text AS child,
      conname, confrelid::regclass::text AS parent, convalidated,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE contype='f' AND conrelid=ANY($1::regclass[])
      AND conname=ANY($2::text[])`, [
    PLANS.map((plan) => `public.${plan.table}`),
    PLANS.flatMap((plan) => [plan.old, plan.next]),
  ]);
  return PLANS.map((plan) => {
    const constraints = result.rows.filter((row) => row.child === plan.table);
    const old = constraints.find((row) => row.conname === plan.old);
    const next = constraints.find((row) => row.conname === plan.next);
    const expected = `FOREIGN KEY ${plan.columns} REFERENCES ${plan.parent}${plan.reference}`;
    if (!old) throw new Error(`${plan.table}: active FK is missing`);
    const migrated = old.parent === plan.parent;
    if (!migrated && (old.parent !== 'robinhood_chain_events' || !old.convalidated)) {
      throw new Error(`${plan.table}: legacy FK is not validated or targets an unexpected parent`);
    }
    if (migrated && (next || !old.convalidated || !old.definition.includes(expected))) {
      throw new Error(`${plan.table}: migrated FK is incomplete`);
    }
    if (next && (next.parent !== plan.parent || !next.definition.includes(expected)
      || !next.definition.includes('ON DELETE CASCADE'))) {
      throw new Error(`${plan.table}: prepared FK has an unexpected definition`);
    }
    return { table: plan.table, migrated, prepared: Boolean(next),
      validated: migrated || Boolean(next?.convalidated) };
  });
}

async function prepare(client) {
  const state = await inspect(client);
  for (const plan of PLANS) {
    const item = state.find((row) => row.table === plan.table);
    if (item.migrated || item.prepared) continue;
    await client.query(`ALTER TABLE public.${plan.table} ADD CONSTRAINT ${plan.next}
      FOREIGN KEY ${plan.columns} REFERENCES public.${plan.parent}${plan.reference}
      ON DELETE CASCADE NOT VALID`);
  }
  return inspect(client);
}

async function validate(client) {
  const state = await inspect(client);
  for (const plan of PLANS) {
    const item = state.find((row) => row.table === plan.table);
    if (item.migrated || item.validated) continue;
    if (!item.prepared) throw new Error(`${plan.table}: run --prepare first`);
    await client.query(`ALTER TABLE public.${plan.table} VALIDATE CONSTRAINT ${plan.next}`);
  }
  return inspect(client);
}

async function cutover(client) {
  const state = await inspect(client);
  if (state.every((row) => row.migrated)) return state;
  if (state.some((row) => !row.migrated && !row.validated)) {
    throw new Error('all replacement FKs must be validated before cutover');
  }
  for (const plan of PLANS) {
    if (state.find((row) => row.table === plan.table).migrated) continue;
    await client.query(`ALTER TABLE public.${plan.table} DROP CONSTRAINT ${plan.old}`);
    await client.query(`ALTER TABLE public.${plan.table} RENAME CONSTRAINT
      ${plan.next} TO ${plan.old}`);
  }
  const finalState = await inspect(client);
  if (finalState.some((row) => !row.migrated)) throw new Error('FK cutover incomplete');
  return finalState;
}

async function run(phase, options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    if (phase === 'read-only') return { phase, constraints: await inspect(client) };
    if (!['prepare', 'validate', 'cutover'].includes(phase)) throw new Error('invalid phase');
    if (phase === 'validate') {
      const result = [];
      for (const plan of PLANS) {
        await client.query('BEGIN');
        try {
          await client.query("SET LOCAL lock_timeout = '5s'");
          await client.query("SET LOCAL statement_timeout = '30min'");
          const state = await inspect(client);
          const item = state.find((row) => row.table === plan.table);
          if (!item.migrated && !item.validated) {
            if (!item.prepared) throw new Error(`${plan.table}: run --prepare first`);
            await client.query(`ALTER TABLE public.${plan.table} VALIDATE CONSTRAINT ${plan.next}`);
          }
          await client.query('COMMIT');
          const progress = { table: plan.table, validated: true };
          result.push(progress);
          options.onProgress?.(progress);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }
      return { phase, constraints: await inspect(client), progress: result };
    }
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query('LOCK TABLE public.robinhood_chain_blocks IN SHARE ROW EXCLUSIVE MODE');
    if (phase === 'cutover') {
      const initial = await inspect(client);
      if (!initial.every((row) => row.migrated)) {
        await client.query('LOCK TABLE public.robinhood_chain_events IN SHARE ROW EXCLUSIVE MODE');
      }
    }
    const constraints = phase === 'prepare'
      ? await prepare(client) : await cutover(client);
    await client.query('COMMIT');
    return { phase, constraints };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  const arg = process.argv[2];
  const phase = arg == null ? 'read-only' : arg.replace(/^--/, '');
  if (process.argv.length > 3 || !['read-only', 'prepare', 'validate', 'cutover'].includes(phase)) {
    throw new Error('use --prepare, --validate or --cutover');
  }
  run(phase, { onProgress: (progress) => console.log(JSON.stringify({
    phase: 'validate-progress', ...progress,
  })) }).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    console.error('Robinhood event FK migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { PLANS, inspect, prepare, validate, cutover, run };
