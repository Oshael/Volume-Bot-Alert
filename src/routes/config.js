const express = require('express');
const router = express.Router();
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');
const db = require('../models/db');
const userConfig = require('../models/user-config');
const userUiPref = require('../models/user-ui-pref');
const userToken = require('../models/user-token');
const userTokenFolder = require('../models/user-token-folder');
const userBlocklist = require('../models/user-blocklist');
const userStarredToken = require('../models/user-starred-token');
const tokenCatalog = require('../models/token-catalog');
const userAlertProfileCache = require('../services/user-alert-profile-cache');
const userConfigSync = require('../services/user-config-sync');
const manualTokenBootstrap = require('../services/manual-token-bootstrap');
const { normalizeText } = require('../utils/url-safety');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');
const {
  getAvailableTokenChains,
  isRobinhoodTokenChainConfigured,
} = require('../utils/token-chain-availability');
const { getWorkspaceChainReadiness } = require('../services/workspace-chain-readiness');
const config = require('../../config');

// All config routes require authentication
router.use(authenticate);
router.use(requireTrustedOrigin);

// ── Limites ────────────────────────────────────────────────────────
const MAX_TOKENS = 200;      // per user and chain
const MAX_BLOCKLIST = 500;   // per user and chain
const MAX_STARRED = 500;     // per user and chain
const USER_COLLECTION_CHAINS = Object.freeze(['solana', 'robinhood']);
const ADMIN_ONLY_CONFIG_KEYS = new Set(['chain', 'mock-sol-usdc-rate']);

