const MAX_CATALOG_FDV_USD = 30_000_000_000;

function numericFdv(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isCatalogFdvExcluded(value) {
  const fdv = numericFdv(value);
  return fdv != null && fdv >= MAX_CATALOG_FDV_USD;
}

module.exports = {
  MAX_CATALOG_FDV_USD,
  isCatalogFdvExcluded,
};
