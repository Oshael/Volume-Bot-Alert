const express = require('express');
const { authenticate, requireAdmin, requireTrustedOrigin } = require('../middleware/auth');
const mockTrading = require('../services/mock-trading-service');
const solUsdPrice = require('../services/sol-usd-price-service');

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

function getWalletId(req) {
  return req.body?.walletId ?? req.query?.walletId;
}

router.get('/wallets', async (req, res) => {
  try {
    const wallets = await mockTrading.listWallets(req.user.id);
    res.json({
      generatedAt: new Date().toISOString(),
      count: wallets.length,
      wallets,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to load mock trading wallets');
  }
});

router.post('/wallets', async (req, res) => {
  try {
    const wallet = await mockTrading.createWallet({
      userId: req.user.id,
      name: req.body?.name,
    });
    res.status(201).json({
      message: 'Mock trading wallet created',
      wallet,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to create mock trading wallet');
  }
});

router.patch('/wallets/:walletId', async (req, res) => {
  try {
    const wallet = await mockTrading.updateWallet({
      userId: req.user.id,
      walletId: req.params.walletId,
      name: req.body?.name,
    });
    res.json({
      message: 'Mock trading wallet updated',
      wallet,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to update mock trading wallet');
  }
});

router.post('/wallets/:walletId/default', async (req, res) => {
  try {
    const wallet = await mockTrading.setDefaultWallet({
      userId: req.user.id,
      walletId: req.params.walletId,
    });
    res.json({
      message: 'Mock trading default wallet updated',
      wallet,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to update mock trading default wallet');
  }
});

router.post('/wallets/:walletId/archive', async (req, res) => {
  try {
    const wallet = await mockTrading.archiveWallet({
      userId: req.user.id,
      walletId: req.params.walletId,
    });
    res.json({
      message: 'Mock trading wallet archived',
      wallet,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to archive mock trading wallet');
  }
});

router.get('/summary', async (req, res) => {
  try {
    const summary = await mockTrading.getSummary(req.user.id, { walletId: getWalletId(req) });
    res.json(summary);
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to load mock trading summary');
  }
});

router.get('/sol-price', async (req, res) => {
  res.json(solUsdPrice.getStatus());
});

router.get('/positions', async (req, res) => {
  try {
    const positions = await mockTrading.listPositions(req.user.id, { walletId: getWalletId(req) });
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
      walletId: getWalletId(req),
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
      walletId: getWalletId(req),
      address: req.body?.address,
      notionalUsd: req.body?.notionalUsd,
      notionalSol: req.body?.notionalSol,
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
      walletId: getWalletId(req),
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
      walletId: getWalletId(req),
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
      walletId: getWalletId(req),
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
      walletId: getWalletId(req),
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

router.post('/add-cash', async (req, res) => {
  try {
    const result = await mockTrading.addCash({
      userId: req.user.id,
      walletId: getWalletId(req),
      amountUsd: req.body?.amountUsd,
      amountSol: req.body?.amountSol,
    });
    res.json({
      message: 'Mock cash added',
      ...result,
    });
  } catch (err) {
    handleMockTradingError(res, err, 'Failed to add mock trading cash');
  }
});

module.exports = router;