function isValidLegacySolanaAddress(address) {
  try {
    normalizeTokenAddress('solana', address);
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeCollectionIdentity(addressValue, chainValue = 'solana') {
  try {
    const chain = normalizeTokenChain(chainValue || 'solana');
    if (!USER_COLLECTION_CHAINS.includes(chain)) {
      throw new Error('Unsupported workspace chain');
    }
    return { chain, address: normalizeTokenAddress(chain, addressValue) };
  } catch (_) {
    throw Object.assign(new Error('Invalid token identity'), { status: 400 });
  }
}

function normalizeAddressItems(items) {
  const deduped = new Map();
  items
    .map((item) => {
      if (typeof item === 'string') {
        return { address: item.trim(), label: null };
      }

      if (!item || typeof item !== 'object') {
        return { address: '', label: null };
      }

      return {
        address: String(item.address || '').trim(),
        label: normalizeText(item.label, 128),
      };
    })
    .filter((item) => item.address)
    .forEach((item) => {
      const current = deduped.get(item.address);
      deduped.set(item.address, {
        address: item.address,
        label: current?.label || item.label || null,
      });
    });

  return [...deduped.values()];
}

async function upsertCatalogItems(items, source) {
  if (!Array.isArray(items) || items.length === 0) return;

  for (const item of items) {
    try {
      await tokenCatalog.upsertToken({
        address: item.address,
        chain: 'solana',
        source,
      });
    } catch (err) {
      console.error(`[TokenCatalog] Failed to upsert ${source} token ${item.address}:`, err.message);
    }
  }
}

async function upsertCatalogItemsAndSchedule(items, source) {
  if (!Array.isArray(items) || items.length === 0) return;

  for (const item of items) {
    try {
      if (source === 'user-manual') {
        await manualTokenBootstrap.upsertManualCatalogToken(item.address);
      } else {
        await tokenCatalog.upsertToken({
          address: item.address,
          chain: 'solana',
          source,
        });
      }
    } catch (err) {
      console.error(`[TokenCatalog] Failed to upsert ${source} token ${item.address}:`, err.message);
    }
  }
}

function getRouteErrorStatus(err) {
  const status = Number(err?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }
  if (err?.code === '23505') {
    return 409;
  }
  if (err?.code === '23503') {
    return 400;
  }
  return 500;
}

function sendRouteError(res, err, fallbackMessage) {
  const status = getRouteErrorStatus(err);
  const message = status === 500 ? fallbackMessage : err.message;
  return res.status(status).json({ error: message });
}

function stripRestrictedConfigKeys(configs, user) {
  if (!configs || typeof configs !== 'object') {
    return configs;
  }

  if (user?.role === 'admin') {
    return configs;
  }

  const next = { ...configs };
  for (const key of ADMIN_ONLY_CONFIG_KEYS) {
    delete next[key];
  }
  return next;
}

function buildRuntimeFlags() {
  return {
    mockTradingEnabled: Boolean(config.mockTrading.enabled),
  };
}

function buildAvailableTokenChains() {
  return getAvailableTokenChains({
    robinhoodConfigured: isRobinhoodTokenChainConfigured(config),
  });
}

async function notifyUserConfigChanged(userId) {
  try {
    await userConfigSync.publishUserConfigInvalidated(userId);
  } catch (err) {
    console.error('[UserConfigSync] Failed to publish config invalidation:', err.message);
  }
}

async function notifyUserConfigChangedIfNeeded(userId, shouldNotify) {
  if (!shouldNotify) {
    return;
  }
  await notifyUserConfigChanged(userId);
}

// ══════════════════════════════════════════════════════════════════
//  CONFIGS (thresholds, intervals, etc.)
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/config
 * Retorna todas as configs do user (com defaults preenchidos).
 */
router.get('/', async (req, res) => {
  try {
    const [configs, uiPrefs, tokens, blocklist, starredTokens, chainReadiness] = await Promise.all([
      userConfig.getAll(req.user.id),
      userUiPref.getAll(req.user.id),
      userToken.getAllForChains(req.user.id, USER_COLLECTION_CHAINS),
      userBlocklist.getAllForChains(req.user.id, USER_COLLECTION_CHAINS),
      userStarredToken.getAllForChains(req.user.id, USER_COLLECTION_CHAINS),
      getWorkspaceChainReadiness(),
    ]);

    const responsePayload = {
      configs,
      uiPrefs,
      tokens,
      blocklist,
      starredTokens,
      availableChains: buildAvailableTokenChains(),
      chainReadiness,
      runtimeFlags: buildRuntimeFlags(),
    };
    res.json(responsePayload);
  } catch (err) {
    console.error('GET /config error:', err.message);
    res.status(500).json({ error: 'Failed to load configs' });
  }
});

router.get('/chain-readiness', async (_req, res) => {
  try {
    res.json({
      availableChains: buildAvailableTokenChains(),
      chainReadiness: await getWorkspaceChainReadiness(),
    });
  } catch (err) {
    console.error('GET /config/chain-readiness error:', err.message);
    res.status(500).json({ error: 'Failed to load chain readiness' });
  }
});

/**
 * PUT /api/config
 * Replace ALL configs + tokens + blocklist (full sync).
 * Body: { configs: {...}, tokens: [...], blocklist: [...] }
 */
router.put('/', async (req, res) => {
  try {
    const { tokens, blocklist, starredTokens } = req.body;
    const configs = stripRestrictedConfigKeys(req.body?.configs, req.user);
    let validatedConfigs = null;
    let normalizedTokens = null;
    let normalizedBlocklist = null;
    let normalizedStarred = null;
    let removedManualTokenCandidates = [];

    // Validate everything first so the request is all-or-nothing.
    if (configs && typeof configs === 'object') {
      const validation = userConfig.validateConfigs(configs);
      if (!validation.valid) {
        return res.status(400).json({
          error: 'Invalid config values',
          details: validation.errors,
        });
      }
      validatedConfigs = validation.configs;
    }

    if (Array.isArray(tokens)) {
      if (tokens.length > MAX_TOKENS) {
        return res.status(400).json({
          error: `Maximum ${MAX_TOKENS} manual tokens allowed`,
        });
      }

      normalizedTokens = normalizeAddressItems(tokens);
      const invalid = normalizedTokens.filter((t) => !isValidLegacySolanaAddress(t.address));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `${invalid.length} invalid token address(es)`,
        });
      }
    }

    if (Array.isArray(blocklist)) {
      if (blocklist.length > MAX_BLOCKLIST) {
        return res.status(400).json({
          error: `Maximum ${MAX_BLOCKLIST} blocked tokens allowed`,
        });
      }

      normalizedBlocklist = normalizeAddressItems(blocklist);
      const invalid = normalizedBlocklist.filter((item) => !isValidLegacySolanaAddress(item.address));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `${invalid.length} invalid blocked token address(es)`,
        });
      }
    }

    if (Array.isArray(starredTokens)) {
      if (starredTokens.length > MAX_STARRED) {
        return res.status(400).json({
          error: `Maximum ${MAX_STARRED} starred tokens allowed`,
        });
      }

      normalizedStarred = normalizeAddressItems(starredTokens);
      const invalid = normalizedStarred.filter((item) => !isValidLegacySolanaAddress(item.address));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: `${invalid.length} invalid starred token address(es)`,
        });
      }
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      if (validatedConfigs) {
        await client.query('DELETE FROM user_configs WHERE user_id = $1', [req.user.id]);
        for (const [key, value] of Object.entries(validatedConfigs)) {
          await client.query(
            'INSERT INTO user_configs (user_id, config_key, config_value) VALUES ($1, $2, $3)',
            [req.user.id, key, String(value)]
          );
        }
      }

      if (normalizedTokens) {
        const previousTokens = await client.query(
          `SELECT address FROM user_tokens
           WHERE user_id = $1 AND chain = 'solana'`,
          [req.user.id]
        );
        const nextTokenAddresses = new Set(normalizedTokens.map((item) => item.address));
        removedManualTokenCandidates = previousTokens.rows
          .map((row) => String(row.address || '').trim())
          .filter((address) => address && !nextTokenAddresses.has(address));

        await client.query("DELETE FROM user_tokens WHERE user_id = $1 AND chain = 'solana'", [req.user.id]);
        for (const tokenItem of normalizedTokens) {
          await client.query(
            `INSERT INTO user_tokens (user_id, chain, address, label)
             VALUES ($1, 'solana', $2, $3)
             ON CONFLICT (user_id, chain, address) DO NOTHING`,
            [req.user.id, tokenItem.address, tokenItem.label]
          );
        }
      }

      if (normalizedBlocklist) {
        await client.query("DELETE FROM user_blocklist WHERE user_id = $1 AND chain = 'solana'", [req.user.id]);
        for (const blockedItem of normalizedBlocklist) {
          await client.query(
            `INSERT INTO user_blocklist (user_id, chain, address, label)
             VALUES ($1, 'solana', $2, $3)
             ON CONFLICT (user_id, chain, address) DO NOTHING`,
            [req.user.id, blockedItem.address, blockedItem.label]
          );
        }
      }

      if (normalizedStarred) {
        await client.query("DELETE FROM user_starred_tokens WHERE user_id = $1 AND chain = 'solana'", [req.user.id]);
        for (const starredItem of normalizedStarred) {
          await client.query(
            `INSERT INTO user_starred_tokens (user_id, chain, address)
             VALUES ($1, 'solana', $2)
             ON CONFLICT (user_id, chain, address) DO NOTHING`,
            [req.user.id, starredItem.address]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await Promise.all([
      upsertCatalogItemsAndSchedule(normalizedTokens, 'user-manual'),
      upsertCatalogItems(normalizedBlocklist, 'blocklist'),
      upsertCatalogItems(normalizedStarred, 'starred'),
      ...removedManualTokenCandidates.map((address) => tokenCatalog.demoteFormerManualAddress(address)),
    ]);
    userAlertProfileCache.invalidateUserProfile(req.user.id);
    await notifyUserConfigChangedIfNeeded(req.user.id, validatedConfigs !== null);
    const result = {
      configs: await userConfig.getAll(req.user.id),
      uiPrefs: await userUiPref.getAll(req.user.id),
      tokens: await userToken.getAllForChains(req.user.id, USER_COLLECTION_CHAINS),
      blocklist: await userBlocklist.getAllForChains(req.user.id, USER_COLLECTION_CHAINS),
      starredTokens: await userStarredToken.getAllForChains(req.user.id, USER_COLLECTION_CHAINS),
      availableChains: buildAvailableTokenChains(),
      chainReadiness: await getWorkspaceChainReadiness(),
      runtimeFlags: buildRuntimeFlags(),
    };

    const responsePayload = { message: 'Config synced', ...result };
    res.json(responsePayload);
  } catch (err) {
    console.error('PUT /config error:', err.message);
    res.status(500).json({ error: 'Failed to sync configs' });
  }
});

