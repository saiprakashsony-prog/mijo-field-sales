const rateLimit = require('express-rate-limit');

// Design notes:
// - Only FAILED attempts count (skipSuccessfulRequests), so normal use is never throttled.
// - The strict limits are per ACCOUNT (mobile) and per employee/distributor CODE, not per IP.
//   Field staff are on mobile networks where many people share one public IP, so a strict
//   per-IP limit would lock out innocent colleagues. Per-IP is only a loose backstop.
const FIFTEEN_MIN = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

function limiter({ windowMs, limit, key, message }) {
  return rateLimit({
    windowMs,
    limit,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: key,
    handler: (req, res) => res.status(429).json({ error: message }),
  });
}

const body = (req, k) => String((req.body && req.body[k]) || '').trim().toLowerCase();

const loginPerAccount = limiter({
  windowMs: FIFTEEN_MIN, limit: 8,
  key: (req) => `acct:${body(req, 'mobile')}`,
  message: 'Too many failed login attempts for this account. Please wait 15 minutes and try again.',
});
const loginPerIp = limiter({
  windowMs: FIFTEEN_MIN, limit: 100,
  key: (req) => `ip:${req.ip}`,
  message: 'Too many failed login attempts from this network. Please wait a while and try again.',
});

const registerPerCode = limiter({
  windowMs: ONE_HOUR, limit: 5,
  key: (req) => `code:${body(req, 'code')}`,
  message: 'Too many failed registration attempts for this code. Please contact your admin.',
});
const registerPerIp = limiter({
  windowMs: ONE_HOUR, limit: 40,
  key: (req) => `ip:${req.ip}`,
  message: 'Too many failed registration attempts from this network. Please try again later.',
});

module.exports = {
  login: [loginPerAccount, loginPerIp],
  selfRegister: [registerPerCode, registerPerIp],
};
