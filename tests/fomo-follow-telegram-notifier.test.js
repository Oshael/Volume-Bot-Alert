'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createFomoTelegramOpsNotifier,
} = require('../src/services/fomo-follow-telegram-notifier');

test('Fomo follow pause notifier sends a private operational Telegram message', async () => {
  const messages = [];
  const notifier = createFomoTelegramOpsNotifier({
    chatId: '123456',
    botClient: { sendMessage: async (message) => messages.push(message) },
  });

  await notifier.sendPauseAlert({
    lastErrorCode: 'FOMO_FOLLOW_HTTP_429',
    pausedAt: '2026-08-26T19:00:00.000Z',
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].chat_id, '123456');
  assert.match(messages[0].text, /FOMO_FOLLOW_HTTP_429/);
  assert.match(messages[0].text, /captura de callouts continua ativa/);
  assert.equal(JSON.stringify(messages[0]).includes('bot-token'), false);
});

test('Fomo operational notifier describes stream incidents and recovery', async () => {
  const messages = [];
  const notifier = createFomoTelegramOpsNotifier({
    chatId: '123456',
    botClient: { sendMessage: async (message) => messages.push(message) },
  });

  await notifier.sendStreamIncident({
    kind: 'stale', code: 'FOMO_BROWSER_STREAM_STALE', at: '2026-08-26T20:00:00.000Z',
  });
  await notifier.sendStreamRecovery({
    recoveredCode: 'FOMO_BROWSER_STREAM_STALE', recoveredAt: '2026-08-26T20:02:00.000Z',
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].text, /captura da Fomo com problema/);
  assert.match(messages[0].text, /FOMO_BROWSER_STREAM_STALE/);
  assert.match(messages[1].text, /captura da Fomo recuperada/);
});