/**
 * PATCH /api/config
 * Partial update — only updates keys that are sent.
 * Body: { configs: {...} }
 */
router.patch('/', async (req, res) => {
  try {
    const configs = stripRestrictedConfigKeys(req.body?.configs, req.user);

    if (!configs || typeof configs !== 'object' || Object.keys(configs).length === 0) {
      return res.status(400).json({ error: 'configs object is required' });
    }

    const validation = userConfig.validateConfigs(configs);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid config values',
        details: validation.errors,
      });
    }

    // Reject if nothing valid to update
    if (Object.keys(validation.configs).length === 0) {
      return res.status(400).json({ error: 'No valid config keys to update' });
    }

    await userConfig.setMultiple(req.user.id, validation.configs);
    userAlertProfileCache.invalidateUserProfile(req.user.id);
    await notifyUserConfigChanged(req.user.id);
    const responsePayload = { message: 'Config updated', configs: validation.configs };
    res.json(responsePayload);
  } catch (err) {
    console.error('PATCH /config error:', err.message);
    res.status(500).json({ error: 'Failed to update configs' });
  }
});

router.patch('/ui-prefs', async (req, res) => {
  try {
    const uiPrefs = req.body?.uiPrefs;

    if (!uiPrefs || typeof uiPrefs !== 'object' || Array.isArray(uiPrefs) || Object.keys(uiPrefs).length === 0) {
      return res.status(400).json({ error: 'uiPrefs object is required' });
    }

    const validation = userUiPref.validatePatch(uiPrefs);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid UI preference values',
        details: validation.errors,
      });
    }

    const nextUiPrefs = await userUiPref.patch(req.user.id, validation.prefs);
    res.json({ message: 'UI preferences updated', uiPrefs: nextUiPrefs });
  } catch (err) {
    console.error('PATCH /config/ui-prefs error:', err.message);
    res.status(500).json({ error: 'Failed to update UI preferences' });
  }
});

