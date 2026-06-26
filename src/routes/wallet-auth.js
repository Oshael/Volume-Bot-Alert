const express = require('express');
const walletAuthService = require('../services/wallet-auth-service');
const User = require('../models/user');
const { clearAuthCookie, createAuthenticatedSession } = require('../services/auth-session');
const {
  clearPreAccessCookie,
  issuePreAccessFlow,
  isBillingRecoveryAccess,
  isHardBlockedAccess,
} = require('../services/pre-access-session');
const { authLimiter } = require('../middleware/rate-limit');
const { authenticate, requireTrustedOrigin } = require('../middleware/auth');

const router = express.Router();

function handleWalletAuthError(res, err, label) {
  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Internal server error' });
}

router.post('/challenge', authLimiter, requireTrustedOrigin, async (req, res) => {
  try {
    clearAuthCookie(res);
    const challenge = await walletAuthService.createChallenge({
      walletAddress: req.body?.walletAddress,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.json(challenge);
  } catch (err) {
    return handleWalletAuthError(res, err, 'Wallet auth challenge error');
  }
});

router.post('/verify', authLimiter, requireTrustedOrigin, async (req, res) => {
  try {
    clearAuthCookie(res);
    const result = await walletAuthService.verifyWalletSignature({
      walletAddress: req.body?.walletAddress,
      message: req.body?.message,
      signature: req.body?.signature,
      walletProvider: req.body?.walletProvider,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (result.mode === 'insufficient_balance') {
      return res.status(403).json({
        error: 'Wallet does not meet token access requirements',
        ...result,
      });
    }

    if (isHardBlockedAccess(result.access)) {
      return res.status(403).json({ error: result.access.denialReason || 'Access revoked' });
    }

    if (result.access?.hasProductAccess && result.user?.id) {
      const user = await User.findById(result.user.id);
      clearPreAccessCookie(res);
      const sessionPayload = await createAuthenticatedSession({
        user,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        res,
      });
      return res.json({
        ...sessionPayload,
        wallet: result.wallet,
        tokenSnapshot: result.tokenSnapshot,
        access: result.access,
        mode: result.mode,
      });
    }

    if (result.user?.id && isBillingRecoveryAccess(result.access)) {
      const user = await User.findById(result.user.id);
      clearAuthCookie(res);
      return res.json({
        ...issuePreAccessFlow({ user, res }),
        wallet: result.wallet,
        tokenSnapshot: result.tokenSnapshot,
        access: result.access,
        mode: result.mode,
      });
    }

    return res.json(result);
  } catch (err) {
    return handleWalletAuthError(res, err, 'Wallet auth verify error');
  }
});

router.post('/link/challenge', authLimiter, authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    const challenge = await walletAuthService.createChallenge({
      walletAddress: req.body?.walletAddress,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    return res.json(challenge);
  } catch (err) {
    return handleWalletAuthError(res, err, 'Wallet link challenge error');
  }
});

router.post('/link/verify', authLimiter, authenticate, requireTrustedOrigin, async (req, res) => {
  try {
    const result = await walletAuthService.linkWalletForUser(req.user, {
      walletAddress: req.body?.walletAddress,
      message: req.body?.message,
      signature: req.body?.signature,
      walletProvider: req.body?.walletProvider,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({
      message: result.mode === 'wallet_already_linked'
        ? 'Wallet already linked. Token balance refreshed.'
        : 'Wallet linked. Token balance refreshed.',
      ...result,
    });
  } catch (err) {
    return handleWalletAuthError(res, err, 'Wallet link verify error');
  }
});

module.exports = router;
