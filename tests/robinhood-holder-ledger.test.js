const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderLedgerRepository,
  __private,
} = require('../src/models/robinhood-holder-ledger');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'b'.repeat(40)}`;
const ALICE = `0x${'c'.repeat(40)}`;
const BOB = `0x${'d'.repeat(40)}`;

function transfer(overrides = {}) {
  return {
    blockNumber: '100', blockHash: HASH, transactionHash: HASH,
    transactionIndex: 1, logIndex: 2, tokenAddress: TOKEN,
    fromWallet: ALICE, toWallet: BOB, amountRaw: '340282366920938463463374607431768211456',
    ...overrides,
  };
}

function cursor(overrides = {}) {
  return {
    rangeStart: '100', nextBlock: '101', safeHead: '105', expectedVersion: null,
    checkpoint: { number: '100', hash: HASH }, ...overrides,
  };
}

function fakeDatabase(sequence = []) {
  const calls = [];
  const client = {
    released: false,
    async query(sql, params) {
      calls.push({ sql, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
      return sequence.shift() || { rows: [], rowCount: 0 };
    },
    release() { this.released = true; },
  };
  return {
    calls, client,
    database: {
      getClient: async () => client,
      query: async (sql, params) => {
        calls.push({ sql, params });
        return sequence.shift() || { rows: [], rowCount: 0 };
      },
    },
  };
}

describe('Robinhood holder ledger repository', () => {
  it('normalizes uint256 transfers and bounds them by the committed checkpoint', () => {
    const normalized = __private.normalizeTransfer(transfer({ blockNumber: '0x64' }));
    assert.equal(normalized.blockNumber, '100');
    assert.equal(normalized.amountRaw, '340282366920938463463374607431768211456');
    assert.throws(() => __private.validateRange([normalized], __private.normalizeCursor(cursor({
      nextBlock: '100',
    }))), /immediately follow/);
    assert.throws(() => __private.validateRange([normalized], __private.normalizeCursor(cursor({
      rangeStart: '101',
    }))), /inside the captured range/);
    assert.throws(() => __private.normalizeTransfer(transfer({ tokenAddress: 'bad' })), /20 bytes/);
    assert.deepEqual(__private.normalizeRewind({
      nextBlock: '100', safeHead: '105', expectedVersion: 2,
      checkpoint: { number: '99', hash: HASH },
    }), {
      nextBlock: '100', safeHead: '105', expectedVersion: 2,
      checkpoint: { number: '99', hash: HASH },
    });
    assert.throws(() => __private.normalizeRewind({
      nextBlock: '100', safeHead: '105', expectedVersion: 2,
      checkpoint: { number: '98', hash: HASH },
    }), /immediately precede/);
  });

  it('derives holder transitions for mint, burn, transfer and self-transfer', () => {
    const derive = __private.deriveBalanceChanges;
    const zero = `0x${'0'.repeat(40)}`;
    const cases = [
      { input: transfer({ fromWallet: zero, amountRaw: '5' }), balances: {}, delta: 1,
        after: { [BOB]: '5' } },
      { input: transfer({ toWallet: zero, amountRaw: '5' }), balances: { [ALICE]: '5' },
        delta: -1, after: { [ALICE]: '0' } },
      { input: transfer({ amountRaw: '4' }), balances: { [ALICE]: '10' }, delta: 1,
        after: { [ALICE]: '6', [BOB]: '4' } },
      { input: transfer({ toWallet: ALICE, amountRaw: '4' }), balances: { [ALICE]: '10' },
        delta: 0, after: { [ALICE]: '10' } },
    ];
    for (const scenario of cases) {
      const changes = derive(scenario.input, scenario.balances);
      assert.equal(changes.holderDelta, scenario.delta);
      assert.deepEqual(Object.fromEntries(changes.transitions.map((item) => (
        [item.walletAddress, item.after]
      ))), scenario.after);
      if (scenario.input.toWallet === ALICE) assert.equal(changes.fromBalanceAfter, '10');
    }
    assert.throws(
      () => derive(transfer({ amountRaw: '11' }), { [ALICE]: '10' }),
      (error) => error.code === 'holder_negative_balance'
    );
  });

  it('commits matching captures and advances a bootstrap cursor atomically', async () => {
    const fake = fakeDatabase([
      { rows: [{ inserted: true }], rowCount: 1 },
      { rows: [{ inserted: false }], rowCount: 1 },
      { rows: [{ version: '0' }], rowCount: 1 },
    ]);
    const repository = createRobinhoodHolderLedgerRepository(fake);
    const result = await repository.appendCapturedRange({
      transfers: [transfer(), transfer({ transactionHash: `0x${'e'.repeat(64)}`, logIndex: 3 })],
      cursor: cursor(),
    });

    assert.deepEqual(result, { insertedTransfers: 1, duplicateTransfers: 1, cursorVersion: 0 });
    assert.deepEqual(fake.calls.map(({ sql }) => sql === 'BEGIN' || sql === 'COMMIT' ? sql : 'query'), [
      'BEGIN', 'query', 'query', 'query', 'COMMIT',
    ]);
    assert.match(fake.calls[1].sql, /ON CONFLICT \(chain, transaction_hash, log_index\)/);
    assert.match(fake.calls[3].sql, /robinhood_holder_cursors\.version = \$5::bigint/);
    assert.match(fake.calls[3].sql, /robinhood_holder_cursors\.next_block = \$6::bigint/);
    assert.equal(fake.client.released, true);
  });

  it('rolls back the range when evidence conflicts or the cursor is stale', async () => {
    for (const [sequence, expectedCode] of [
      [[{ rows: [], rowCount: 0 }], 'holder_capture_conflict'],
      [[{ rows: [{ inserted: true }], rowCount: 1 }, { rows: [], rowCount: 0 }],
        'holder_cursor_stale'],
    ]) {
      const fake = fakeDatabase(sequence);
      const repository = createRobinhoodHolderLedgerRepository(fake);
      await assert.rejects(
        repository.appendCapturedRange({ transfers: [transfer()], cursor: cursor() }),
        (error) => error.code === expectedCode
      );
      assert.equal(fake.calls.at(-1).sql, 'ROLLBACK');
      assert.equal(fake.client.released, true);
    }
  });

  it('reads the independent live cursor without starting a transaction', async () => {
    const fake = fakeDatabase([{ rows: [{
      stream: 'live', next_block: '101', safe_head: '105', checkpoint_block: '100',
      checkpoint_hash: HASH, journal_floor_block: '50', version: '7',
    }], rowCount: 1 }]);
    const cursorState = await createRobinhoodHolderLedgerRepository(fake).getCursor();
    assert.deepEqual(cursorState, {
      stream: 'live', nextBlock: '101', safeHead: '105', checkpointBlock: '100',
      checkpointHash: HASH, journalFloorBlock: '50', version: 7,
    });
    assert.equal(fake.calls.length, 1);
  });

  it('lists only token states covered by the global holder stream', async () => {
    const fake = fakeDatabase([{ rows: [{ token_address: TOKEN }], rowCount: 1 }]);
    const addresses = await createRobinhoodHolderLedgerRepository(fake)
      .listTrackedTokenAddresses();
    assert.deepEqual(addresses, [TOKEN]);
    assert.match(fake.calls[0].sql, /ledger_status IN \('backfilling', 'shadow', 'live'\)/);
  });
});