// ══════════════════════════════════════════════════════════════════
//  MANUAL TOKENS
// ══════════════════════════════════════════════════════════════════

/**
 * POST /api/config/tokens
 * Add a manual token.
 * Body: { address, label? }
 */
router.post('/tokens', async (req, res) => {
  try {
    const { address, label, chain } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'address is required' });
    }

    const identity = normalizeCollectionIdentity(address, chain);
    const normalizedLabel = normalizeText(label, 128);

    // Check limit
    const currentCount = await userToken.count(req.user.id, identity.chain);
    if (currentCount >= MAX_TOKENS) {
      return res.status(400).json({
        error: `Maximum ${MAX_TOKENS} manual tokens reached`,
      });
    }

    const result = await userToken.add(req.user.id, identity.address, normalizedLabel, identity.chain);
    if (!result) {
      return res.status(409).json({ error: 'Token already added' });
    }

    try {
      await manualTokenBootstrap.upsertManualCatalogToken(identity.address, { chain: identity.chain });
    } catch (catalogErr) {
      console.error(`[TokenCatalog] Failed to catalog manual token ${identity.chain}:${identity.address}:`, catalogErr.message);
    }

    res.status(201).json({ message: 'Token added', token: result });
  } catch (err) {
    console.error('POST /config/tokens error:', err.message);
    sendRouteError(res, err, 'Failed to add token');
  }
});

/**
 * DELETE /api/config/tokens/:address
 * Remove a manual token.
 */
router.delete('/tokens/:address', async (req, res) => {
  try {
    const identity = normalizeCollectionIdentity(req.params.address, req.query.chain);
    const removed = await userToken.remove(req.user.id, identity.address, identity.chain);

    if (!removed) {
      return res.status(404).json({ error: 'Token not found' });
    }

    await tokenCatalog.demoteFormerManualAddress(identity.address, identity.chain);

    res.json({ message: 'Token removed' });
  } catch (err) {
    console.error('DELETE /config/tokens error:', err.message);
    sendRouteError(res, err, 'Failed to remove token');
  }
});

