require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

// Persistent read-state for Instagram conversations
const IG_READ_FILE = path.join(__dirname, 'data', 'ig_read.json');

function loadIgReadState() {
  try { return JSON.parse(fs.readFileSync(IG_READ_FILE, 'utf8')); }
  catch { return {}; }
}

function saveIgReadState(state) {
  fs.writeFileSync(IG_READ_FILE, JSON.stringify(state, null, 2));
}

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

app.post('/api/facebook/send', async (req, res) => {
  try {
    await getFbPageInfo();
    const token = getPageToken(req.body.pageId);

    const r = await axios.post(`${FB_GRAPH}/me/messages`, {
      recipient: { id: req.body.recipientId },
      messaging_type: 'RESPONSE',
      message: { text: req.body.message }
    }, {
      params: { access_token: token }
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

    // Fetch conversations with last 5 messages so we can apply read-heuristics
    const r = await axios.get(`${IG_GRAPH}/me/conversations`, {
      params: {
        access_token: IG_TOKEN,
        platform: 'instagram',
        fields: 'id,updated_time,participants,messages.limit(5){id,message,from,created_time,is_echo}',
        limit: 50
      }
    });

    const all = (r.data.data || []).map(c => ({ ...c, _igUserId: igUserId }));
    let readState = loadIgReadState();

    // First run: no read file exists yet — mark all current conversations as read
    // so old already-seen messages don't show as unread
    const isFirstRun = Object.keys(readState).length === 0;
    if (isFirstRun) {
      const now = new Date().toISOString();
      for (const conv of all) {
        readState[conv.id] = now;
      }
      saveIgReadState(readState);
    }

    const TWELVE_HOURS = 12 * 60 * 60 * 1000;
    const now = Date.now();
    const unread = [];
    const read = [];

    for (const conv of all) {
      const msgs = conv.messages?.data || [];
      const lastMsg = msgs[0];

      const isMsgFromMe = (m) =>
        m?.is_echo || m?.from?.id === igUserId || m?.from?.username === igUsername;

      const lastMsgIsFromMe = isMsgFromMe(lastMsg);

      // Heuristic 1 — Reply: if I replied after the most recent incoming
      // message, I must have seen it (e.g. replied on phone)
      let repliedAfterIncoming = false;
      if (!lastMsgIsFromMe) {
        // Find the first (most recent) message from me in the batch
        const myReply = msgs.find(m => isMsgFromMe(m));
        if (myReply) {
          // Check if any incoming message is newer than my reply
          const lastIncoming = msgs.find(m => !isMsgFromMe(m));
          if (lastIncoming && myReply &&
              new Date(myReply.created_time) > new Date(lastIncoming.created_time)) {
            repliedAfterIncoming = true;
          }
        }
      }

      // Heuristic 2 — Age: if the last incoming message is older than
      // 12 hours, assume it has been read elsewhere
      const lastMsgAge = lastMsg ? now - new Date(lastMsg.created_time).getTime() : 0;
      const isStale = lastMsgAge > TWELVE_HOURS;

      const lastReadTime = readState[conv.id];
      const isUnread = lastMsg && !lastMsgIsFromMe && !repliedAfterIncoming && !isStale &&
        (!lastReadTime || new Date(conv.updated_time) > new Date(lastReadTime));

      // If a heuristic marked it as read, persist so it stays read on refresh
      if (!isUnread && !lastReadTime) {
        readState[conv.id] = new Date().toISOString();
      }

      if (isUnread) {
        unread.push({ ...conv, _unread: true });
      } else {
        read.push({ ...conv, _unread: false });
      }
    }

    // Persist any heuristic-driven read state updates
    saveIgReadState(readState);

    const byTime = (a, b) => new Date(b.updated_time) - new Date(a.updated_time);
    unread.sort(byTime);
    read.sort(byTime);

    const result = [...unread, ...read.slice(0, 50)];
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

app.get('/api/instagram/messages/:conversationId', async (req, res) => {
  try {
    const cursor = req.query.cursor;
    let messages, paging;

    if (cursor) {
      // Load older messages using the cursor URL
      const r = await axios.get(cursor);
      messages = r.data.data || [];
      paging = r.data.paging;
    } else {
      // Load the most recent messages (first page only)
      const r = await axios.get(`${IG_GRAPH}/${req.params.conversationId}`, {
        params: {
          access_token: IG_TOKEN,
          fields: 'messages{id,message,from,created_time,attachments,is_echo}'
        }
      });
      messages = r.data.messages?.data || [];
      paging = r.data.messages?.paging;
    }

    res.json({
      messages,
      nextCursor: paging?.next || null
    });
  } catch (err) {
    const igErr = err.response?.data?.error;
    const errMsg = igErr?.message || err.message || '';
    const isTransient = igErr?.code === 4 || igErr?.code === 32 ||
      errMsg.includes('limit') || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (isTransient) {
      console.warn('IG transient error on messages fetch:', err.code || errMsg);
      res.json({ messages: [], nextCursor: null, rateLimited: true });
    } else {
      console.error('IG messages error:', igErr || err.message);
      res.status(500).json({ error: igErr || err.message });
    }
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

app.post('/api/instagram/mark-read', (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
  const readState = loadIgReadState();
  readState[conversationId] = new Date().toISOString();
  saveIgReadState(readState);
  res.json({ ok: true });
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
const OL_SCOPES = 'openid profile email Mail.Read Mail.Send User.Read offline_access';

function getOutlookRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/outlook/callback`;
}

const OL_TOKENS_FILE = path.join(__dirname, 'data', 'outlook_tokens.json');

function loadOutlookTokens() {
  try { return JSON.parse(fs.readFileSync(OL_TOKENS_FILE, 'utf8')); }
  catch { return null; }
}

function saveOutlookTokens(tokens) {
  if (tokens) {
    fs.writeFileSync(OL_TOKENS_FILE, JSON.stringify(tokens, null, 2));
  } else {
    try { fs.unlinkSync(OL_TOKENS_FILE); } catch {}
  }
}

let outlookTokens = loadOutlookTokens();

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
    saveOutlookTokens(outlookTokens);
    return outlookTokens.access_token;
  } catch (err) {
    outlookTokens = null;
    saveOutlookTokens(null);
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
  const redirectUri = getOutlookRedirectUri(req);
  const params = new URLSearchParams({
    client_id: OL_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
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

    const redirectUri = getOutlookRedirectUri(req);
    const r = await axios.post(`${MS_AUTH}/token`, new URLSearchParams({
      client_id: OL_CLIENT_ID,
      client_secret: OL_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: OL_SCOPES
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    outlookTokens = {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token,
      expires_at: Date.now() + (r.data.expires_in * 1000) - 60000
    };
    saveOutlookTokens(outlookTokens);

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
  saveOutlookTokens(null);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════
//  TO DO LIST — AI-powered task extraction
// ══════════════════════════════════════════════════════════════════════
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

app.get('/api/todo/scan', async (req, res) => {
  if (!ANTHROPIC_KEY || ANTHROPIC_KEY === 'your-anthropic-api-key-here') {
    return res.status(500).json({ error: 'Anthropic API key not configured. Add ANTHROPIC_API_KEY to .env' });
  }

  try {
    const allMessages = [];

    // ── Facebook messages ──
    try {
      const info = await getFbPageInfo();
      for (const page of info.pages) {
        const token = page.token;
        const convRes = await axios.get(`${FB_GRAPH}/${page.id}/conversations`, {
          params: { access_token: token, fields: 'id,participants', limit: 15 }
        });
        for (const conv of (convRes.data.data || []).slice(0, 10)) {
          const msgRes = await axios.get(`${FB_GRAPH}/${conv.id}/messages`, {
            params: { access_token: token, fields: 'message,from,created_time', limit: 5 }
          });
          for (const m of (msgRes.data.data || [])) {
            if (m.message) {
              allMessages.push({
                platform: 'facebook',
                from: m.from?.name || 'Unknown',
                text: m.message,
                timestamp: m.created_time
              });
            }
          }
        }
      }
    } catch (e) { console.warn('Todo scan: Facebook fetch failed:', e.message); }

    // ── Instagram messages ──
    try {
      const convRes = await axios.get(`${IG_GRAPH}/me/conversations`, {
        params: {
          access_token: IG_TOKEN,
          platform: 'instagram',
          fields: 'id,participants,messages.limit(5){message,from,created_time}',
          limit: 15
        }
      });
      for (const conv of (convRes.data.data || [])) {
        for (const m of (conv.messages?.data || [])) {
          if (m.message) {
            allMessages.push({
              platform: 'instagram',
              from: m.from?.username || m.from?.name || 'Unknown',
              text: m.message,
              timestamp: m.created_time
            });
          }
        }
      }
    } catch (e) { console.warn('Todo scan: Instagram fetch failed:', e.message); }

    // ── Outlook emails ──
    try {
      const olToken = await getOutlookToken();
      if (olToken) {
        const mailRes = await axios.get(`${MS_GRAPH}/me/mailFolders/inbox/messages`, {
          headers: { Authorization: `Bearer ${olToken}` },
          params: {
            $top: 20,
            $orderby: 'receivedDateTime desc',
            $select: 'subject,from,bodyPreview,receivedDateTime'
          }
        });
        for (const m of (mailRes.data.value || [])) {
          allMessages.push({
            platform: 'outlook',
            from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown',
            subject: m.subject || '',
            text: m.bodyPreview || '',
            timestamp: m.receivedDateTime
          });
        }
      }
    } catch (e) { console.warn('Todo scan: Outlook fetch failed:', e.message); }

    if (!allMessages.length) {
      return res.json({ tasks: [], note: 'No messages found across any platform.' });
    }

    // ── Build prompt and call Claude ──
    const today = new Date().toISOString().split('T')[0];

    const fbMsgs = allMessages.filter(m => m.platform === 'facebook')
      .map(m => `[${m.timestamp}] ${m.from}: ${m.text}`).join('\n');
    const igMsgs = allMessages.filter(m => m.platform === 'instagram')
      .map(m => `[${m.timestamp}] ${m.from}: ${m.text}`).join('\n');
    const olMsgs = allMessages.filter(m => m.platform === 'outlook')
      .map(m => `[${m.timestamp}] From: ${m.from} | Subject: ${m.subject} | ${m.text}`).join('\n');

    const prompt = `You are a personal assistant analyzing recent messages to extract actionable to-do items.

Today's date is: ${today}

Below are recent messages from three platforms. For each message that contains an actionable request, task, or commitment, extract it as a to-do item. Look for:
- Direct requests ("Can you send me...", "Please review...")
- Commitments made ("I'll get back to you", "I will send...")
- Deadlines mentioned explicitly or implicitly ("by Friday", "end of week", "tomorrow", "March 30")
- Follow-up items ("Let me know if...", "Waiting on...")
- Appointments or meetings ("Let's meet on...", "See you at...")

IMPORTANT: Only extract genuine action items. Do not create tasks from casual conversation, greetings, or simple status updates with no action needed.

For each task, return a JSON array with objects having these fields:
- "title": concise action item (under 80 chars)
- "description": a detailed 2-3 sentence explanation of what needs to be done, including any relevant context from the message
- "deadline": ISO date string if detectable, or null
- "deadlineText": human-readable deadline text if mentioned (e.g., "by Friday"), or null
- "source": "facebook" | "instagram" | "outlook"
- "from": who the message is from (name or email)
- "priority": "high" | "medium" | "low" based on urgency cues
- "reason": a short explanation of WHY this is the assigned priority (e.g., "Explicit deadline tomorrow", "Client waiting on response", "No urgency mentioned")
- "suggestedAction": a brief recommended next step (e.g., "Reply with the requested document", "Schedule a meeting for next week", "Forward to the design team")
- "excerpt": the relevant sentence(s) from the original message (under 200 chars)
- "category": one of "reply" | "meeting" | "deliverable" | "follow-up" | "review" | "other"

If there are no actionable items, return an empty array [].
Return ONLY valid JSON. No explanation, no markdown.

=== FACEBOOK MESSAGES ===
${fbMsgs || '(none)'}

=== INSTAGRAM MESSAGES ===
${igMsgs || '(none)'}

=== OUTLOOK EMAILS ===
${olMsgs || '(none)'}`;

    const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    const responseText = claudeRes.data.content?.[0]?.text || '[]';
    let tasks;
    try {
      tasks = JSON.parse(responseText);
    } catch {
      tasks = [];
    }

    // Sort: high > medium > low, then by deadline
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    tasks.sort((a, b) => {
      const pDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
      if (pDiff !== 0) return pDiff;
      if (a.deadline && b.deadline) return new Date(a.deadline) - new Date(b.deadline);
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return 0;
    });

    res.json({ tasks, scannedAt: new Date().toISOString(), messageCount: allMessages.length });
  } catch (err) {
    console.error('Todo scan error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
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
