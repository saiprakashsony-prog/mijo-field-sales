// Stored XSS defence, layer 1 (the screens also escape output, and a Content-Security-Policy
// is layer 3). Nothing this app stores — names, addresses, reasons, notes — legitimately
// contains < or >, so any text field that does is refused before it reaches the database.
// Password fields are exempt, since passwords may contain any character.
const EXEMPT_KEYS = new Set(['password']);

function findMarkup(value, key) {
  if (typeof value === 'string') return !EXEMPT_KEYS.has(key) && /[<>]/.test(value);
  if (Array.isArray(value)) return value.some((v) => findMarkup(v, key));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => findMarkup(v, k));
  return false;
}

module.exports = function rejectMarkup(req, res, next) {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && findMarkup(req.body)) {
    return res.status(400).json({ error: 'Text fields cannot contain the characters < or >. Please remove them and try again.' });
  }
  next();
};
