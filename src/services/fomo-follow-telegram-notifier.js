'use strict';

const { createTelegramBotClient } = require('./telegram-bot-client');

function createFomoFollowTelegramNotifier(options = {}) {
  const bot = options.botClient || createTelegramBotClient({
    enabled: true,
    botToken: options.botToken,
    timeoutMs: options.timeoutMs,
  });
  const chatId = String(options.chatId || '').trim();

  async function sendPauseAlert(event = {}) {
    const errorCode = String(event.lastErrorCode || 'FOMO_FOLLOW_ERROR');
    const pausedAt = String(event.pausedAt || new Date().toISOString());
    await bot.sendMessage({
      chat_id: chatId,
      disable_web_page_preview: true,
      text: [
        '🚨 TrendScope: follow da Fomo pausado',
        `Erro: ${errorCode}`,
        `Horário: ${pausedAt}`,
        'A captura de callouts continua ativa.',
        'A retomada exige intervenção manual.',
      ].join('\n'),
    });
  }

  return { sendPauseAlert };
}

module.exports = { createFomoFollowTelegramNotifier };
