'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const express = require('express');
const request = require('supertest');
const calloutEnrichmentRouter = require('../src/routes/callout-enrichment');
const {
  createTokenChainVisibilityMiddleware,
} = require('../src/middleware/token-chain-visibility');

const TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01';

function result() {
  return {
    status: 'ready', chainKey: 'robinhood', tokenAddress: TOKEN,
    evidenceVersion: 'callout_robinhood_wallet_buy_v1',
    from: '2026-08-25T12:00:00.000Z', to: '2026-08-25T15:00:00.000Z',
    actions: [{
      evidenceState: 'wallet_action', correlationStatus: 'not_evaluated',
      profile: {
        platform: 'fomo', platformUserId: 'profile-1', username: 'caller',
        displayName: 'Caller', profilePictureUrl: 'https://images.example/caller.png',
      },
      walletBinding: {
        address: '0x1111111111111111111111111111111111111111',
        networkScope: 'evm_address_candidate', sourceType: 'platform_reported',
      },
      action: { chainKey: 'robinhood', side: 'buy', transactionHash: `0x${'a'.repeat(64)}` },
    }],
    hasMore: false,
  };
}

function eventResult() {
  return {
    chainKey: 'robinhood', tokenAddress: TOKEN,
    from: '2026-08-25T12:00:00.000Z', to: '2026-08-25T15:00:00.000Z',
    events: [{
      id: 'fomo:callout:id:event-1', eventType: 'callout', platform: 'fomo',
      occurredAt: '2026-08-25T14:00:00.000Z', thesis: 'Call thesis',
      profile: {
        platformUserId: 'profile-1', username: 'caller', displayName: 'Caller',
        profilePictureUrl: 'https://images.example/caller.png',
      },
      source: { platform: 'fomo', links: [{ link: 'https://x.com/caller/status/1' }] },
    }],
    hasMore: false, nextCursor: null,
  };
}

function appWith(options = {}) {
  const app = express();
  app.use('/api/callouts', calloutEnrichmentRouter.createCalloutEnrichmentRouter({
    authenticate: options.authenticate || ((_req, _res, next) => next()),
    visibility: options.visibility || ((_req, _res, next) => next()),
    enrichment: options.enrichment || { listProfileWalletBuys: async () => result() },
    eventRead: options.eventRead || { listEvents: async () => eventResult() },
    logger: options.logger || { error() {} },
  }));
  return app;
}

describe('callout enrichment route', () => {
  it('requires authentication before reading enrichment data', async () => {
    let reads = 0;
    const response = await request(appWith({
      authenticate: (_req, res) => res.status(401).json({ error: 'Authentication required' }),
      enrichment: { listProfileWalletBuys: async () => { reads += 1; } },
    })).get(`/api/callouts/profile-wallet-buys?chain=robinhood&token=${TOKEN}`);

    assert.equal(response.status, 401);
    assert.equal(reads, 0);
  });

  it('respects the Robinhood user-visibility gate', async () => {
    const visibility = createTokenChainVisibilityMiddleware({
      robinhoodUserVisibility: { enabled: false },
    });
    const response = await request(appWith({ visibility }))
      .get(`/api/callouts/profile-wallet-buys?chain=robinhood&token=${TOKEN}`);

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'CHAIN_NOT_AVAILABLE');
  });

  it('returns raw chart callouts with profile avatar, origin and source links', async () => {
    const calls = [];
    const response = await request(appWith({
      eventRead: { listEvents: async (input) => { calls.push(input); return eventResult(); } },
    })).get(
      `/api/callouts/events?chain=ROBINHOOD&token=${TOKEN.toUpperCase()}&from=2026-08-25T12:00:00Z&to=2026-08-25T15:00:00Z&limit=25`
    );

    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], {
      chainKey: 'robinhood', tokenAddress: TOKEN,
      from: '2026-08-25T12:00:00Z', to: '2026-08-25T15:00:00Z',
      limit: '25', cursor: undefined,
    });
    assert.equal(response.body.events[0].profile.profilePictureUrl,
      'https://images.example/caller.png');
    assert.equal(response.body.events[0].source.platform, 'fomo');
    assert.equal(response.body.events[0].source.links[0].link,
      'https://x.com/caller/status/1');
  });

  it('returns platform identity and avatar with wallet and action provenance', async () => {
    const calls = [];
    const response = await request(appWith({
      enrichment: { listProfileWalletBuys: async (input) => { calls.push(input); return result(); } },
    })).get(
      `/api/callouts/profile-wallet-buys?chain=ROBINHOOD&token=${TOKEN.toUpperCase()}&from=2026-08-25T12:00:00Z&to=2026-08-25T15:00:00Z&limit=25`
    );

    assert.equal(response.status, 200);
    assert.deepEqual(calls[0], {
      chainKey: 'robinhood', tokenAddress: TOKEN,
      from: '2026-08-25T12:00:00Z', to: '2026-08-25T15:00:00Z', limit: '25',
    });
    assert.equal(response.body.actions[0].profile.profilePictureUrl,
      'https://images.example/caller.png');
    assert.equal(response.body.actions[0].profile.platform, 'fomo');
    assert.equal(response.body.actions[0].walletBinding.networkScope, 'evm_address_candidate');
    assert.equal(response.body.actions[0].correlationStatus, 'not_evaluated');
  });

  it('rejects invalid token identity before invoking the reader', async () => {
    let reads = 0;
    const response = await request(appWith({
      enrichment: { listProfileWalletBuys: async () => { reads += 1; } },
    })).get('/api/callouts/profile-wallet-buys?chain=robinhood&token=invalid');

    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'INVALID_TOKEN_IDENTITY');
    assert.equal(reads, 0);
  });

  it('maps bounded-input errors to 400 and hides unexpected failures', async () => {
    const bounded = new Error('range must be greater than zero and at most 72 hours');
    bounded.code = 'INVALID_ENRICHMENT_RANGE';
    const badInput = await request(appWith({
      enrichment: { listProfileWalletBuys: async () => { throw bounded; } },
    })).get(`/api/callouts/profile-wallet-buys?chain=robinhood&token=${TOKEN}`);
    const failed = await request(appWith({
      enrichment: { listProfileWalletBuys: async () => { throw new Error('db secret'); } },
    })).get(`/api/callouts/profile-wallet-buys?chain=robinhood&token=${TOKEN}`);

    assert.equal(badInput.status, 400);
    assert.equal(badInput.body.code, 'INVALID_ENRICHMENT_RANGE');
    assert.equal(failed.status, 500);
    assert.equal(JSON.stringify(failed.body).includes('db secret'), false);
  });

  it('maps invalid event cursors to 400 and hides event reader failures', async () => {
    const invalidCursor = new Error('cursor is invalid for this callout query');
    invalidCursor.code = 'INVALID_CALLOUT_CURSOR';
    const badInput = await request(appWith({
      eventRead: { listEvents: async () => { throw invalidCursor; } },
    })).get(`/api/callouts/events?chain=robinhood&token=${TOKEN}&cursor=bad`);
    const failed = await request(appWith({
      eventRead: { listEvents: async () => { throw new Error('db secret'); } },
    })).get(`/api/callouts/events?chain=robinhood&token=${TOKEN}`);

    assert.equal(badInput.status, 400);
    assert.equal(badInput.body.code, 'INVALID_CALLOUT_CURSOR');
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, 'CALLOUT_EVENT_READ_FAILED');
    assert.equal(JSON.stringify(failed.body).includes('db secret'), false);
  });
});
