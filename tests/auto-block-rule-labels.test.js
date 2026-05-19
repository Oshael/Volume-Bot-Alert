const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const catalogWorker = require('../src/services/catalog-worker');
const gmgnCatalogIngestion = require('../src/services/gmgn-catalog-ingestion');
const riskReviewSyncWorker = require('../src/services/token-risk-review-sync-worker');
const {
  AUTO_BLOCK_LABEL_PREFIXES,
  AUTO_BLOCK_REASON_CODES,
} = require('../src/services/auto-block-rule-labels');

describe('auto-block rule labels', () => {
  it('keeps canonical high-ban label prefixes stable', () => {
    assert.deepEqual(AUTO_BLOCK_LABEL_PREFIXES, {
      CATALOG_YOUNG_EXTREME_CHURN: 'catalog-volume:young-extreme-churn',
      GMGN_AUTO_JUNK: 'gmgn-auto-junk',
      GMGN_INFO_LOW_MCAP_HIGH_HOLDERS: 'gmgn-info:low-mcap-high-holders',
      GMGN_KLINE_STAIRCASE_PUMP: 'gmgn-kline:staircase-pump',
      GMGN_LIQUIDITY_BAD_STATUS_MCAP_BAND: 'gmgn-liquidity:bad-status-mcap-band',
      GMGN_LIQUIDITY_UNDER_1K_SPAM: 'gmgn-liquidity:under-1k-spam',
      GMGN_NEW_NON_PUMP_HIGH_LAUNCH_MCAP: 'gmgn-origin:new-non-pump-high-launch-mcap',
      GMGN_SECURITY_TOP10_HOLDER_RATE: 'gmgn-security:top10-holder-rate',
      GMGN_VOLUME_LOW_MCAP_EXTREME_VOL5M: 'gmgn-volume:low-mcap-extreme-vol5m',
      RISK_REVIEW_AUTO_JUNK_PROBABLE: 'auto-junk-probable',
    });
  });

  it('keeps canonical high-ban reason codes stable', () => {
    assert.deepEqual(AUTO_BLOCK_REASON_CODES, {
      GMGN_CONCENTRATED_STRUCTURE: 'gmgn_concentrated_structure',
      GMGN_HOLDER_COUNT_MCAP_ANOMALY: 'gmgn_holder_count_mcap_anomaly',
      GMGN_YOUNG_EXTREME_CHURN: 'gmgn_young_extreme_churn',
      NEW_LOW_MCAP_EXTREME_VOL5M_CHURN: 'new_low_mcap_extreme_vol5m_churn',
    });
  });

  it('keeps generated admin-block labels equivalent to their legacy shapes', () => {
    assert.equal(
      gmgnCatalogIngestion.__private.buildGmgnAutoBlockLabel({
        reasonCodes: ['low_liquidity', 'dead_volume', 'extra_signal', 'ignored_signal'],
      }),
      'gmgn-auto-junk:low_liquidity,dead_volume,extra_signal'
    );
    assert.equal(
      gmgnCatalogIngestion.__private.buildGmgnSecurityAutoBlockLabel({ top10HolderRate: 0.7034 }),
      'gmgn-security:top10-holder-rate-70.34%'
    );
    assert.equal(
      gmgnCatalogIngestion.__private.buildGmgnInfoAutoBlockLabel({ holderCount: 1500, marketCap: 98765 }),
      'gmgn-info:low-mcap-high-holders:98765:1500'
    );
    assert.equal(
      gmgnCatalogIngestion.__private.buildGmgnLowLiquiditySpamLabel({
        liquidityUsd: 721.2,
        mcap: 84550.6,
      }),
      'gmgn-liquidity:under-1k-spam:721:84551'
    );
    assert.equal(
      gmgnCatalogIngestion.__private.buildGmgnBadLiquidityStatusMcapBandLabel({
        mcap: 84550.6,
        raw: {
          lock_percent: 0,
          burn_ratio: 0,
          burn_status: 'none',
        },
      }),
      'gmgn-liquidity:bad-status-mcap-band:84551:3bad:lock_zero:burn_ratio_zero:burn_status_none'
    );
    assert.equal(
      gmgnCatalogIngestion.__private.buildGmgnKlineAutoBlockLabel({ runupRatio: 1.55 }),
      'gmgn-kline:staircase-pump:155%'
    );
    assert.equal(
      riskReviewSyncWorker.__private.buildAutoBlockLabel({
        reasonCodes: [
          AUTO_BLOCK_REASON_CODES.GMGN_YOUNG_EXTREME_CHURN,
          AUTO_BLOCK_REASON_CODES.GMGN_CONCENTRATED_STRUCTURE,
          'ignored_signal',
          'also_ignored',
        ],
      }),
      'auto-junk-probable:gmgn_young_extreme_churn,gmgn_concentrated_structure,ignored_signal'
    );
    assert.equal(
      catalogWorker.__private.buildYoungExtremeChurnLabel({
        currentMcap: 60000,
        initialMcap: 50000,
        vol5m: 210000,
        volMcapRatio: 3.456,
      }),
      'catalog-volume:young-extreme-churn:60000:50000:210000:3.5x'
    );
  });
});
