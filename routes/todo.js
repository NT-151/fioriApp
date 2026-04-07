const express = require('express');
const axios = require('axios');
const { getFbPageInfo, FB_GRAPH, FB_TOKEN } = require('./facebook');
const { IG_GRAPH, IG_TOKEN } = require('./instagram');
const { getOutlookToken, MS_GRAPH } = require('./outlook');

const router = express.Router();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// GET /api/todo/scan
router.get('/scan', async (req, res) => {
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

module.exports = { router };
