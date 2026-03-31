const express = require('express');
const { authenticate, authenticateAllowExpiredAccess } = require('../middleware/auth');
const userAccess = require('../models/user-access');
const UserSocialIdentity = require('../models/user-social-identity');
const { buildIdentitySnapshot } = require('../services/social-auth');

const router = express.Router();

router.get('/access', authenticateAllowExpiredAccess, async (req, res) => {
  try {
    res.json(userAccess.buildAccessSnapshot(req.user));
  } catch (err) {
    console.error('Account access status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/identities', authenticate, async (req, res) => {
  try {
    const identities = await UserSocialIdentity.listByUserId(req.user.id);
    res.json({
      providers: buildIdentitySnapshot(identities),
    });
  } catch (err) {
    console.error('Account identities status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
