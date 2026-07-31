const { createTelegramBotClient } = require('./telegram-bot-client');
const {
  TelegramLinkError,
  createTelegramLinkService,
  normalizeTelegramId,
} = require('./telegram-link-service');
const {
  disconnectConfirmationRoute,
  isDisconnectRoute,
  isInputRoute,
  isMutationRoute,
  parseCallbackData,
  renderMenu,
  targetRoute,
} = require('./telegram-menu');
const {
  TelegramInputValueError,
  createTelegramInputSessionService,
} = require('./telegram-input-session-service');
const { createTelegramSettingsReader } = require('./telegram-settings-reader');
const {
  TelegramSettingsConflictError,
  createTelegramSettingsService,
} = require('./telegram-settings-service');

const TERMINAL_LINK_CODES = new Set([
  'access_denied',
  'account_already_linked',
  'identity_conflict',
  'invalid_link',
  'private_chat_required',
  'telegram_already_linked',
]);

function parseStartCommand(value) {
  const match = String(value || '').match(
    /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{32,128}))?\s*$/
  );
  return match ? { token: match[1] || null } : null;
}

function parseMenuCommand(value) {
  const command = parseGlobalCommand(value);
  return command?.kind === 'menu' ? { token: command.token } : null;
}

function parseCancelCommand(value) {
  return /^\/cancel(?:@[A-Za-z0-9_]+)?\s*$/.test(String(value || ''));
}

function parseGlobalCommand(value) {
  const start = parseStartCommand(value);
  if (start) return { kind: 'menu', ...start };
  const match = String(value || '').match(
    /^\/(settings|status|help|pause|resume|disconnect)(?:@[A-Za-z0-9_]+)?\s*$/
  );
  if (!match) return null;
  if (match[1] === 'settings') return { kind: 'menu', token: null };
  if (match[1] === 'disconnect') return { kind: 'disconnect-prompt' };
  if (match[1] === 'status' || match[1] === 'help') {
    return { kind: 'view', route: { kind: match[1] } };
  }
  return {
    kind: 'delivery-status',
    status: match[1] === 'pause' ? 'paused' : 'active',
  };
}

function getPrivateMessageIdentity(message) {
  if (message?.chat?.type !== 'private') return null;
  const telegramUserId = normalizeTelegramId(message?.from?.id);
  const chatId = normalizeTelegramId(message?.chat?.id);
  if (!telegramUserId || telegramUserId !== chatId) return null;
  return { telegramUserId, chatId };
}

function buildMainMenu(connection) {
  return renderMenu({ kind: 'main' }, { connection }).text;
}

