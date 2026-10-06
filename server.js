require('dotenv').config();
require('express-async-errors'); // lets async route handlers' rejections reach the error middleware below instead of crashing the process
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimits = require('./middleware/rateLimits');
const rejectMarkup = require('./middleware/rejectMarkup');

// ---- Startup check: a guessable JWT secret lets anyone forge an admin login -----------------
const jwtSecret = process.env.JWT_SECRET || '';
const WEAK_SECRETS = ['any long random string', 'change_this_to_a_long_random_string', 'secret', 'password', 'jwtsecret'];
if (jwtSecret.length < 32 || /\s/.test(jwtSecret) || WEAK_SECRETS.includes(jwtSecret.toLowerCase())) {
  console.warn('\n⚠️  SECURITY WARNING: JWT_SECRET is missing, short, or looks like a placeholder.');
  console.warn('   Anyone who guesses it can forge a login for any user, including admin.');
  console.warn('   Set a long random value (e.g. run: openssl rand -hex 32) in your hosting environment variables.\n');
}

const app = express();

// The app sits behind the host's reverse proxy; this makes req.ip the real client address.
app.set('trust proxy', 1);

// ---- Security headers ----------------------------------------------------------------------
// The Content-Security-Policy starts in REPORT-ONLY mode: it logs anything it would block to the
// browser console without breaking anything, so it can be verified against the real screens
// first. Set CSP_ENFORCE=true in the environment to turn on blocking.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    reportOnly: process.env.CSP_ENFORCE !== 'true',
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://unpkg.com', 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://unpkg.com', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'", 'https://nominatim.openstreetmap.org'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      manifestSrc: ["'self'"],
      workerSrc: ["'self'"],
    },
  },
}));

// ---- CORS ----------------------------------------------------------------------------------
// The web app and the mobile app both load the front end from this same server, so no other
// website needs to call the API. Cross-origin access is therefore OFF unless you explicitly
// list origins in ALLOWED_ORIGINS (comma-separated).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false }));

app.use(express.json({ limit: '200kb' }));
app.use(rejectMarkup);

// ---- Brute-force protection on the two unauthenticated entry points ------------------------
app.use('/api/auth/login', rateLimits.login);
app.use('/api/auth/self-register', rateLimits.selfRegister);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/distributors', require('./routes/distributors'));
app.use('/api/territories', require('./routes/territories'));
app.use('/api/mandals', require('./routes/mandals'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/retailers', require('./routes/retailers').router);
app.use('/api/payments', require('./routes/payments'));
app.use('/api/returns', require('./routes/returns'));
app.use('/api/beats', require('./routes/beats'));
app.use('/api/visits', require('./routes/visits'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/schemes', require('./routes/schemes').router);
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/users', require('./routes/users'));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized error handler — keeps a single bad request/DB hiccup from taking the whole server down,
// and never leaks internals (SQL text, stack traces) to the browser.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid request format.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`MIJO Field Sales server running on port ${PORT}`));