// ══════════════════════════════════════════════════════════════════
//  MANUAL TOKEN FOLDERS
// ══════════════════════════════════════════════════════════════════

router.get('/token-folders', async (req, res) => {
  try {
    const result = await userTokenFolder.listForUser(req.user.id);
    res.json(result);
  } catch (err) {
    console.error('GET /config/token-folders error:', err.message);
    sendRouteError(res, err, 'Failed to load token folders');
  }
});

router.post('/token-folders', async (req, res) => {
  try {
    if (req.body?.parentFolderId !== null && req.body?.parentFolderId !== undefined) {
      return res.status(400).json({ error: 'Subfolders are not supported' });
    }

    const folder = await userTokenFolder.createFolder(req.user.id, {
      name: req.body?.name,
      sortOrder: req.body?.sortOrder,
    });
    res.status(201).json({ message: 'Folder created', folder });
  } catch (err) {
    console.error('POST /config/token-folders error:', err.message);
    sendRouteError(res, err, 'Failed to create token folder');
  }
});

router.patch('/token-folders/:folderId', async (req, res) => {
  try {
    if (req.body?.parentFolderId !== null && req.body?.parentFolderId !== undefined) {
      return res.status(400).json({ error: 'Subfolders are not supported' });
    }

    const folder = await userTokenFolder.updateFolder(req.user.id, req.params.folderId, {
      ...(Object.hasOwn(req.body || {}, 'name') ? { name: req.body.name } : {}),
      ...(Object.hasOwn(req.body || {}, 'sortOrder') ? { sortOrder: req.body.sortOrder } : {}),
    });

    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    res.json({ message: 'Folder updated', folder });
  } catch (err) {
    console.error('PATCH /config/token-folders/:folderId error:', err.message);
    sendRouteError(res, err, 'Failed to update token folder');
  }
});

router.delete('/token-folders/:folderId', async (req, res) => {
  try {
    const result = await userTokenFolder.deleteFolderAndManualTokens(req.user.id, req.params.folderId);
    if (!result.deleted) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    await Promise.all(result.removedIdentities.map((identity) => (
      tokenCatalog.demoteFormerManualAddress(identity.address, identity.chain)
    )));

    res.json({
      message: 'Folder deleted',
      removedTokens: result.removedAddresses,
      removedTokenIdentities: result.removedIdentities,
    });
  } catch (err) {
    console.error('DELETE /config/token-folders/:folderId error:', err.message);
    sendRouteError(res, err, 'Failed to delete token folder');
  }
});

router.post('/token-folders/:folderId/tokens', async (req, res) => {
  try {
    const identity = normalizeCollectionIdentity(req.body?.address, req.body?.chain);

    const folderExists = await userTokenFolder.folderExists(req.user.id, req.params.folderId);
    if (!folderExists) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const alreadyManual = await userToken.exists(req.user.id, identity.address, identity.chain);
    if (!alreadyManual) {
      const currentCount = await userToken.count(req.user.id, identity.chain);
      if (currentCount >= MAX_TOKENS) {
        return res.status(400).json({
          error: `Maximum ${MAX_TOKENS} manual tokens reached`,
        });
      }

      const addedToken = await userToken.add(req.user.id, identity.address, null, identity.chain);
      if (addedToken) {
        try {
          await manualTokenBootstrap.upsertManualCatalogToken(identity.address, { chain: identity.chain });
        } catch (catalogErr) {
          console.error(`[TokenCatalog] Failed to catalog manual token ${identity.chain}:${identity.address}:`, catalogErr.message);
        }
      }
    }

    const item = await userTokenFolder.addTokenToFolder(req.user.id, req.params.folderId, identity.address, {
      chain: identity.chain,
      sortOrder: req.body?.sortOrder,
    });

    if (!item) {
      return res.status(404).json({ error: 'Folder token not found' });
    }

    res.status(201).json({ message: 'Token added to folder', item, tokenCreated: !alreadyManual });
  } catch (err) {
    console.error('POST /config/token-folders/:folderId/tokens error:', err.message);
    sendRouteError(res, err, 'Failed to add token to folder');
  }
});