function createTelegramCommandHandler(options = {}) {
  const links = options.linkService || createTelegramLinkService();
  const bot = options.botClient || createTelegramBotClient();
  const settings = options.settingsReader || createTelegramSettingsReader();
  const mutations = options.settingsService || createTelegramSettingsService();
  const inputs = options.inputSessionService || createTelegramInputSessionService({
    settingsReader: settings,
    settingsService: mutations,
  });

  async function resolveConnection(message, identity, token) {
    if (token) {
      try {
        return await links.completeLink({
          token,
          ...identity,
          username: message.from?.username,
          firstName: message.from?.first_name,
        });
      } catch (error) {
        if (!(error instanceof TelegramLinkError) && !TERMINAL_LINK_CODES.has(error?.code)) {
          throw error;
        }
        if (error?.code === 'access_denied') return null;
      }
    }
    return links.findAuthorizedConnection(identity);
  }

  async function renderFor(resolved, route) {
    const context = await settings.read(resolved.connection.user_id, route);
    return renderMenu(route, {
      access: resolved.access,
      connection: resolved.connection,
      ...context,
    });
  }

  async function handleInputCallback(resolved, identity, callback, route) {
    try {
      const prompt = await inputs.start({
        userId: resolved.connection.user_id,
        telegramUserId: identity.telegramUserId,
        ...route,
        expectedVersion: route.version,
      });
      await bot.answerCallbackQuery({ callback_query_id: callback.id });
      await bot.sendMessage({
        chat_id: resolved.connection.chat_id,
        text: prompt.text,
        reply_markup: { force_reply: true, selective: true },
      });
    } catch (error) {
      if (!(error instanceof TelegramSettingsConflictError)) throw error;
      await bot.answerCallbackQuery({
        callback_query_id: callback.id,
        text: 'Este menu estava desatualizado. Confira os valores atuais.',
        show_alert: true,
      });
      const menu = await renderFor(resolved, targetRoute(route));
      await bot.editMessageText({
        chat_id: resolved.connection.chat_id,
        message_id: callback.message.message_id,
        text: menu.text,
        reply_markup: menu.reply_markup,
      });
    }
    return { handled: true };
  }

  async function handleDisconnectCallback(resolved, callback, route) {
    const current = disconnectConfirmationRoute(resolved.connection);
    if (!current
      || current.connectionId !== route.connectionId
      || current.version !== route.version) {
      await bot.answerCallbackQuery({
        callback_query_id: callback.id,
        text: 'Esta confirmação está desatualizada.',
        show_alert: true,
      });
      return { handled: true };
    }
    try {
      await links.disconnect(resolved.connection.user_id, {
        connectionId: route.connectionId,
        expectedVersion: route.version,
      });
    } catch (error) {
      if (!(error instanceof TelegramLinkError) || error.code !== 'connection_conflict') {
        throw error;
      }
      await bot.answerCallbackQuery({
        callback_query_id: callback.id,
        text: 'A conexão mudou. Abra o menu novamente.',
        show_alert: true,
      });
      return { handled: true };
    }
    await bot.answerCallbackQuery({ callback_query_id: callback.id });
    await bot.editMessageText({
      chat_id: resolved.connection.chat_id,
      message_id: callback.message.message_id,
      text: 'Telegram desconectado. As configurações foram preservadas.',
      reply_markup: { inline_keyboard: [] },
    });
    return { handled: true };
  }

  async function handleCallback(update) {
    const callback = update?.callback_query;
    const route = parseCallbackData(callback?.data);
    const identity = getPrivateMessageIdentity(callback?.message && {
      ...callback.message,
      from: callback.from,
    });
    if (!route || !identity || !callback?.id || !callback.message?.message_id) {
      return { ignored: true };
    }
    let resolved = await links.findAuthorizedConnection(identity);
    if (!resolved) return { ignored: true };
    if (isDisconnectRoute(route)) return handleDisconnectCallback(resolved, callback, route);
    if (isInputRoute(route)) return handleInputCallback(resolved, identity, callback, route);
    let renderRoute = route;
    let answer = { callback_query_id: callback.id };
    if (isMutationRoute(route)) {
      renderRoute = targetRoute(route);
      try {
        const updated = await mutations.apply(resolved.connection.user_id, route);
        if (route.kind === 'toggle-connection') {
          resolved = { ...resolved, connection: updated };
        }
        answer.text = 'Configuração atualizada.';
      } catch (error) {
        if (!(error instanceof TelegramSettingsConflictError)) throw error;
        answer = {
          ...answer,
          text: 'Este menu estava desatualizado. Confira os valores atuais.',
          show_alert: true,
        };
      }
    }
    await bot.answerCallbackQuery(answer);
    const menu = await renderFor(resolved, renderRoute);
    await bot.editMessageText({
      chat_id: resolved.connection.chat_id,
      message_id: callback.message.message_id,
      text: menu.text,
      reply_markup: menu.reply_markup,
      disable_web_page_preview: true,
    });
    return { handled: true };
  }

  async function handleInputMessage(message, identity) {
    const resolved = await links.findAuthorizedConnection(identity);
    if (!resolved) return { ignored: true };
    const input = {
      userId: resolved.connection.user_id,
      telegramUserId: identity.telegramUserId,
    };
    if (parseCancelCommand(message.text)) {
      const canceled = await inputs.cancel(input);
      await bot.sendMessage({
        chat_id: resolved.connection.chat_id,
        text: canceled ? 'Edição cancelada.' : 'Nenhuma edição ativa.',
      });
      return { handled: true };
    }
    try {
      const result = await inputs.submit({ ...input, text: message.text });
      if (!result) return { ignored: true };
      const menu = await renderFor(resolved, result.route);
      await bot.sendMessage({
        chat_id: resolved.connection.chat_id,
        text: menu.text,
        reply_markup: menu.reply_markup,
      });
    } catch (error) {
      if (error instanceof TelegramInputValueError) {
        await bot.sendMessage({
          chat_id: resolved.connection.chat_id,
          text: error.message,
          reply_markup: { force_reply: true, selective: true },
        });
      } else if (error instanceof TelegramSettingsConflictError) {
        const menu = await renderFor(resolved, error.route);
        await bot.sendMessage({
          chat_id: resolved.connection.chat_id,
          text: `A configuração mudou antes da resposta.\n\n${menu.text}`,
          reply_markup: menu.reply_markup,
        });
      } else {
        throw error;
      }
    }
    return { handled: true };
  }

  async function handleGlobalCommand(message, identity, command) {
    let resolved = await resolveConnection(message, identity, command.token);
    if (!resolved) return { ignored: true };
    let route = command.route || { kind: 'main' };
    if (command.kind === 'disconnect-prompt') {
      route = disconnectConfirmationRoute(resolved.connection) || { kind: 'status' };
    }
    if (command.kind === 'delivery-status') {
      const current = resolved.connection.status;
      if (['active', 'paused'].includes(current) && current !== command.status) {
        try {
          const connection = await mutations.apply(resolved.connection.user_id, {
            kind: 'set-connection-status',
            status: command.status,
            version: resolved.connection.version,
          });
          resolved = { ...resolved, connection };
        } catch (error) {
          if (!(error instanceof TelegramSettingsConflictError)) throw error;
          resolved = await links.findAuthorizedConnection(identity);
          if (!resolved) return { ignored: true };
        }
      } else if (!['active', 'paused'].includes(current)) {
        route = { kind: 'status' };
      }
    }
    const menu = await renderFor(resolved, route);
    await bot.sendMessage({
      chat_id: resolved.connection.chat_id,
      text: menu.text,
      reply_markup: menu.reply_markup,
      disable_web_page_preview: true,
    });
    return { handled: true };
  }

  async function handleUpdate(update) {
    if (update?.callback_query) {
      try {
        return await handleCallback(update);
      } catch (error) {
        if (error instanceof TelegramLinkError && TERMINAL_LINK_CODES.has(error.code)) {
          return { ignored: true };
        }
        throw error;
      }
    }
    const message = update?.message;
    const command = parseGlobalCommand(message?.text);
    const identity = getPrivateMessageIdentity(message);
    if (!identity) return { ignored: true };

    try {
      if (!command) return handleInputMessage(message, identity);
      return handleGlobalCommand(message, identity, command);
    } catch (error) {
      if (error instanceof TelegramLinkError && TERMINAL_LINK_CODES.has(error.code)) {
        return { ignored: true };
      }
      throw error;
    }
  }

  return { handleUpdate };
}

module.exports = {
  buildMainMenu,
  createTelegramCommandHandler,
  getPrivateMessageIdentity,
  parseMenuCommand,
  parseCancelCommand,
  parseGlobalCommand,
  parseStartCommand,
};
