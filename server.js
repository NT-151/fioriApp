require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ══════════════════════════════════════════════════════════════════════
//  AUTHENTICATION
// ══════════════════════════════════════════════════════════════════════

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

// Auth check middleware — protects all /api/* routes (except /api/auth/*)
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

// Login endpoint
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Constant-time comparison via bcrypt
  const match = await bcrypt.compare(password, PASSWORD_HASH);
  if (!match) {
    // Deliberate delay to slow timing attacks
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const token = generateSessionToken();
  sessions.set(token, { createdAt: Date.now(), ip: req.ip, userAgent: req.headers['user-agent'] });

  const signed = signToken(token);
  res.cookie('fiori_session', signed, {
    httpOnly: true,
    secure: false,       // set to true if using HTTPS
    sameSite: 'strict',
    maxAge: SESSION_MAX_AGE,
    path: '/'
  });

  res.json({ success: true });
});

// Session status check
app.get('/api/auth/status', (req, res) => {
  const signed = req.cookies?.fiori_session;
  if (!signed) return res.json({ authenticated: false });
  const token = verifySignedToken(signed);
  if (!token || !sessions.has(token)) return res.json({ authenticated: false });
  const session = sessions.get(token);
  if (Date.now() - session.createdAt > SESSION_MAX_AGE) {
    sessions.delete(token);
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const signed = req.cookies?.fiori_session;
  if (signed) {
    const token = verifySignedToken(signed);
    if (token) sessions.delete(token);
  }
  res.clearCookie('fiori_session', { path: '/' });
  res.json({ success: true });
});

// Protect ALL /api/* routes except auth
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  // Allow Outlook OAuth callback through
  if (req.path === '/outlook/callback') return next();
  requireAuth(req, res, next);
});

// Serve login page for unauthenticated users, dashboard for authenticated
app.use(express.static(path.join(__dirname, 'public')));

const FB_GRAPH = 'https://graph.facebook.com/v21.0';
const IG_GRAPH = 'https://graph.instagram.com/v21.0';
const FB_TOKEN = process.env.FB_ACCESS_TOKEN;
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;
const WA_TOKEN = process.env.WA_ACCESS_TOKEN;

let fbPageInfo = null; // cached page identity

// The FB token may be a Page Access Token directly or a User token.
// We detect which by trying /me first.
async function getFbPageInfo() {
  if (fbPageInfo) return fbPageInfo;

  const meRes = await axios.get(`${FB_GRAPH}/me`, {
    params: { access_token: FB_TOKEN, fields: 'id,name' }
  });

  // Try /me/accounts (works for user tokens)
  try {
    const acctRes = await axios.get(`${FB_GRAPH}/me/accounts`, {
      params: { access_token: FB_TOKEN, fields: 'id,name,access_token,instagram_business_account' }
    });
    if (acctRes.data.data?.length) {
      // User token — use the first page
      const pages = acctRes.data.data;
      fbPageInfo = {
        pages: pages.map(p => ({
          id: p.id,
          name: p.name,
          token: p.access_token,
          hasInstagram: !!p.instagram_business_account,
          instagramId: p.instagram_business_account?.id || null
        }))
      };
      return fbPageInfo;
    }
  } catch (_) {
    // /me/accounts failed — this is a Page Access Token
  }

  // Direct Page Access Token
  fbPageInfo = {
    pages: [{
      id: meRes.data.id,
      name: meRes.data.name,
      token: FB_TOKEN,
      hasInstagram: false,
      instagramId: null
    }]
  };
  return fbPageInfo;
}

function getPageToken(pageId) {
  if (!fbPageInfo) return FB_TOKEN;
  const page = fbPageInfo.pages.find(p => p.id === pageId);
  return page?.token || FB_TOKEN;
}

// ══════════════════════════════════════════════════════════════════════
//  STATUS / CONFIG ENDPOINTS
// ══════════════════════════════════════════════════════════════════════