router.delete('/token-folders/:folderId/tokens/:address', async (req, res) => {
  try {
    const identity = normalizeCollectionIdentity(req.params.address, req.query.chain);
    const result = await userTokenFolder.deleteFolderTokenAndManualToken(
      req.user.id,
      req.params.folderId,
      identity.address,
      { chain: identity.chain }
    );
    if (!result.deleted) {
      return res.status(404).json({ error: 'Folder token not found' });
    }

    await tokenCatalog.demoteFormerManualAddress(result.removedAddress, result.removedChain);
    res.json({ message: 'Token removed', removed: {
      chain: result.removedChain, address: result.removedAddress,
    } });
  } catch (err) {
    console.error('DELETE /config/token-folders/:folderId/tokens/:address error:', err.message);
    sendRouteError(res, err, 'Failed to remove folder token');
  }
});

// ══════════════════════════════════════════════════════════════════
//  BLOCKLIST
// ══════════════════════════════════════════════════════════════════

/**
 * POST /api/config/blocklist
 * Block a token.
 * Body: { address, label? }
 */
router.post('/blocklist', async (req, res) => {
  try {
    const { address, label, chain } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'address is required' });
    }

    const identity = normalizeCollectionIdentity(address, chain);
    const normalizedLabel = normalizeText(label, 128);

    if (await userBlocklist.count(req.user.id, identity.chain) >= MAX_BLOCKLIST) {
      return res.status(400).json({
        error: `Maximum ${MAX_BLOCKLIST} blocked tokens reached`,
      });
    }

    const result = await userBlocklist.add(
      req.user.id, identity.address, normalizedLabel, identity.chain,
    );
    if (!result) {
      return res.status(409).json({ error: 'Token already blocked' });
    }

    try {
      if (identity.chain !== 'solana') {
        return res.status(201).json({ message: 'Token blocked', blocked: result });
      }
      await tokenCatalog.upsertToken({
        address: identity.address,
        chain: 'solana',
        source: 'blocklist',
      });
    } catch (catalogErr) {
      console.error(`[TokenCatalog] Failed to catalog blocked token ${identity.address}:`, catalogErr.message);
    }

    res.status(201).json({ message: 'Token blocked', blocked: result });
  } catch (err) {
    console.error('POST /config/blocklist error:', err.message);
    sendRouteError(res, err, 'Failed to block token');
  }
});

/**
 * DELETE /api/config/blocklist/:address
 * Unblock a token.
 */
router.delete('/blocklist/:address', async (req, res) => {
  try {
    const identity = normalizeCollectionIdentity(req.params.address, req.query.chain);
    const removed = await userBlocklist.remove(req.user.id, identity.address, identity.chain);

    if (!removed) {
      return res.status(404).json({ error: 'Blocked token not found' });
    }

    res.json({ message: 'Token unblocked' });
  } catch (err) {
    console.error('DELETE /config/blocklist error:', err.message);
    sendRouteError(res, err, 'Failed to unblock token');
  }
});

router.post('/starred', async (req, res) => {
  try {
    const identity = normalizeCollectionIdentity(req.body?.address, req.body?.chain);
    if (await userStarredToken.count(req.user.id, identity.chain) >= MAX_STARRED) {
      return res.status(400).json({ error: `Maximum ${MAX_STARRED} starred tokens reached` });
    }
    const starred = await userStarredToken.add(req.user.id, identity.address, identity.chain);
    if (!starred) return res.status(409).json({ error: 'Token already starred' });
    res.status(201).json({ message: 'Token starred', starred });
  } catch (err) {
    console.error('POST /config/starred error:', err.message);
    sendRouteError(res, err, 'Failed to star token');
  }
});

router.delete('/starred/:address', async (req, res) => {
  try {
    const identity = normalizeCollectionIdentity(req.params.address, req.query.chain);
    const removed = await userStarredToken.remove(req.user.id, identity.address, identity.chain);
    if (!removed) return res.status(404).json({ error: 'Starred token not found' });
    res.json({ message: 'Star removed' });
  } catch (err) {
    console.error('DELETE /config/starred error:', err.message);
    sendRouteError(res, err, 'Failed to remove star');
  }
});

module.exports = router;
