const express = require('express');
const axios = require('axios');

const router = express.Router();

const FB_GRAPH = 'https://graph.facebook.com/v21.0';
const FB_TOKEN = process.env.FB_ACCESS_TOKEN;

let fbPageInfo = null;

async function getFbPageInfo() {
  if (fbPageInfo) return fbPageInfo;

  const meRes = await axios.get(`${FB_GRAPH}/me`, {
    params: { access_token: FB_TOKEN, fields: 'id,name' }
  });

  try {
    const acctRes = await axios.get(`${FB_GRAPH}/me/accounts`, {
      params: { access_token: FB_TOKEN, fields: 'id,name,access_token,instagram_business_account' }
    });
    if (acctRes.data.data?.length) {
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

// GET /api/me
router.get('/me', async (req, res) => {
  try {
    const r = await axios.get(`${FB_GRAPH}/me`, {
      params: { access_token: FB_TOKEN, fields: 'id,name' }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// GET /api/pages
router.get('/pages', async (req, res) => {
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

// GET /api/facebook/conversations/:pageId
router.get('/facebook/conversations/:pageId', async (req, res) => {
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

// GET /api/facebook/messages/:conversationId
router.get('/facebook/messages/:conversationId', async (req, res) => {
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

// POST /api/facebook/send
router.post('/facebook/send', async (req, res) => {
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

module.exports = { router, getFbPageInfo, getPageToken, FB_GRAPH, FB_TOKEN };
