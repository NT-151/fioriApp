const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const MS_AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const MS_GRAPH = 'https://graph.microsoft.com/v1.0';
const OL_CLIENT_ID = process.env.OUTLOOK_CLIENT_ID;
const OL_CLIENT_SECRET = process.env.OUTLOOK_CLIENT_SECRET;
const OL_SCOPES = 'openid profile email Mail.Read Mail.Send User.Read offline_access';

const OL_TOKENS_FILE = path.join(__dirname, '..', 'data', 'outlook_tokens.json');

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

function getOutlookRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/api/outlook/callback`;
}

// GET /api/outlook/auth — redirect to Microsoft login
router.get('/auth', (req, res) => {
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

// GET /api/outlook/callback — exchange code for tokens
router.get('/callback', async (req, res) => {
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

    res.send(`<html><body><script>window.location.href='/#outlook-connected';</script></body></html>`);
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message;
    res.status(500).send(`OAuth failed: ${msg}`);
  }
});

// GET /api/outlook/status
router.get('/status', async (req, res) => {
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

// GET /api/outlook/folders
router.get('/folders', async (req, res) => {
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

// GET /api/outlook/messages
router.get('/messages', async (req, res) => {
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

// GET /api/outlook/messages/:messageId
router.get('/messages/:messageId', async (req, res) => {
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

// GET /api/outlook/thread/:conversationId
router.get('/thread/:conversationId', async (req, res) => {
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

// POST /api/outlook/send
router.post('/send', async (req, res) => {
  try {
    const token = await getOutlookToken();
    if (!token) return res.status(401).json({ error: 'Not connected to Outlook' });

    const { to, subject, body, replyToId } = req.body;

    if (replyToId) {
      await axios.post(`${MS_GRAPH}/me/messages/${replyToId}/reply`, {
        comment: body
      }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
      res.json({ success: true });
    } else {
      await axios.post(`${MS_GRAPH}/me/sendMail`, {
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

// POST /api/outlook/disconnect
router.post('/disconnect', (req, res) => {
  outlookTokens = null;
  saveOutlookTokens(null);
  res.json({ success: true });
});

module.exports = { router, getOutlookToken, MS_GRAPH };
