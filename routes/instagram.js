const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const IG_GRAPH = 'https://graph.instagram.com/v21.0';
const IG_TOKEN = process.env.IG_ACCESS_TOKEN;

const IG_READ_FILE = path.join(__dirname, '..', 'data', 'ig_read.json');

function loadIgReadState() {
  try { return JSON.parse(fs.readFileSync(IG_READ_FILE, 'utf8')); }
  catch { return {}; }
}

function saveIgReadState(state) {
  fs.writeFileSync(IG_READ_FILE, JSON.stringify(state, null, 2));
}

// GET /api/instagram/me
router.get('/me', async (req, res) => {
  try {
    const r = await axios.get(`${IG_GRAPH}/me`, {
      params: { access_token: IG_TOKEN, fields: 'user_id,username,name,profile_picture_url,account_type' }
    });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// GET /api/instagram/conversations
router.get('/conversations', async (req, res) => {
  try {
    const meRes = await axios.get(`${IG_GRAPH}/me`, {
      params: { access_token: IG_TOKEN, fields: 'user_id,username' }
    });
    const igUserId = meRes.data.user_id;
    const igUsername = meRes.data.username;

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

      let repliedAfterIncoming = false;
      if (!lastMsgIsFromMe) {
        const myReply = msgs.find(m => isMsgFromMe(m));
        if (myReply) {
          const lastIncoming = msgs.find(m => !isMsgFromMe(m));
          if (lastIncoming && myReply &&
              new Date(myReply.created_time) > new Date(lastIncoming.created_time)) {
            repliedAfterIncoming = true;
          }
        }
      }

      const lastMsgAge = lastMsg ? now - new Date(lastMsg.created_time).getTime() : 0;
      const isStale = lastMsgAge > TWELVE_HOURS;

      const lastReadTime = readState[conv.id];
      const isUnread = lastMsg && !lastMsgIsFromMe && !repliedAfterIncoming && !isStale &&
        (!lastReadTime || new Date(conv.updated_time) > new Date(lastReadTime));

      if (!isUnread && !lastReadTime) {
        readState[conv.id] = new Date().toISOString();
      }

      if (isUnread) {
        unread.push({ ...conv, _unread: true });
      } else {
        read.push({ ...conv, _unread: false });
      }
    }

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

// GET /api/instagram/messages/:conversationId
router.get('/messages/:conversationId', async (req, res) => {
  try {
    const cursor = req.query.cursor;
    let messages, paging;

    if (cursor) {
      const r = await axios.get(cursor);
      messages = r.data.data || [];
      paging = r.data.paging;
    } else {
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

// POST /api/instagram/send
router.post('/send', async (req, res) => {
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

// POST /api/instagram/mark-read
router.post('/mark-read', (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
  const readState = loadIgReadState();
  readState[conversationId] = new Date().toISOString();
  saveIgReadState(readState);
  res.json({ ok: true });
});

module.exports = { router, IG_GRAPH, IG_TOKEN };
