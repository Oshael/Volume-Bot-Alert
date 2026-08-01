const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramAlertFormatter,
} = require('../src/services/telegram-alert-formatter');

const SOLANA = 'So11111111111111111111111111111111111111112';
const ROBINHOOD = '0xabcdef0123456789abcdef0123456789abcdef01';
const formatter = createTelegramAlertFormatter({ appBaseUrl: 'https://www.trendscope.pro' });

function delivery(overrides = {}) {
  const { payload: payloadOverrides, kind, ...deliveryOverrides } = overrides;
  const payload = {
    symbol: 'TEST',
    pct: 82,
    prevVolume5m: 50_000,
    volume5m: 96_000,
    mcap: 255_000,
    tokenAgeMs: 11_880_000,
    ...payloadOverrides,
  };
  return {
    chain: 'solana',
    ruleKey: 'monitored-vol',
    tokenAddress: SOLANA,
    triggeredAt: '2026-07-29T14:32:08.000Z',
    ...deliveryOverrides,
    eventPayload: { kind: kind || 'monitored-vol', payload },
  };
}

describe('Telegram alert formatter', () => {
  it('formats a safe Solana volume alert with product and explorer links', () => {
    const result = formatter.format(delivery({
      payload: { symbol: '<TEST&>', prevVolume5m: 50_000 },
    }));

    assert.match(result.text, /<b>VOLUME 5M · &lt;TEST&amp;&gt;<\/b>/);
    assert.match(result.text, /Change: \+82%/);
    assert.match(result.text, /Volume 5M: \$50K → \$96K/);
    assert.match(result.text, /Market cap: \$255K/);
    assert.match(result.text, /Age: 3h 18m/);
    assert.doesNotMatch(result.text, /undefined|NaN/);
    assert.equal(result.caption, result.text);
    assert.equal(result.parseMode, 'HTML');
    assert.deepEqual(result.replyMarkup.inline_keyboard, [
      [{ text: '📊 Open in TrendScope', url: `https://www.trendscope.pro/alerts/${SOLANA}` }],
      [{ text: '🔎 Explorer', url: `https://solscan.io/token/${SOLANA}` }],
    ]);
  });

  it('formats Portuguese alerts from the persisted Telegram language', () => {
    const result = formatter.format(delivery(), { languageCode: 'pt-BR' });

    assert.match(result.text, /Rede: Solana/);
    assert.match(result.text, /Variação: \+82%/);
    assert.match(result.text, /Idade: 3h 18m/);
    assert.equal(result.replyMarkup.inline_keyboard[0][0].text, '📊 Abrir no TrendScope');
  });

  it('uses FDV fields and chain-scoped links for Robinhood', () => {
    const result = formatter.format(delivery({
      chain: 'robinhood',
      ruleKey: 'recent-surge-6h',
      tokenAddress: ROBINHOOD.toUpperCase(),
      kind: 'old-surge',
      payload: {
        symbol: 'RHD',
        pct: 125.5,
        prevFdv: 100_000,
        fdv: 225_500,
        volume6h: 1_200_000,
        tokenAgeMs: null,
      },
    }));

    assert.match(result.text, /RECENT SURGE 6H/);
    assert.match(result.text, /FDV: \$100K → \$225.5K/);
    assert.match(result.text, /Volume 6H: \$1.2M/);
    assert.doesNotMatch(result.text, /Market cap/);
    assert.equal(
      result.replyMarkup.inline_keyboard[0][0].url,
      `https://www.trendscope.pro/alerts/robinhood/${ROBINHOOD}`,
    );
    assert.equal(
      result.replyMarkup.inline_keyboard[1][0].url,
      `https://robinhoodchain.blockscout.com/address/${ROBINHOOD}`,
    );
  });

  it('formats rule-specific metrics and omits absent or internal payload fields', () => {
    const cases = [
      ['hvnc', { volume24h: 900_000 }, /Volume 24H: \$900K/],
      ['monitored-mcap', { prevMcap: 100_000, mcap: 150_000 }, /Market cap: \$100K → \$150K/],
      ['meteora-surge', {
        meteoraBaselineTvl24h: 40_000, meteoraCurrentTvl: 70_000,
      }, /TVL Meteora: \$40K → \$70K/],
    ];
    for (const [ruleKey, payload, expected] of cases) {
      const result = formatter.format(delivery({ ruleKey, kind: ruleKey, payload: {
        pct: null, volume5m: null, mcap: null, tokenAgeMs: null,
        customSoundDataUrl: 'data:audio/mpeg;base64,secret', ...payload,
      } }));
      assert.match(result.text, expected);
      assert.doesNotMatch(result.text, /customSound|data:audio|undefined|NaN/);
      assert.ok(result.caption.length <= 1024);
    }
  });

  it('rejects unsupported identities and unsafe application URLs', () => {
    assert.throws(
      () => createTelegramAlertFormatter({ appBaseUrl: 'javascript:alert(1)' }),
      /approved HTTP\(S\) URL/,
    );
    assert.throws(
      () => formatter.format(delivery({ ruleKey: 'gmgn-claim-signal' })),
      /Unsupported Telegram alert rule/,
    );
    assert.throws(
      () => formatter.format(delivery({ tokenAddress: 'not-a-token' })),
      /Invalid solana token address/,
    );
  });
});
