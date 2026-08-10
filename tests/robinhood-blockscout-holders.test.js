const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  RobinhoodBlockscoutHoldersError,
  createRobinhoodBlockscoutHoldersClient,
  __private,
} = require('../src/services/robinhood-blockscout-holders');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;

function response(status, payload, jsonError = null, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    async json() {
      if (jsonError) throw jsonError;
      return payload;
    },
  };
}

function client(fetchImpl, options = {}) {
  return createRobinhoodBlockscoutHoldersClient({
    fetchImpl,
    now: () => new Date('2026-08-10T02:00:00.000Z'),
    ...options,
  });
}

describe('Robinhood Blockscout holders client', () => {
  it('normalizes a holder summary without losing raw supply precision', async () => {
    const calls = [];
    const api = client(async (url, options) => {
      calls.push({ url: String(url), options });
      return response(200, {
        address_hash: TOKEN.toUpperCase(),
        holders_count: '53039',
        total_supply: '1000000000000000000000000000',
        decimals: '18',
      });
    });

    const summary = await api.getTokenHolderSummary(TOKEN.toUpperCase());

    assert.deepEqual(summary, {
      address: TOKEN, available: true, holderCount: 53039,
      totalSupplyRaw: '1000000000000000000000000000', decimals: 18,
      source: 'blockscout', observedAt: '2026-08-10T02:00:00.000Z',
    });
    assert.match(calls[0].url, new RegExp(`${TOKEN}$`));
    assert.equal(calls[0].options.headers.accept, 'application/json');
  });

  it('treats a missing summary as unavailable, not as zero holders', async () => {
    const summary = await client(async () => response(404, null)).getTokenHolderSummary(TOKEN);
    assert.equal(summary.available, false);
    assert.equal(summary.holderCount, null);
    assert.equal(summary.observedAt, null);
  });

  it('normalizes public holder data, classifications and an opaque next cursor', async () => {
    const calls = [];
    const pages = [
      response(200, {
        items: [
          { value: '999999999999999999999999', address: { hash: WALLET, is_contract: false, private_tags: [{ display_name: 'secret' }] } },
          { value: '42', address_hash: { hash: POOL, is_contract: true, is_verified: true, name: 'UniswapV3Pool' } },
        ],
        next_page_params: { value: '42', address_hash: POOL, items_count: 50 },
      }),
      response(200, {
        items: [{ value: '7', address: { hash: WALLET, is_contract: false, public_tags: [{ display_name: 'Public wallet' }] } }],
        next_page_params: null,
      }),
    ];
    const api = client(async (url) => {
      calls.push(String(url));
      return pages.shift();
    });

    const first = await api.getTokenHoldersPage(TOKEN);
    const second = await api.getTokenHoldersPage(TOKEN, first.nextCursor);

    assert.equal(first.items[0].balanceRaw, '999999999999999999999999');
    assert.equal(first.items[0].label, null);
    assert.equal(first.items[0].addressType, 'wallet');
    assert.equal(first.items[1].addressType, 'pool');
    assert.equal(first.items[1].isVerifiedContract, true);
    assert.equal(first.hasMore, true);
    assert.equal(second.items[0].rank, 51);
    assert.equal(second.items[0].label, 'Public wallet');
    assert.equal(second.hasMore, false);
    assert.match(calls[1], /address_hash=0x3333333333333333333333333333333333333333/);
    assert.match(calls[1], /items_count=50/);
    assert.match(calls[1], /value=42/);
  });

  it('classifies canonical burn addresses before wallet or contract type', () => {
    const holder = __private.normalizeHolder({
      value: '1',
      address: { hash: '0x000000000000000000000000000000000000dEaD', is_contract: false },
    }, 1);
    assert.equal(holder.addressType, 'burn');
  });

  it('rejects mismatched tokens, unsafe counts, oversized pages and malformed cursors', async () => {
    const mismatched = client(async () => response(200, {
      address_hash: WALLET, holders_count: '1', total_supply: '1', decimals: '18',
    }));
    await assert.rejects(() => mismatched.getTokenHolderSummary(TOKEN), (error) => error.code === 'address_mismatch');

    const unsafe = client(async () => response(200, {
      address_hash: TOKEN, holders_count: '9007199254740992', total_supply: '1', decimals: '18',
    }));
    await assert.rejects(() => unsafe.getTokenHolderSummary(TOKEN), /holder count is unsafe/);

    assert.throws(() => __private.decodeCursor('not-json'), (error) => error.code === 'invalid_cursor');
    const invalidValueCursor = Buffer.from(JSON.stringify({ items_count: 50, value: '-1' })).toString('base64url');
    assert.throws(() => __private.decodeCursor(invalidValueCursor), (error) => error.code === 'invalid_cursor');
    assert.throws(() => __private.normalizePage(TOKEN, { items: Array(51).fill({}) }, null, Date.now), /page is invalid/);
  });

  it('classifies transient transport/HTTP failures without retrying permanent errors here', async () => {
    const timedOut = client(async () => { throw Object.assign(new Error('late'), { name: 'AbortError' }); });
    await assert.rejects(() => timedOut.getTokenHolderSummary(TOKEN), (error) => (
      error instanceof RobinhoodBlockscoutHoldersError && error.code === 'timeout' && error.retryable
    ));

    for (const [status, retryable] of [[429, true], [503, true], [400, false]]) {
      const failed = client(async () => response(status, null, null, { 'retry-after': '2' }));
      await assert.rejects(() => failed.getTokenHolderSummary(TOKEN), (error) => (
        error.code === 'http_error' && error.httpStatus === status
          && error.retryable === retryable && error.retryAfter === '2'
      ));
    }

    const invalidJson = client(async () => response(200, null, new Error('bad json')));
    await assert.rejects(() => invalidJson.getTokenHolderSummary(TOKEN), (error) => (
      error.code === 'invalid_response' && error.retryable === false
    ));
  });
});
