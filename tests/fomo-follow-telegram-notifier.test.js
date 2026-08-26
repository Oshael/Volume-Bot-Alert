'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createFomoFollowTelegramNotifier,
} = require('../src/services/fomo-follow-telegram-notifier');

test('Fomo follow pause notifier sends a private operational Telegram message', async () => {
  const messages = [];
  const notifier = createFomoFollowTelegramNotifier({
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
