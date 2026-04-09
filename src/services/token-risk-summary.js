function toNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeReasonCodes(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function hasStructuralRiskData(row) {
  return Boolean(
    row?.risk_enrichment_last_enriched_at
    || row?.risk_enrichment_last_attempted_at
    || row?.risk_enrichment_last_error
    || row?.risk_holder_count != null
    || row?.risk_top_10_pct != null
    || row?.risk_top_20_pct != null
    || normalizeReasonCodes(row?.risk_reason_codes).length > 0
  );
}

function buildRiskReviewSummary(row) {
  const label = String(row?.risk_review_label || '').trim().toLowerCase();
  if (!label) {
    return null;
  }

  return {
    label,
    source: String(row?.risk_review_source || '').trim().toLowerCase() || 'manual',
    notes: row?.risk_review_notes || null,
    updatedAt: row?.risk_review_updated_at || null,
  };
}

function buildStructuralRiskSummary(row) {
  if (!hasStructuralRiskData(row)) {
    return null;
  }

  return {
    lastAttemptedAt: row?.risk_enrichment_last_attempted_at || null,
    lastEnrichedAt: row?.risk_enrichment_last_enriched_at || null,
    lastError: row?.risk_enrichment_last_error || null,
    holderCount: toNumberOrNull(row?.risk_holder_count),
    mintAuthorityActive: Boolean(row?.risk_mint_authority_active),
    freezeAuthorityActive: Boolean(row?.risk_freeze_authority_active),
    top10Pct: toNumberOrNull(row?.risk_top_10_pct),
    top20Pct: toNumberOrNull(row?.risk_top_20_pct),
    reasonCodes: normalizeReasonCodes(row?.risk_reason_codes),
  };
}

module.exports = {
  buildRiskReviewSummary,
  buildStructuralRiskSummary,
  normalizeReasonCodes,
  toNumberOrNull,
  __private: {
    hasStructuralRiskData,
  },
};
