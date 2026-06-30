const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../src/services/admin-token-review-alert-service');

function buildManualReviewPayload(rowOverrides = {}) {
  return {
    row: {
      address: 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M',
      symbol: 'RTPBET',
      name: 'RTP Bet',
      last_mcap: 1000000,
      last_twitter_url: 'https://x.com/rtpbet',
      ...rowOverrides,
    },
    label: 'junk_probable',
    assessment: {
      manualReviewRequired: true,
      autoBlock: false,
      marketCap: 1000000,
      reasonCodes: ['holder_concentration_extreme'],
    },
    marketSnapshot: { mcap: 1000000 },
    riskSnapshot: { top10Pct: 90 },
    meteoraSnapshot: { hasPool: false },
  };
}

describe('admin token review alert service', () => {
  it('skips manual review alerts for launchpad suffix tokens before Dex lookup', async () => {
    let dexLookups = 0;
    let enqueues = 0;

    const alert = await service.maybeEnqueueManualReviewSocialAlert(
      buildManualReviewPayload({
        address: 'HmjCoarLh5duURfJ333DwfFiPyTCgFT35pRSAoP8pump',
        last_twitter_url: null,
      }),
      {
        dexscreenerService: {
          getTokenPairs: async () => {
            dexLookups += 1;
            throw new Error('launchpad suffix tokens should not hit Dex lookup');
          },
        },
        adminTokenReviewAlertModel: {
          enqueue: async () => {
            enqueues += 1;
            throw new Error('launchpad suffix tokens should not enqueue review alerts');
          },
        },
      },
    );

    assert.equal(alert, null);
    assert.equal(dexLookups, 0);
    assert.equal(enqueues, 0);
  });

  it('detects launchpad suffixes on address, symbol, or name', () => {
    assert.equal(service.__private.hasLaunchpadSuffix({ address: 'abcPUMP' }), true);
    assert.equal(service.__private.hasLaunchpadSuffix({ symbol: 'TOKEN-BONK' }), true);
    assert.equal(service.__private.hasLaunchpadSuffix({ name: 'Example Bags!' }), true);
    assert.equal(service.__private.hasLaunchpadSuffix({ name: 'Pumpkin Token' }), false);
  });

  it('still enqueues non-launchpad manual review tokens with social evidence', async () => {
    const enqueues = [];

    const alert = await service.maybeEnqueueManualReviewSocialAlert(
      buildManualReviewPayload(),
      {
        adminTokenReviewAlertModel: {
          enqueue: async (payload) => {
            enqueues.push(payload);
            return payload;
          },
        },
      },
    );

    assert.equal(enqueues.length, 1);
    assert.equal(alert.alertKind, service.ALERT_KIND_SOCIALS_PRESENT);
    assert.equal(alert.socialSnapshot.twitterUrl, 'https://x.com/rtpbet');
  });
});
