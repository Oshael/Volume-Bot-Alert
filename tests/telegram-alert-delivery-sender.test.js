const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createTelegramAlertDeliverySender,
} = require('../src/services/telegram-alert-delivery-sender');

const DELIVERY = Object.freeze({
  id: '71',
  chain: 'solana',
  tokenAddress: '11111111111111111111111111111111',
  triggeredAt: '2026-07-29T15:02:45.000Z',
  eventPayload: { kind: 'monitored-vol', payload: { symbol: 'SEND' } },
});

function createContext(overrides = {}) {
  const calls = {
    history: [], render: [], photo: [], message: [], fallback: [], format: [],
  };
  const sender = createTelegramAlertDeliverySender({
    marketHistory: {
      async getSparklineBatch(input) {
        calls.history.push(input);
        return { items: [{ series: [100, 120, 140] }] };
      },
    },
    sparklineRenderer: {
      async render(input) {
        calls.render.push(input);
        return { kind: 'image', photo: { data: Buffer.from([1]), contentType: 'image/png' } };
      },
    },
    bot: {
      async sendPhoto(input) {
        calls.photo.push(input);
        return { message_id: 501, photo: [{ file_id: 'small' }, { file_id: 'large' }] };
      },
      async sendMessage(input) {
        calls.message.push(input);
        return { message_id: 502 };
      },
    },
    formatAlert: async (_delivery, options) => {
      calls.format.push(options);
      return {
        text: '<b>SEND</b> full alert',
        caption: '<b>SEND</b> compact alert',
        parseMode: 'HTML',
        replyMarkup: { inline_keyboard: [] },
      };
    },
    onSparklineFallback(input) { calls.fallback.push(input); },
    ...overrides,
  });
  return { calls, sender };
}

function send(sender, overrides = {}) {
  return sender.send({
    delivery: DELIVERY,
    chatId: '9007199254740993',
    sparklineEnabled: true,
    sparklineHours: 24,
    sparklineGranularityMinutes: 5,
    ...overrides,
  });
}

describe('Telegram alert delivery sender', () => {
  it('builds history at triggeredAt and sends a PNG with settlement identifiers', async () => {
    const { calls, sender } = createContext();
    const result = await send(sender);

    assert.deepEqual(calls.history[0].identities, [{
      chain: 'solana', address: DELIVERY.tokenAddress,
    }]);
    assert.equal(calls.history[0].endAt, DELIVERY.triggeredAt);
    assert.equal(calls.history[0].granularityMinutes, 5);
    assert.equal(calls.render[0].series.at(-1), 140);
    assert.equal(calls.photo[0].chat_id, '9007199254740993');
    assert.equal(calls.photo[0].caption, '<b>SEND</b> compact alert');
    assert.deepEqual(calls.format[0], { languageCode: 'en' });
    assert.equal(calls.message.length, 0);
    assert.deepEqual(result, {
      method: 'sendPhoto', messageId: '501', fileId: 'large', sparkline: 'sent',
    });
  });

  it('falls back to text before the Bot API when history cannot render', async () => {
    const { calls, sender } = createContext({
      marketHistory: { async getSparklineBatch() { throw new Error('history offline'); } },
    });
    const result = await send(sender);

    assert.equal(calls.photo.length, 0);
    assert.equal(calls.message[0].text, '<b>SEND</b> full alert');
    assert.equal(calls.fallback[0].reason, 'sparkline_error');
    assert.deepEqual(result, {
      method: 'sendMessage', messageId: '502', fileId: null, sparkline: 'sparkline_error',
    });
  });

  it('skips history when the profile disables sparkline', async () => {
    const { calls, sender } = createContext();
    const result = await send(sender, {
      sparklineEnabled: false,
      sparklineHours: undefined,
      sparklineGranularityMinutes: undefined,
    });

    assert.equal(calls.history.length, 0);
    assert.equal(calls.message.length, 1);
    assert.equal(result.sparkline, 'disabled');
  });

  it('does not send fallback text after an ambiguous sendPhoto failure', async () => {
    const error = Object.assign(new Error('timeout'), { retryable: true });
    const { calls, sender } = createContext({
      bot: {
        async sendPhoto() { throw error; },
        async sendMessage(input) {
          calls.message.push(input);
          return { message_id: 502 };
        },
      },
    });

    await assert.rejects(send(sender), (value) => value === error);
    assert.equal(calls.message.length, 0);
  });

  it('requires bounded formatting and explicit destination ports', async () => {
    assert.throws(() => createTelegramAlertDeliverySender(), /bot delivery port/);
    const { sender } = createContext({ formatAlert: async () => ({ text: 'x'.repeat(4097) }) });
    await assert.rejects(send(sender), /alert text/);
    await assert.rejects(send(sender, { sparklineGranularityMinutes: 2 }), /unsupported/);
  });
});