app.get('/api/me', async (req, res) => {
  try {
    const r = await axios.get(`${FB_GRAPH}/me`, {
      params: { access_token: FB_TOKEN, fields: 'id,name' }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/api/pages', async (req, res) => {
  try {
    const info = await getFbPageInfo();
    const result = info.pages.map(p => ({
      id: p.id,
      name: p.name,
      hasInstagram: p.hasInstagram,
      instagramId: p.instagramId
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  FACEBOOK MESSENGER
// ══════════════════════════════════════════════════════════════════════

app.get('/api/facebook/conversations/:pageId', async (req, res) => {
  try {
    await getFbPageInfo();
    const token = getPageToken(req.params.pageId);

    const r = await axios.get(`${FB_GRAPH}/${req.params.pageId}/conversations`, {
      params: {
        access_token: token,
        fields: 'id,updated_time,participants,snippet,unread_count,message_count',
        limit: 50
      }
    });
    res.json(r.data.data || []);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/api/facebook/messages/:conversationId', async (req, res) => {
  try {
    await getFbPageInfo();
    const token = getPageToken(req.query.pageId);

    const r = await axios.get(`${FB_GRAPH}/${req.params.conversationId}/messages`, {
      params: {
        access_token: token,
        fields: 'id,message,from,to,created_time,attachments',
        limit: 100
      }
    });
    res.json(r.data.data || []);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

app.post('/api/facebook/send/:conversationId', async (req, res) => {
  try {
    await getFbPageInfo();
    const token = getPageToken(req.body.pageId);

    const r = await axios.post(`${FB_GRAPH}/${req.params.conversationId}/messages`, null, {
      params: { access_token: token, message: req.body.message }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  INSTAGRAM  (Instagram Graph API with IG-scoped token)
// ══════════════════════════════════════════════════════════════════════

app.get('/api/instagram/me', async (req, res) => {
  try {
    const r = await axios.get(`${IG_GRAPH}/me`, {
      params: { access_token: IG_TOKEN, fields: 'user_id,username,name,profile_picture_url,account_type' }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/api/instagram/conversations', async (req, res) => {
  try {
    const meRes = await axios.get(`${IG_GRAPH}/me`, {
      params: { access_token: IG_TOKEN, fields: 'user_id,username' }
    });
    const igUserId = meRes.data.user_id;
    const igUsername = meRes.data.username;

    // Fetch conversations with only 1 message each (the latest) to stay under API limits
    const r = await axios.get(`${IG_GRAPH}/me/conversations`, {
      params: {
        access_token: IG_TOKEN,
        platform: 'instagram',
        fields: 'id,updated_time,participants,messages.limit(1){id,message,from,created_time,is_echo}',
        limit: 30
      }
    });

    const all = (r.data.data || []).map(c => ({ ...c, _igUserId: igUserId }));

    const unread = [];
    const read = [];

    for (const conv of all) {
      const lastMsg = conv.messages?.data?.[0];
      const isFromMe = lastMsg?.is_echo ||
        lastMsg?.from?.id === igUserId ||
        lastMsg?.from?.username === igUsername;

      if (!lastMsg || isFromMe) {
        read.push({ ...conv, _unread: false });
      } else {
        unread.push({ ...conv, _unread: true });
      }
    }

    const byTime = (a, b) => new Date(b.updated_time) - new Date(a.updated_time);
    unread.sort(byTime);
    read.sort(byTime);

    const result = [...unread, ...read.slice(0, 10)];
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/api/instagram/messages/:conversationId', async (req, res) => {
  try {
    const r = await axios.get(`${IG_GRAPH}/${req.params.conversationId}`, {
      params: {
        access_token: IG_TOKEN,
        fields: 'messages{id,message,from,created_time,attachments,is_echo}'
      }
    });
    res.json(r.data.messages?.data || []);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

app.post('/api/instagram/send', async (req, res) => {
  try {
    const r = await axios.post(`${IG_GRAPH}/me/messages`, {
      recipient: { id: req.body.recipientId },
      message: { text: req.body.message }
    }, {
      params: { access_token: IG_TOKEN }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  WHATSAPP  (WhatsApp Business Cloud API)
// ══════════════════════════════════════════════════════════════════════

// Step 1: discover WABA → phone numbers
app.get('/api/whatsapp/phone-numbers', async (req, res) => {
  try {
    // Get the WABA ID first by checking debug_token or using the app-scoped approach
    // The WA token is tied to a specific WABA. We'll get the business account info.
    const r = await axios.get(`${FB_GRAPH}/debug_token`, {
      params: { input_token: WA_TOKEN, access_token: WA_TOKEN }
    });
    const granularScopes = r.data.data?.granular_scopes || [];
    const whatsappScope = granularScopes.find(s => s.scope === 'whatsapp_business_messaging');
    const wabaIds = whatsappScope?.target_ids || [];

    let phones = [];
    for (const wabaId of wabaIds) {
      const phoneRes = await axios.get(`${FB_GRAPH}/${wabaId}/phone_numbers`, {
        params: { access_token: WA_TOKEN, fields: 'id,display_phone_number,verified_name,quality_rating' }
      });
      const nums = (phoneRes.data.data || []).map(p => ({ ...p, wabaId }));
      phones.push(...nums);
    }

    res.json(phones);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// Step 2: get conversations for a phone number
app.get('/api/whatsapp/conversations/:phoneNumberId', async (req, res) => {
  try {
    const r = await axios.get(`${FB_GRAPH}/${req.params.phoneNumberId}/messages`, {
      params: { access_token: WA_TOKEN }
    });
    res.json(r.data.data || r.data.conversations || []);
  } catch (err) {
    // WhatsApp Cloud API doesn't have a "list conversations" endpoint the same way.
    // We'll use the WhatsApp Business Management API to list message templates
    // and rely on webhook-based message history. For now, return the error.
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// Send a WhatsApp message
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { phoneNumberId, to, message } = req.body;
    const r = await axios.post(`${FB_GRAPH}/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    }, {
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  OUTLOOK  (Microsoft Graph API with OAuth2)
// ══════════════════════════════════════════════════════════════════════

const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const MS_GRAPH = 'https://graph.microsoft.com/v1.0';
const OL_CLIENT_ID = process.env.OUTLOOK_CLIENT_ID;
const OL_CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET;
const OL_REDIRECT = process.env.OUTLOOK_REDIRECT_URI;
const OL_SCOPES = 'openid profile email Mail.Read Mail.Send User.Read offline_access';

let outlookTokens = null; // { access_token, refresh_token, expires_at }

async function refreshOutlookToken() {
  if (!outlookTokens?.refresh_token) return null;
  try {
    const r = await axios.post(`${MS_AUTH}/token`, new URLSearchParams({
      client_id: OL_CLIENT_ID,
      client_secret: OL_CLIENT_SECRET,
      refresh_token: outlookTokens.refresh_token,
      grant_type: 'refresh_token',
      scope: OL_SCOPES
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    outlookTokens = {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token || outlookTokens.refresh_token,
      expires_at: Date.now() + (r.data.expires_in * 1000) - 60000
    };
    return outlookTokens.access_token;
  } catch (err) {
    outlookTokens = null;
    return null;
  }
}

async function getOutlookToken() {
  if (!outlookTokens) return null;
  if (Date.now() >= outlookTokens.expires_at) {
    return refreshOutlookToken();
  }
  return outlookTokens.access_token;
}

// Step 1: redirect to Microsoft login
app.get('/api/outlook/auth', (req, res) => {
  const params = new URLSearchParams({
    client_id: OL_CLIENT_ID,
    response_type: 'code',
    redirect_uri: OL_REDIRECT,
    response_mode: 'query',
    scope: OL_SCOPES,
    prompt: 'select_account'
  });
  res.redirect(`${MS_AUTH}/authorize?${params}`);
});

// Step 2: callback — exchange code for tokens
app.get('/api/outlook/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing auth code');

    const r = await axios.post(`${MS_AUTH}/token`, new URLSearchParams({
      client_id: OL_CLIENT_ID,
      client_secret: OL_CLIENT_SECRET,
      code,
      redirect_uri: OL_REDIRECT,
      grant_type: 'authorization_code',
      scope: OL_SCOPES
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    outlookTokens = {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token,
      expires_at: Date.now() + (r.data.expires_in * 1000) - 60000
    };

    // Redirect back to dashboard on the Outlook tab
    res.send(`<html><body><script>window.location.href='/#outlook-connected';</script></body></html>`);
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message;
    res.status(500).send(`OAuth failed: ${msg}`);
  }
});

// Check connection status
app.get('/api/outlook/status', async (req, res) => {
  const token = await getOutlookToken();
  if (!token) return res.json({ connected: false });

  try {
    const r = await axios.get(`${MS_GRAPH}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json({ connected: true, user: r.data });
  } catch {
    res.json({ connected: false });
  }
});

// List mail folders
app.get('/api/outlook/folders', async (req, res) => {
  try {
    const token = await getOutlookToken();
    if (!token) return res.status(401).json({ error: 'Not connected to Outlook' });

    const r = await axios.get(`${MS_GRAPH}/me/mailFolders`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { $top: 50 }
    });
    res.json(r.data.value || []);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// List messages (inbox by default, or by folderId)
app.get('/api/outlook/messages', async (req, res) => {
  try {
    const token = await getOutlookToken();
    if (!token) return res.status(401).json({ error: 'Not connected to Outlook' });

    const folderId = req.query.folderId || 'inbox';
    const r = await axios.get(`${MS_GRAPH}/me/mailFolders/${folderId}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        $top: 50,
        $orderby: 'receivedDateTime desc',
        $select: 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId,body'
      }
    });
    res.json(r.data.value || []);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Get a single message with full body
app.get('/api/outlook/messages/:messageId', async (req, res) => {
  try {
    const token = await getOutlookToken();
    if (!token) return res.status(401).json({ error: 'Not connected to Outlook' });

    const r = await axios.get(`${MS_GRAPH}/me/messages/${req.params.messageId}`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isRead' }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Get conversation thread
app.get('/api/outlook/thread/:conversationId', async (req, res) => {
  try {
    const token = await getOutlookToken();
    if (!token) return res.status(401).json({ error: 'Not connected to Outlook' });

    const r = await axios.get(`${MS_GRAPH}/me/messages`, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        $filter: `conversationId eq '${req.params.conversationId}'`,
        $orderby: 'receivedDateTime asc',
        $select: 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,hasAttachments',
        $top: 100
      }
    });
    res.json(r.data.value || []);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Send / reply to email
app.post('/api/outlook/send', async (req, res) => {
  try {
    const token = await getOutlookToken();
    if (!token) return res.status(401).json({ error: 'Not connected to Outlook' });

    const { to, subject, body, replyToId } = req.body;

    if (replyToId) {
      // Reply to existing message
      const r = await axios.post(`${MS_GRAPH}/me/messages/${replyToId}/reply`, {
        comment: body
      }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      res.json({ success: true });
    } else {
      // New email
      const r = await axios.post(`${MS_GRAPH}/me/sendMail`, {
        message: {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: [{ emailAddress: { address: to } }]
        }
      }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      res.json({ success: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Disconnect
app.post('/api/outlook/disconnect', (req, res) => {
  outlookTokens = null;
  res.json({ success: true });
});

// ── Catch-all: serve login or dashboard ─────────────────────────────
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
