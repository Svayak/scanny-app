// Produktsök: namn, artikelnummer, streckkod och leverantör.
// articleNo kan ligga som tal i äldre data, därför String().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScannySearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FIELDS = ['name', 'articleNo', 'code', 'supplier'];

  function textField(value) {
    if (value == null) return '';
    return String(value).trim();
  }

  function fold(value) {
    return textField(value).toLowerCase();
  }

  function escapeRegex(value) {
    return textField(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function productMatches(product, query) {
    const q = fold(query);
    if (!q) return true;
    const item = product || {};
    return FIELDS.some(key => fold(item[key]).includes(q));
  }

  // $toString så att ett artikelnummer som sparats som tal också träffas.
  function mongoProductFilter(query) {
    const q = fold(query);
    if (!q) return {};
    const pattern = escapeRegex(q);
    return {
      $expr: {
        $or: FIELDS.map(key => ({
          $regexMatch: {
            input: { $toString: { $ifNull: ['$' + key, ''] } },
            regex: pattern,
            options: 'i'
          }
        }))
      }
    };
  }

  return { FIELDS, textField, fold, escapeRegex, productMatches, mongoProductFilter };
});
