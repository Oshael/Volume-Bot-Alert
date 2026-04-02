const express = require('express');
const { pool } = require('../models/db');
const config = require('../../config');
const { logSecurityEvent } = require('../utils/security-events');

const router = express.Router();
let cachedHealthPayload = null;
let cachedHealthStatusCode = 200;
let cachedAt = 0;

async function computeHealthPayload() {
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    const dbMs = Date.now() - dbStart;

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        runtime: {
          role: config.runtime.role,
          socketEnabled: Boolean(config.runtime.runSocketHub),
          backgroundJobsEnabled: Boolean(config.runtime.runBackgroundJobs),
        },
        db: { connected: true, latencyMs: dbMs },
        timestamp: new Date().toISOString(),
        cached: false,
      },
    };
  } catch (err) {
    return {
      statusCode: 503,
      payload: {
        status: 'error',
        runtime: {
          role: config.runtime.role,
          socketEnabled: Boolean(config.runtime.runSocketHub),
          backgroundJobsEnabled: Boolean(config.runtime.runBackgroundJobs),
        },
        db: { connected: false, error: err.message },
        timestamp: new Date().toISOString(),
        cached: false,
      },
    };
  }
}

/**
 * GET /api/health
 * Public health check endpoint.
 */
router.get('/', async (req, res) => {
  const now = Date.now();
  const cacheTtlMs = Math.max(1000, Number(config.security?.healthCacheMs) || 5000);
  const cacheAgeMs = now - cachedAt;

  if (cachedHealthPayload && cacheAgeMs >= 0 && cacheAgeMs < cacheTtlMs) {
    return res.status(cachedHealthStatusCode).json({
      ...cachedHealthPayload,
      cached: true,
      cacheAgeMs,
    });
  }

  const result = await computeHealthPayload();
  cachedAt = now;
  cachedHealthStatusCode = result.statusCode;
  cachedHealthPayload = result.payload;

  if (result.statusCode !== 200) {
    logSecurityEvent('health_check_failure', {
      route: '/api/health',
      statusCode: result.statusCode,
      dbConnected: false,
    });
  }

  return res.status(result.statusCode).json(result.payload);
});

module.exports = router;
