const express = require('express');
const axios = require('axios');

const router = express.Router();

const FB_GRAPH = 'https://graph.facebook.com/v21.0';
const WA_TOKEN = process.env.WA_ACCESS_TOKEN;

// GET /api/whatsapp/phone-numbers
router.get('/phone-numbers', async (req, res) => {
  try {
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

// GET /api/whatsapp/conversations/:phoneNumberId
router.get('/conversations/:phoneNumberId', async (req, res) => {
  try {
    const r = await axios.get(`${FB_GRAPH}/${req.params.phoneNumberId}/messages`, {
      params: { access_token: WA_TOKEN }
    });
    res.json(r.data.data || r.data.conversations || []);
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error || err.message });
  }
});

// POST /api/whatsapp/send
router.post('/send', async (req, res) => {
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

module.exports = { router };
