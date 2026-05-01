const express = require('express');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const mockTrading = require('../services/mock-trading-service');

const router = express.Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireTrustedOrigin);

function handleMockTradingError(res, err, fallbackMessage) {
  if (err instanceof mockTrading.MockTradingError) {
    return res.status(err.statusCode || 400).json({
      error: err.message,
      code: err.code,
    });
  }

  console.error('Mock trading route error:', err);
  return res.status(500).json({ error: fallbackMessage });
}

router.get('/summary', async (req, res) => {
  try {
    const summary = await mockTrading.getSummary(req.user.id);
    res.json(summary);
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to load mock trading summary');
  }
});

router.get('/positions', async (req, res) => {
  try {
    const positions = await mockTrading.listPositions(req.user.id);
    res.json({
      generatedAt: new Date().toISOString(),
      count: positions.length,
      positions,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to load mock trading positions');
  }
});

router.get('/trades', async (req, res) => {
  try {
    const trades = await mockTrading.listTrades({
      userId: req.user.id,
      address: req.query?.address,
      limit: req.query?.limit,
    });
    res.json({
      generatedAt: new Date().toISOString(),
      count: trades.length,
      trades,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to load mock trading trades');
  }
});

router.post('/buy', async (req, res) => {
  try {
    const result = await mockTrading.buyToken({
      userId: req.user.id,
      address: req.body?.address,
      notionalUsd: req.body?.notionalUsd,
      takeProfitMcapUsd: req.body?.takeProfitMcapUsd,
      takeProfitSellPercent: req.body?.takeProfitSellPercent,
    });
    res.status(201).json({
      message: 'Mock buy executed',
      ...result,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to execute mock buy');
  }
});

router.post('/sell', async (req, res) => {
  try {
    const result = await mockTrading.sellToken({
      userId: req.user.id,
      address: req.body?.address,
      quantity: req.body?.quantity,
      percent: req.body?.percent,
    });
    res.json({
      message: 'Mock sell executed',
      ...result,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to execute mock sell');
  }
});

router.post('/take-profit-orders', async (req, res) => {
  try {
    const result = await mockTrading.createTakeProfitOrderForPosition({
      userId: req.user.id,
      address: req.body?.address,
      takeProfitMcapUsd: req.body?.takeProfitMcapUsd,
      takeProfitSellPercent: req.body?.takeProfitSellPercent,
    });
    res.status(201).json({
      message: 'Mock sell order created',
      order: result.takeProfitOrder,
      ...result,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to create mock sell order');
  }
});

router.post('/take-profit-orders/:id/cancel', async (req, res) => {
  try {
    const order = await mockTrading.cancelTakeProfitOrder({
      userId: req.user.id,
      orderId: req.params.id,
    });
    res.json({
      message: 'Mock sell order cancelled',
      order,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to cancel mock sell order');
  }
});

router.post('/reset', async (req, res) => {
  try {
    const account = await mockTrading.resetAccount({
      userId: req.user.id,
      startingCashUsd: req.body?.startingCashUsd,
    });
    res.json({
      message: 'Mock trading portfolio reset',
      account,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to reset mock trading portfolio');
  }
});

module.exports = router;
