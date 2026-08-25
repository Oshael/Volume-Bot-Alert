'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createCalloutEventRead, __private,
} = require('../src/models/callout-event-read');

const NOW = Date.parse('2026-08-25T15:00:00.000Z');
const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01';

function row(overrides = {}) {
  return {
    dedupe_key: 'fomo:callout:id:event-1', platform: 'fomo',
    platform_event_id: 'event-1', occurred_at: '2026-08-25T14:00:00.000Z',
    captured_at: '2026-08-25T14:00:01.000Z', asset_chain_key: 'robinhood',
    asset_address_normalized: TOKEN, thesis: 'Buy before the announcement',
    market_cap: '123456.78', source_metadata: {
      ticker: 'TEST', sourceLinks: [
        { link: 'https://x.com/caller/status/123', text: 'source', provider: 'x' },
        { link: 'javascript:alert(1)', text: 'unsafe', provider: 'other' },
      ],
    },
    platform_user_id: 'profile-1', username: 'caller', x_username: 'caller_x',
    display_name: 'Caller', profile_picture_url: 'https://images.example/caller.png',
    ...overrides,
  };
}

describe('callout event reader', () => {
  it('uses the indexed token identity, bounded time range and live retention gate', () => {
    assert.match(__private.CALLOUT_EVENTS_SQL, /event\.asset_chain_key = \$1/);
    assert.match(__private.CALLOUT_EVENTS_SQL, /event\.asset_address_normalized = \$2/);
    assert.match(__private.CALLOUT_EVENTS_SQL, /event\.occurred_at >= \$3::timestamptz/);
    assert.match(__private.CALLOUT_EVENTS_SQL, /event\.occurred_at < \$4::timestamptz/);
    assert.match(__private.CALLOUT_EVENTS_SQL, /event\.expires_at > NOW\(\)/);
    assert.match(__private.CALLOUT_EVENTS_SQL,
      /\(event\.occurred_at, event\.dedupe_key\) < \(\$5::timestamptz, \$6::text\)/);
  });

  it('normalizes token, range and limit with a maximum 72-hour window', () => {
    const query = __private.normalizeQuery({
      chainKey: 'ROBINHOOD', tokenAddress: TOKEN.toUpperCase(),
    }, () => NOW);
    assert.equal(query.chainKey, 'robinhood');
    assert.equal(query.tokenAddress, TOKEN);
    assert.equal(Date.parse(query.to) - Date.parse(query.from), __private.MAX_RANGE_MS);
    assert.equal(query.limit, __private.DEFAULT_LIMIT);
    assert.throws(() => __private.normalizeQuery({
      chainKey: 'robinhood', tokenAddress: TOKEN,
      from: '2026-08-21T15:00:00Z', to: '2026-08-25T15:00:00Z',
    }), (error) => error.code === 'INVALID_CALLOUT_RANGE');
    assert.throws(() => __private.normalizeLimit(201),
      (error) => error.code === 'INVALID_CALLOUT_LIMIT');
  });

  it('returns only the safe chart contract with profile, origin and real links', () => {
    const callout = __private.normalizeCallout(row());
    assert.equal(callout.eventType, 'callout');
    assert.equal(callout.platform, 'fomo');
    assert.equal(callout.profile.profilePictureUrl, 'https://images.example/caller.png');
    assert.equal(callout.thesis, 'Buy before the announcement');
    assert.equal(callout.marketCap, 123456.78);
    assert.equal(callout.source.platform, 'fomo');
    assert.deepEqual(callout.source.links, [{
      link: 'https://x.com/caller/status/123', text: 'source', provider: 'x',
    }]);
    assert.equal(Object.hasOwn(callout, 'sourceMetadata'), false);
  });

  it('returns a stable keyset cursor bound to the token and requested range', async () => {
    const calls = [];
    const database = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [row(), row({
          dedupe_key: 'pump:callout:id:event-2', platform: 'pump',
          platform_event_id: 'event-2', occurred_at: '2026-08-25T13:00:00.000Z',
        })] };
      },
    };
    const reader = createCalloutEventRead({ database, now: () => NOW });
    const first = await reader.listEvents({
      chainKey: 'robinhood', tokenAddress: TOKEN, limit: 1,
    });

    assert.deepEqual(calls[0].params, [
      'robinhood', TOKEN, '2026-08-22T15:00:00.000Z', '2026-08-25T15:00:00.000Z',
      null, null, 2,
    ]);
    assert.equal(first.events.length, 1);
    assert.equal(first.hasMore, true);
    assert.equal(typeof first.nextCursor, 'string');

    const cursorQuery = __private.normalizeQuery({
      chainKey: 'robinhood', tokenAddress: TOKEN,
      from: first.from, to: first.to, cursor: first.nextCursor,
    }, () => NOW);
    assert.deepEqual(cursorQuery.cursor, {
      occurredAt: '2026-08-25T14:00:00.000Z', key: 'fomo:callout:id:event-1',
    });
    assert.throws(() => __private.normalizeQuery({
      chainKey: 'base', tokenAddress: TOKEN,
      from: first.from, to: first.to, cursor: first.nextCursor,
    }, () => NOW), (error) => error.code === 'INVALID_CALLOUT_CURSOR');
  });

  it('uses a short statement timeout when supported', async () => {
    const calls = [];
    const database = {
      queryWithStatementTimeout: async (sql, params, timeoutMs) => {
        calls.push({ sql, params, timeoutMs }); return { rows: [] };
      },
    };
    await createCalloutEventRead({ database, now: () => NOW })
      .listEvents({ chainKey: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112' });
    assert.equal(calls[0].timeoutMs, __private.DEFAULT_STATEMENT_TIMEOUT_MS);
  });
});
