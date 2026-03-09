const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const db = require('../models/db');
const userConfig = require('../models/user-config');
const userToken = require('../models/user-token');
const userBlocklist = require('../models/user-blocklist');
const userStarredToken = require('../models/user-starred-token');

// All config routes require authentication
router.use(authenticate);

// ── Limites ────────────────────────────────────────────────────────
const MAX_TOKENS = 200;      // máx tokens manuais por user
const MAX_BLOCKLIST = 500;   // máx blocklist por user
const MAX_STARRED = 500;     // max favorites per user

function normalizeAddressItems(items) {
  return items
    .map((item) => {
      if (typeof item === 'string') {
        return { address: item.trim(), label: null };
      }

      if (!item || typeof item !== 'object') {
        return { address: '', label: null };
      }

      return {
        address: String(item.address || '').trim(),
        label: item.label == null ? null : String(item.label).trim() || null,
      };
    })
    .filter((item) => item.address);
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
    const configs = await userConfig.getAll(req.user.id);
    const tokens = await userToken.getAll(req.user.id);
    const blocklist = await userBlocklist.getAll(req.user.id);
    const starredTokens = await userStarredToken.getAll(req.user.id);

    res.json({
      configs,
      tokens,
      blocklist,
      starredTokens,
    });
  } catch (err) {
    console.error('GET /config error:', err.message);
    res.status(500).json({ error: 'Failed to load configs' });
  }
});

/**
 * PUT /api/config
 * Replace ALL configs + tokens + blocklist (full sync).
 * Body: { configs: {...}, tokens: [...], blocklist: [...] }
 */
router.put('/', async (req, res) => {
  try {
    const { configs, tokens, blocklist, starredTokens } = req.body;
    let validatedConfigs = null;
    let normalizedTokens = null;
    let normalizedBlocklist = null;
    let normalizedStarred = null;

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
      const invalid = normalizedTokens.filter((t) => !userToken.isValidAddress(t.address));
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
      const invalid = normalizedBlocklist.filter((item) => !userToken.isValidAddress(item.address));
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
      const invalid = normalizedStarred.filter((item) => !userToken.isValidAddress(item.address));
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
        await client.query('DELETE FROM user_tokens WHERE user_id = $1', [req.user.id]);
        for (const tokenItem of normalizedTokens) {
          await client.query(
            `INSERT INTO user_tokens (user_id, address, label)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, address) DO NOTHING`,
            [req.user.id, tokenItem.address, tokenItem.label]
          );
        }
      }

      if (normalizedBlocklist) {
        await client.query('DELETE FROM user_blocklist WHERE user_id = $1', [req.user.id]);
        for (const blockedItem of normalizedBlocklist) {
          await client.query(
            `INSERT INTO user_blocklist (user_id, address, label)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, address) DO NOTHING`,
            [req.user.id, blockedItem.address, blockedItem.label]
          );
        }
      }

      if (normalizedStarred) {
        await client.query('DELETE FROM user_starred_tokens WHERE user_id = $1', [req.user.id]);
        for (const starredItem of normalizedStarred) {
          await client.query(
            `INSERT INTO user_starred_tokens (user_id, address)
             VALUES ($1, $2)
             ON CONFLICT (user_id, address) DO NOTHING`,
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

    const result = {
      configs: await userConfig.getAll(req.user.id),
      tokens: await userToken.getAll(req.user.id),
      blocklist: await userBlocklist.getAll(req.user.id),
      starredTokens: await userStarredToken.getAll(req.user.id),
    };

    res.json({ message: 'Config synced', ...result });
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
    const { configs } = req.body;

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

    const updated = await userConfig.getAll(req.user.id);
    res.json({ message: 'Config updated', configs: updated });
  } catch (err) {
    console.error('PATCH /config error:', err.message);
    res.status(500).json({ error: 'Failed to update configs' });
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
    const { address, label } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'address is required' });
    }

    const addr = address.trim();
    if (!userToken.isValidAddress(addr)) {
      return res.status(400).json({ error: 'Invalid token address format' });
    }

    // Check limit
    const currentCount = await userToken.count(req.user.id);
    if (currentCount >= MAX_TOKENS) {
      return res.status(400).json({
        error: `Maximum ${MAX_TOKENS} manual tokens reached`,
      });
    }

    const result = await userToken.add(req.user.id, addr, label || null);
    if (!result) {
      return res.status(409).json({ error: 'Token already added' });
    }

    res.status(201).json({ message: 'Token added', token: result });
  } catch (err) {
    console.error('POST /config/tokens error:', err.message);
    res.status(500).json({ error: 'Failed to add token' });
  }
});

/**
 * DELETE /api/config/tokens/:address
 * Remove a manual token.
 */
router.delete('/tokens/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const removed = await userToken.remove(req.user.id, address);

    if (!removed) {
      return res.status(404).json({ error: 'Token not found' });
    }

    res.json({ message: 'Token removed' });
  } catch (err) {
    console.error('DELETE /config/tokens error:', err.message);
    res.status(500).json({ error: 'Failed to remove token' });
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
    const { address, label } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'address is required' });
    }

    const addr = address.trim();
    if (!userToken.isValidAddress(addr)) {
      return res.status(400).json({ error: 'Invalid token address format' });
    }

    const currentList = await userBlocklist.getAll(req.user.id);
    if (currentList.length >= MAX_BLOCKLIST) {
      return res.status(400).json({
        error: `Maximum ${MAX_BLOCKLIST} blocked tokens reached`,
      });
    }

    const result = await userBlocklist.add(req.user.id, addr, label || null);
    if (!result) {
      return res.status(409).json({ error: 'Token already blocked' });
    }

    res.status(201).json({ message: 'Token blocked', blocked: result });
  } catch (err) {
    console.error('POST /config/blocklist error:', err.message);
    res.status(500).json({ error: 'Failed to block token' });
  }
});

/**
 * DELETE /api/config/blocklist/:address
 * Unblock a token.
 */
router.delete('/blocklist/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const removed = await userBlocklist.remove(req.user.id, address);

    if (!removed) {
      return res.status(404).json({ error: 'Blocked token not found' });
    }

    res.json({ message: 'Token unblocked' });
  } catch (err) {
    console.error('DELETE /config/blocklist error:', err.message);
    res.status(500).json({ error: 'Failed to unblock token' });
  }
});

module.exports = router;
