const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const PASSWORD_HASH = process.env.APP_PASSWORD_HASH;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// In-memory session store — token → { createdAt, ip, userAgent }
const sessions = new Map();

// Brute-force protection: 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});

function generateSessionToken() {
  return crypto.randomBytes(48).toString('hex');
}

function signToken(token) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(token);
  return token + '.' + hmac.digest('hex');
}

function verifySignedToken(signedToken) {
  if (!signedToken || !signedToken.includes('.')) return null;
  const [token, sig] = signedToken.split('.');
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(token);
  const expected = hmac.digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  return token;
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, data] of sessions) {
    if (now - data.createdAt > SESSION_MAX_AGE) sessions.delete(token);
  }
}
setInterval(cleanExpiredSessions, 60 * 60 * 1000);

function requireAuth(req, res, next) {
  const signed = req.cookies?.fiori_session;
  if (!signed) return res.status(401).json({ error: 'Authentication required' });

  const token = verifySignedToken(signed);
  if (!token) return res.status(401).json({ error: 'Invalid session' });

  const session = sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Session expired' });

  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  next();
}

function isAuthenticated(req) {
  const signed = req.cookies?.fiori_session;
  if (!signed) return false;
  const token = verifySignedToken(signed);
  if (!token || !sessions.has(token)) return false;
  const session = sessions.get(token);
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Login
router.post('/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const match = await bcrypt.compare(password, PASSWORD_HASH);
  if (!match) {
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const token = generateSessionToken();
  sessions.set(token, { createdAt: Date.now(), ip: req.ip, userAgent: req.headers['user-agent'] });

  const signed = signToken(token);
  res.cookie('fiori_session', signed, {
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/'
  });

  res.json({ success: true });
});

// Status check
router.get('/status', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// Logout
router.post('/logout', (req, res) => {
  const signed = req.cookies?.fiori_session;
  if (signed) {
    const token = verifySignedToken(signed);
    if (token) sessions.delete(token);
  }
  res.clearCookie('fiori_session', { path: '/' });
  res.json({ success: true });
});

module.exports = { router, requireAuth, isAuthenticated };
