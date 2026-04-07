const express = require('express');
const axios = require('axios');

const router = express.Router();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const EXTRACTION_PROMPT = `You are a medical scribe AI for an aesthetic medicine clinic specialising in botox and dermal filler treatments. Given an audio transcript from a consultation, extract and structure the clinical notes.

Output the notes in the following structured format. Only include sections that have relevant information in the transcript. Use standard medical abbreviations where appropriate.

**FORMAT:**

**Patient Demographics:**
Age, gender

**Medical History:**
PMH (past medical history), DHx (drug history), allergies (NKDA if none), pregnancy/breastfeeding status, history of anaphylaxis, bee/wasp sting allergy, any contraindications to treatment

**Previous Treatments:**
Previous aesthetic treatments, products used, amounts, outcomes, what they liked/disliked

**Presenting Concerns:**
What the patient wants to address, their goals

**Consultation & Consent:**
Treatment explained, risks discussed and consented for (bruising, swelling, infection, nodules, migration, vascular occlusion, ptosis, asymmetry etc.), duration of results discussed

**Treatment Plan:**
Numbered list of planned treatments with details

**Treatment Performed:**
For each area treated:
- Area
- Product and amount
- Technique (needle/cannula gauge, plane, bolus/linear threading etc.)
- Any specific notes (positive aspirates, pain, blanching, CRT)

**Anaesthesia:**
Numbing method used (LMX, EMLA etc.)

**Immediate Post-Treatment:**
Complications (nil if none), pain, blanching, CRT, floor of mouth check if relevant, patient satisfaction

**Aftercare:**
Advice given (verbal/written/emailed), safety net advice, follow-up instructions

**Skincare Recommendations:**
If discussed

**Key Abbreviations Used:**
List any abbreviations with their meanings for clarity

IMPORTANT RULES:
- Be precise with units, volumes (mls), and dosages (units)
- Record exact product names (Azzalure, Restylane Lyft, etc.)
- Record reconstitution details if mentioned
- Note laterality (L/R) where mentioned
- Keep the clinical tone professional and concise
- If dosages are given per area, calculate and note totals
- Note injection planes (periosteal, subcutaneous, intradermal etc.)
- If something is unclear in the transcript, note it as [unclear from transcript]
- Do NOT fabricate information not present in the transcript`;

const LOT_SCAN_PROMPT = `You are a product identification AI for an aesthetic medicine clinic. You will be shown one or more photos of product boxes (e.g. Botox, Azzalure, Bocouture, Restylane, Juvederm, etc.).

Extract the following for each DISTINCT product:
- Product name
- Lot number (also called batch number)
- Expiry date

IMPORTANT: When multiple images are provided, they may show DIFFERENT SIDES of the SAME product box (e.g. one image shows the product name/branding, another shows the lot number and expiry date). In this case, MERGE the information into a SINGLE entry rather than returning separate entries. Use clues like matching lot numbers, matching expiry dates, similar packaging, or the fact that partial information from one image complements missing information from another to determine they are the same product.

Return your response as a JSON array ONLY, with no other text. Each element should have these fields:
- "product": the product name
- "lot": the lot/batch number
- "expiry": the expiry date (formatted as DD/MM/YYYY if possible)

If you cannot find a field, use null for that field.
If no products are visible, return an empty array: []

Example response:
[{"product": "Azzalure 125 Speywood Units", "lot": "A12345", "expiry": "01/06/2026"}]

Return ONLY the JSON array, no markdown, no explanation.`;

// POST /api/notes/extract
router.post('/extract', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: 'No transcript provided' });
  }

  try {
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here is an audio transcript from an aesthetic clinic consultation. Please extract and structure the clinical notes:\n\n${transcript}`
        }
      ]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    const notes = r.data.content?.[0]?.text || '';
    res.json({ notes });
  } catch (err) {
    console.error('Extraction error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to extract notes. Please check your API key and try again.' });
  }
});

// POST /api/notes/scan-lot
router.post('/scan-lot', async (req, res) => {
  const { image, images } = req.body;
  const imageList = images || (image ? [image] : []);
  if (imageList.length === 0) {
    return res.status(400).json({ error: 'No image provided' });
  }

  try {
    const contentParts = [];
    for (const img of imageList) {
      const match = img.match(/^data:(image\/[\w+.-]+);base64,(.+)/s);
      if (!match) {
        return res.status(400).json({ error: 'Invalid image format' });
      }
      contentParts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: match[1],
          data: match[2]
        }
      });
    }
    contentParts.push({
      type: 'text',
      text: `Extract all lot numbers and expiry dates from the product boxes in ${imageList.length === 1 ? 'this image' : 'these ' + imageList.length + ' images'}.`
    });

    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: LOT_SCAN_PROMPT,
      messages: [
        {
          role: 'user',
          content: contentParts
        }
      ]
    }, {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });

    const responseText = r.data.content?.[0]?.text?.trim() || '[]';
    let results;
    try {
      results = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      results = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    }

    res.json({ results });
  } catch (err) {
    console.error('Scan error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to scan image. Please check your API key and try again.' });
  }
});

module.exports = { router };
