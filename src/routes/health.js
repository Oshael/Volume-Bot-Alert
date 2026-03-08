const express = require('express');
const { pool } = require('../models/db');

const router = express.Router();

/**
 * GET /api/health
 * Public health check endpoint.
 */
router.get('/', async (req, res) => {
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    const dbMs = Date.now() - dbStart;

    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      db: { connected: true, latencyMs: dbMs },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      db: { connected: false, error: err.message },
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
