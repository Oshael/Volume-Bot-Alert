const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenRiskReview = require('../src/models/token-risk-review');

describe('token risk review model', () => {
  it('upserts a token risk review label', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: 'So11111111111111111111111111111111111111112',
          label: 'valid',
          source: 'manual',
          notes: 'looks legit',
          created_by: 1,
          updated_by: 1,
          created_at: '2026-04-09T01:00:00.000Z',
          updated_at: '2026-04-09T01:05:00.000Z',
        }],
      };
    };

    try {
      const review = await tokenRiskReview.upsertReview({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        label: 'valid',
        notes: 'looks legit',
        createdBy: 1,
        updatedBy: 1,
      });

      assert.deepEqual(capturedParams, [
        'So11111111111111111111111111111111111111112',
        'valid',
        'manual',
        'looks legit',
        1,
        1,
      ]);
      assert.equal(review.label, 'valid');
      assert.equal(review.source, 'manual');
      assert.equal(review.createdBy, 1);
    } finally {
      db.query = originalQuery;
    }
  });

  it('upserts auto reviews without overriding manual rows', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: 'So11111111111111111111111111111111111111112',
          label: 'valid',
          source: 'manual',
          notes: 'kept by human review',
          created_by: 9,
          updated_by: 9,
          created_at: '2026-04-09T01:00:00.000Z',
          updated_at: '2026-04-09T01:05:00.000Z',
        }],
      };
    };

    try {
      const review = await tokenRiskReview.upsertAutoReview({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        label: 'junk_permanent',
        notes: 'auto/v1_manual_review: holder_concentration_extreme',
      });

      assert.deepEqual(capturedParams, [
        'So11111111111111111111111111111111111111112',
        'junk_probable',
        'auto/v1_manual_review: holder_concentration_extreme',
      ]);
      assert.equal(review.label, 'valid');
      assert.equal(review.source, 'manual');
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists reviews by address', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: 'So11111111111111111111111111111111111111112',
          label: 'junk_probable',
          source: 'auto',
          notes: 'washy',
          created_by: 5,
          updated_by: 7,
          created_at: '2026-04-09T01:00:00.000Z',
          updated_at: '2026-04-09T01:05:00.000Z',
        }],
      };
    };

    try {
      const rows = await tokenRiskReview.listByAddresses([
        'So11111111111111111111111111111111111111112',
      ]);

      assert.deepEqual(capturedParams, [['So11111111111111111111111111111111111111112']]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].label, 'junk_probable');
      assert.equal(rows[0].source, 'auto');
      assert.equal(rows[0].updatedBy, 7);
    } finally {
      db.query = originalQuery;
    }
  });

  it('removes a review by token address', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return { rowCount: 1 };
    };

    try {
      const removed = await tokenRiskReview.remove('So11111111111111111111111111111111111111112');
      assert.deepEqual(capturedParams, ['So11111111111111111111111111111111111111112']);
      assert.equal(removed, true);
    } finally {
      db.query = originalQuery;
    }
  });

  it('removes only auto reviews by token address', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return { rowCount: 1 };
    };

    try {
      const removed = await tokenRiskReview.removeAutoReview('So11111111111111111111111111111111111111112');
      assert.deepEqual(capturedParams, ['So11111111111111111111111111111111111111112']);
      assert.equal(removed, true);
    } finally {
      db.query = originalQuery;
    }
  });
});
