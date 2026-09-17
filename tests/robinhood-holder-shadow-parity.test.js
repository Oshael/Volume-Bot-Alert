'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodHolderShadowParity,
  __private: { compareTransfers, replayBalances, compareBalances, handoffDecision, report },
} = require('../src/services/robinhood-holder-shadow-parity');
const { main } = require('../src/utils/audit-robinhood-holder-shadow-parity');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const ZERO = `0x${'0'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;

function transfer(overrides = {}) {
  return {
    blockNumber: '100', blockHash: HASH, transactionHash: TX,
    transactionIndex: 0, logIndex: 0, tokenAddress: TOKEN,
    fromWallet: ZERO, toWallet: ALICE, amountRaw: '10', ...overrides,
  };
}

describe('Robinhood holder shadow parity', () => {
  it('distinguishes missing, excess and divergent transfer evidence', () => {
    const canonical = [transfer(), transfer({ transactionHash: HASH, logIndex: 1 })];
    const legacy = [transfer({ amountRaw: '9' }), transfer({
      transactionHash: `0x${'c'.repeat(64)}`, logIndex: 2,
    })];
    assert.deepEqual(compareTransfers(canonical, legacy), {
      missing: [`${HASH}:1`], excess: [`0x${'c'.repeat(64)}:2`],
      divergent: [`${TX}:0`],
    });
  });

  it('replays mint, transfer and burn into exact holder balances', () => {
    const replayed = replayBalances([
      transfer(),
      transfer({ transactionHash: HASH, logIndex: 1,
        fromWallet: ALICE, toWallet: BOB, amountRaw: '4' }),
      transfer({ transactionHash: `0x${'c'.repeat(64)}`, logIndex: 2,
        fromWallet: BOB, toWallet: ZERO, amountRaw: '4' }),
    ]);
    assert.equal(replayed.holderCount, '1');
    assert.deepEqual([...replayed.balances], [[ALICE, '6']]);
    assert.deepEqual(compareBalances(replayed, [
      { wallet_address: ALICE, balance_raw: '6' },
    ], '1'), { countMatches: true, divergentWallets: [] });
    assert.deepEqual(compareBalances(replayed, [
      { wallet_address: ALICE, balance_raw: '7' },
    ], '1').divergentWallets, [ALICE]);
  });

  it('reports tail and checkpoint reasons before handoff', () => {
    const cursor = { journal_floor_block: '90', next_block: '110', checkpoint_hash: HASH };
    const state = {
      ledger_status: 'backfilling', backfill_next_block: '105',
      tail_capture_from_block: '106', live_through_block: '104',
      live_through_hash: HASH,
    };
    assert.equal(handoffDecision(state, cursor), 'replay-before-tail');
    assert.equal(handoffDecision({ ...state, tail_capture_from_block: '105' }, cursor), 'eligible');
    assert.equal(handoffDecision({ ...state, ledger_status: 'live' }, cursor), 'already-promoted');
  });

  it('fails the gate for incomplete samples or any event mismatch', () => {
    const frontier = {
      capture_checkpoint_block: '110', holder_checkpoint_block: '110',
      raw_floor_block: '90', journal_floor_block: '90',
    };
    const clean = { issues: [], transfers: { missing: [], excess: [], divergent: [] } };
    assert.equal(report(frontier, [clean, clean], 0).ready, true);
    assert.equal(report(frontier, [clean], 0).incomplete, true);
    assert.equal(report(frontier, [clean, clean], 1).ready, false);
    assert.equal(report(frontier, [clean, {
      ...clean, transfers: { ...clean.transfers, divergent: ['tx:0'] },
    }], 0).ready, false);
  });

  it('uses one repeatable read-only snapshot and emits an incomplete gate', async () => {
    const calls = [];
    const frontier = {
      capture_checkpoint_block: '110', holder_checkpoint_block: '108',
      checkpoint_hash: HASH, next_block: '109', raw_floor_block: '90',
      journal_floor_block: '90', missing_tail_states: 0,
    };
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('AS raw_floor_block')) return { rows: [frontier] };
        if (sql.includes('WITH eligible AS')) return { rows: [] };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error('unexpected query');
      },
      release() { calls.push('RELEASE'); },
    };
    const audit = createRobinhoodHolderShadowParity({
      database: { getClient: async () => client },
    });
    const result = await audit.inspect();
    assert.equal(result.ready, false);
    assert.equal(result.incomplete, true);
    assert.match(calls[0], /REPEATABLE READ READ ONLY/);
    assert.equal(calls.at(-2), 'ROLLBACK');
    assert.equal(calls.at(-1), 'RELEASE');
    const lines = [];
    assert.deepEqual(await main({
      audit: { inspect: async () => result }, logger: { log: (line) => lines.push(line) },
    }), result);
    assert.deepEqual(JSON.parse(lines[0]), result);
  });
});
