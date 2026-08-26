'use strict';

const { createTelegramBotClient } = require('./telegram-bot-client');

function createFomoTelegramOpsNotifier(options = {}) {
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

  async function sendStreamIncident(event = {}) {
    await bot.sendMessage({
      chat_id: chatId,
      disable_web_page_preview: true,
      text: [
        '🚨 TrendScope: captura da Fomo com problema',
        `Estado: ${String(event.kind || 'unknown')}`,
        `Erro: ${String(event.code || 'FOMO_BROWSER_UNHEALTHY')}`,
        `Horário: ${String(event.at || new Date().toISOString())}`,
        'A captura de novos callouts pode estar interrompida.',
        'O follow permanece isolado.',
      ].join('\n'),
    });
  }

  async function sendStreamRecovery(event = {}) {
    await bot.sendMessage({
      chat_id: chatId,
      disable_web_page_preview: true,
      text: [
        '✅ TrendScope: captura da Fomo recuperada',
        `Incidente anterior: ${String(event.recoveredCode || 'unknown')}`,
        `Recuperado em: ${String(event.recoveredAt || new Date().toISOString())}`,
      ].join('\n'),
    });
  }

  return { sendPauseAlert, sendStreamIncident, sendStreamRecovery };
}

module.exports = {
  createFomoFollowTelegramNotifier: createFomoTelegramOpsNotifier,
  createFomoTelegramOpsNotifier,
};
