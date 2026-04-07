# Fiori DM Dashboard

A unified messaging dashboard for Facebook, Instagram, WhatsApp, Outlook, with AI-powered clinical notes, lot scanning, and patient management.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file in the project root. You should have received this file separately — it contains API keys and secrets. **Never commit this file.** The required variables are:
   ```
   FB_APP_ID=
   FB_APP_SECRET=
   FB_ACCESS_TOKEN=
   IG_APP_ID=
   IG_APP_SECRET=
   IG_ACCESS_TOKEN=
   WA_ACCESS_TOKEN=
   OUTLOOK_CLIENT_ID=
   OUTLOOK_CLIENT_SECRET=
   OUTLOOK_REDIRECT_URI=http://localhost:3000/api/outlook/callback
   ANTHROPIC_API_KEY=
   PORT=3000
   APP_PASSWORD_HASH=
   SESSION_SECRET=
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open `http://localhost:3000` in a browser.

## Project Structure

```
server.js              — Express app entry point (wiring only)
routes/
  auth.js              — Login, logout, session management
  facebook.js          — Facebook Messenger API routes
  instagram.js         — Instagram DM API routes
  whatsapp.js          — WhatsApp Business API routes
  outlook.js           — Microsoft OAuth + mail routes
  todo.js              — AI task extraction (scans messages across platforms)
  notes.js             — Clinical notes extraction + lot scanner API
public/
  dashboard.html       — Main dashboard UI
  login.html           — Login page
  styles.css           — All styles
  app.js               — Messages/DM frontend logic
  notes.js             — Clinical notes, lot scanner, patients frontend logic
data/                    — All data files (gitignored, created automatically)
  ig_read.json         — Instagram read-state tracking
  outlook_tokens.json  — Outlook OAuth tokens (auto-generated)
  notes_patients.json  — Patient records
  notes_patientNotes.json — Clinical notes linked to patients
  notes_notesHistory.json — Notes extraction history
  notes_scanHistory.json  — Lot scan history
  notes_lotLinks.json  — Lot-to-patient links
```

## Key Features

- **Messages** — Unified inbox for Facebook, Instagram, WhatsApp, and Outlook
- **To Do** — AI-powered task extraction from messages (always-visible right panel)
- **Notes** — Three sub-tabs:
  - Clinical Notes: paste consultation transcripts, AI extracts structured medical notes
  - Lot Scanner: upload product box photos, AI extracts lot numbers and expiry dates
  - Patients: create/manage patients, link notes and lots to them
- **Contacts / Settings** — Placeholder sections for future features

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **APIs**: Meta Graph API (Facebook/Instagram/WhatsApp), Microsoft Graph (Outlook), Anthropic Claude API
- **Storage**: JSON files in `data/` (server-side, gitignored)
- **Auth**: bcrypt password hashing, HMAC-signed session tokens

## Common Tasks

- **Run in dev mode** (auto-restart on changes): `npm run dev`
- **Change login password**: Generate a new bcrypt hash and update `APP_PASSWORD_HASH` in `.env`
- **Add a new route module**: Create a file in `routes/`, export a router, mount it in `server.js`
