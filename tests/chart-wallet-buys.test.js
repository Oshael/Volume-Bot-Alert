const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SERVICE_PATH = path.join(__dirname, '..', 'frontend/src/services/charts/chart-wallet-buys.ts');

function loadModule(apiFetch = async () => ({})) {
  const compiled = ts.transpileModule(fs.readFileSync(SERVICE_PATH, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module,
    exports: module.exports,
    require: (specifier) => (specifier === '../api/base' ? { apiFetch } : require(specifier)),
    Date,
    Map,
    Math,
    Number,
    URLSearchParams,
  }, { filename: SERVICE_PATH });
  return module.exports;
}

const walletBuys = loadModule();
const candles = [
  { time: Date.parse('2026-08-25T10:00:00Z') / 1000, low: 100 },
  { time: Date.parse('2026-08-25T10:05:00Z') / 1000, low: 90 },
];
const scale = {
  timeToCoordinate: (time) => (time - candles[0].time) / 3,
  priceToCoordinate: (price) => 500 - price,
};

function action(id, blockTime, scope = 'exact_chain') {
  return {
    evidenceId: id,
    evidenceState: 'wallet_action',
    correlationStatus: 'not_evaluated',
    profile: {
      platform: 'fomo', platformUserId: `profile-${id}`,
      username: id, displayName: null, profilePictureUrl: null,
    },
    walletBinding: {
      address: '0x1111111111111111111111111111111111111111',
      networkScope: scope, sourceType: 'platform_reported', confidence: 'high',
    },
    action: {
      blockTime, transactionHash: `0x${'a'.repeat(64)}`,
      amountUsd: 100, priceUsd: 1,
    },
  };
}

describe('chart profile wallet buys', () => {
  it('requests the bounded Robinhood reader and preserves truncation state', async () => {
    const paths = [];
    const service = loadModule(async (requestPath) => {
      paths.push(requestPath);
      return { status: 'ready', actions: [action('one', '2026-08-25T10:01:00Z')], hasMore: true };
    });
    const result = await service.fetchChartWalletBuys('0x1111111111111111111111111111111111111111');

    assert.equal(result.actions.length, 1);
    assert.equal(result.truncated, true);
    assert.match(paths[0], /chain=robinhood/);
    assert.match(paths[0], /limit=200/);
  });

  it('groups proven buys below the active candle and keeps binding scope', () => {
    const groups = walletBuys.groupChartWalletBuys([
      action('older', '2026-08-25T10:01:00Z'),
      action('newer', '2026-08-25T10:04:00Z', 'evm_address_candidate'),
      action('next', '2026-08-25T10:06:00Z'),
    ], candles, scale, 5);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].actions.map((item) => item.evidenceId).join(','), 'newer,older');
    assert.equal(groups[0].actions[0].walletBinding.networkScope, 'evm_address_candidate');
    assert.equal(groups[0].actions[0].correlationStatus, 'not_evaluated');
    assert.equal(groups[0].y, 424);
  });

  it('regroups at one hour and ignores actions without a real candle', () => {
    const hourly = walletBuys.groupChartWalletBuys([
      action('first', '2026-08-25T10:01:00Z'),
      action('second', '2026-08-25T10:50:00Z'),
    ], [{ time: candles[0].time, low: 100 }], scale, 60);
    const missing = walletBuys.groupChartWalletBuys([
      action('invalid', 'not-a-date'), action('gap', '2026-08-25T10:12:00Z'),
    ], candles, scale, 5);

    assert.equal(hourly.length, 1);
    assert.equal(hourly[0].actions.length, 2);
    assert.equal(missing.length, 0);
  });
});
