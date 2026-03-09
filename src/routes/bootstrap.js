const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const seedPath = path.join(__dirname, '..', '..', 'data', 'initial-monitored-tokens.txt');

let cachedTokens = null;

function loadSeedTokens() {
  if (cachedTokens) return cachedTokens;

  try {
    const raw = fs.readFileSync(seedPath, 'utf8');
    cachedTokens = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .map((address) => ({ address }));
  } catch (err) {
    console.error('Failed to load bootstrap tokens:', err.message);
    cachedTokens = [];
  }

  return cachedTokens;
}

router.use(authenticate);

router.get('/tokens', (req, res) => {
  const tokens = loadSeedTokens();
  res.json({
    tokens,
    count: tokens.length,
    source: 'initial-monitored-tokens',
  });
});

module.exports = router;
