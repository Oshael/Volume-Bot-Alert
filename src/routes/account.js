const express = require('express');
const { authenticateAllowExpiredAccess } = require('../middleware/auth');
const userAccess = require('../models/user-access');

const router = express.Router();

router.get('/access', authenticateAllowExpiredAccess, async (req, res) => {
  try {
    res.json(userAccess.buildAccessSnapshot(req.user));
  } catch (err) {
    console.error('Account access status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
