require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');

const { router: authRouter, requireAuth, isAuthenticated } = require('./routes/auth');
const { router: facebookRouter } = require('./routes/facebook');
const { router: instagramRouter } = require('./routes/instagram');
const { router: whatsappRouter } = require('./routes/whatsapp');
const { router: outlookRouter } = require('./routes/outlook');
const { router: todoRouter } = require('./routes/todo');
const { router: notesRouter } = require('./routes/notes');

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(cookieParser());

// Auth routes (public)
app.use('/api/auth', authRouter);

// Protect all /api/* routes except auth and Outlook OAuth callback
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (req.path === '/outlook/callback') return next();
  requireAuth(req, res, next);
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Mount route modules
app.use('/api', facebookRouter);
app.use('/api/instagram', instagramRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/api/outlook', outlookRouter);
app.use('/api/todo', todoRouter);
app.use('/api/notes', notesRouter);

// Catch-all: serve login or dashboard
app.get('/', (req, res) => {
  if (isAuthenticated(req)) {
    return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('*', (req, res) => {
  if (isAuthenticated(req)) {
    return res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Fiori DM Dashboard running at http://localhost:${PORT}\n`);
});
