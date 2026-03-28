const API = '';

const POLL_MESSAGES_MS = 10000;  // poll active chat every 10s
const POLL_CONVOS_MS   = 30000;  // poll conversation list every 30s

let state = {
  platform: 'instagram',
  pages: [],
  selectedPage: null,
  conversations: [],
  activeConversation: null,
  messages: [],
  pageNames: {},
  igUserId: null,
  igUsername: null,
  waPhones: [],
  selectedWaPhone: null,
  outlookConnected: false,
  outlookUser: null,
  outlookFolders: [],
  outlookMessages: [],
  activeEmail: null
};

let pollMessageTimer = null;
let igNextCursor = null;
let igLoadingOlder = false;

let pollConvoTimer = null;
let activeChatName = null; // track the name shown in chat header
let platformGeneration = 0; // incremented on every platform switch to discard stale async results

// Per-platform cache so switching tabs doesn't lose loaded data
const platformCache = {};

// ══════════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // Verify session is still valid
  try {
    const authRes = await fetch('/api/auth/status');
    const authData = await authRes.json();
    if (!authData.authenticated) { window.location.href = '/'; return; }
  } catch { window.location.href = '/'; return; }

  if (window.location.hash === '#outlook-connected') {
    window.location.hash = '';
    state.platform = 'outlook';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-platform="outlook"]').classList.add('active');
    switchPlatform('outlook');
  } else {
    switchPlatform('instagram');
  }
  loadPages().catch(() => {});
});

// ══════════════════════════════════════════════════════════════════════
//  FACEBOOK PAGES
// ══════════════════════════════════════════════════════════════════════
async function loadPages() {
  try {
    const res = await fetch(`${API}/api/pages`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    state.pages = data;
    const select = document.getElementById('pageSelect');
    select.innerHTML = '<option value="">— Choose a page —</option>';

    data.forEach(p => {
      state.pageNames[p.id] = p.name;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      select.appendChild(opt);
    });

    if (data.length === 1) {
      select.value = data[0].id;
      onPageChange();
    }
  } catch (err) {
    toast('Facebook: ' + err.message, 'error');
  }
}

function onPageChange() {
  const id = document.getElementById('pageSelect').value;
  state.selectedPage = state.pages.find(p => p.id === id) || null;
  resetConversations();
  if (state.selectedPage) loadConversations();
}

// ══════════════════════════════════════════════════════════════════════
//  WHATSAPP PHONES
// ══════════════════════════════════════════════════════════════════════
async function loadWaPhones() {
  try {
    const res = await fetch(`${API}/api/whatsapp/phone-numbers`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    state.waPhones = data;
    const select = document.getElementById('waPhoneSelect');
    select.innerHTML = '<option value="">— Choose a number —</option>';

    data.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.verified_name} (${p.display_phone_number})`;
      select.appendChild(opt);
    });

    if (data.length === 1) {
      select.value = data[0].id;
      onWaPhoneChange();
    } else if (data.length === 0) {
      document.getElementById('conversationList').innerHTML =
        '<div class="empty-state">No WhatsApp phone numbers found</div>';
    }
  } catch (err) {
    toast('Failed to load WhatsApp numbers: ' + err.message, 'error');
  }
}

function onWaPhoneChange() {
  const id = document.getElementById('waPhoneSelect').value;
  state.selectedWaPhone = state.waPhones.find(p => p.id === id) || null;
  resetConversations();
  if (state.selectedWaPhone) {
    document.getElementById('conversationList').innerHTML =
      '<div class="empty-state" style="flex-direction:column;gap:8px;height:auto;padding:24px;text-align:center;">' +
        '<div style="font-weight:600;color:var(--text);">WhatsApp Cloud API</div>' +
        '<div>WhatsApp doesn\'t provide a conversation list endpoint.<br>Messages arrive via webhooks in real-time.</div>' +
        '<div style="margin-top:8px;">Use the compose area to send a message to any number.</div>' +
      '</div>';
    showWaComposeMode();
  }
}

function showWaComposeMode() {
  hideAllMainViews();
  document.getElementById('chatHeader').classList.remove('hidden');
  document.getElementById('messagesContainer').classList.remove('hidden');
  document.getElementById('composeBar').classList.remove('hidden');

  document.getElementById('chatAvatar').textContent = 'W';
  document.getElementById('chatAvatar').style.background = 'linear-gradient(135deg, #128c7e, #25d366)';
  document.getElementById('chatName').textContent = state.selectedWaPhone?.verified_name || 'WhatsApp';

  const badge = document.getElementById('chatPlatformBadge');
  badge.textContent = 'WhatsApp Business';
  badge.className = 'chat-platform wa';

  document.getElementById('composeInput').placeholder = '+1234567890: Your message here';
  document.getElementById('messagesList').innerHTML =
    '<div class="empty-state" style="height:200px;flex-direction:column;gap:8px;">' +
      '<div style="font-weight:500;">Send a WhatsApp message</div>' +
      '<div style="font-size:12px;color:var(--text-muted);">Format: <code style="background:var(--bg-raised);padding:2px 6px;border-radius:4px;">+1234567890: Hello!</code></div>' +
    '</div>';
}

// ══════════════════════════════════════════════════════════════════════
//  INSTAGRAM (standalone token)
// ══════════════════════════════════════════════════════════════════════
async function loadIgProfile() {
  try {
    const res = await fetch(`${API}/api/instagram/me`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    state.igUserId = data.user_id;
    state.igUsername = data.username;
    return data;
  } catch (err) {
    toast('Failed to load Instagram profile: ' + err.message, 'error');
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  OUTLOOK
// ══════════════════════════════════════════════════════════════════════
async function checkOutlookStatus() {
  try {
    const res = await fetch(`${API}/api/outlook/status`);
    const data = await res.json();
    state.outlookConnected = data.connected;
    state.outlookUser = data.user || null;

    if (data.connected) {
      document.getElementById('outlookNotConnected').classList.add('hidden');
      document.getElementById('outlookConnected').classList.remove('hidden');
      document.getElementById('outlookUser').innerHTML =
        `<strong>${escHtml(data.user.displayName)}</strong> &mdash; ${escHtml(data.user.mail || data.user.userPrincipalName)}`;
      await loadOutlookFolders();
      await loadOutlookMessages();
    } else {
      document.getElementById('outlookNotConnected').classList.remove('hidden');
      document.getElementById('outlookConnected').classList.add('hidden');
      document.getElementById('conversationList').innerHTML =
        '<div class="empty-state">Sign in to view your Outlook emails</div>';
    }
  } catch (err) {
    toast('Outlook status check failed', 'error');
  }
}

async function loadOutlookFolders() {
  try {
    const res = await fetch(`${API}/api/outlook/folders`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.outlookFolders = data;
    const select = document.getElementById('outlookFolderSelect');
    select.innerHTML = '';
    data.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.textContent = `${f.displayName} (${f.unreadItemCount})`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.warn('Failed to load folders:', err);
  }
}

function onOutlookFolderChange() {
  loadOutlookMessages();
}

async function loadOutlookMessages(folderId) {
  const list = document.getElementById('conversationList');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  folderId = folderId || document.getElementById('outlookFolderSelect')?.value || 'inbox';

  try {
    const res = await fetch(`${API}/api/outlook/messages?folderId=${encodeURIComponent(folderId)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.outlookMessages = data;
    renderOutlookMessages();
  } catch (err) {
    list.innerHTML = `<div class="empty-state" style="color:var(--danger)">Error: ${err.message || err}</div>`;
  }
}

function renderOutlookMessages() {
  const list = document.getElementById('conversationList');

  if (!state.outlookMessages.length) {
    list.innerHTML = '<div class="empty-state">No emails in this folder</div>';
    return;
  }

  list.innerHTML = '';
  state.outlookMessages.forEach(msg => {
    const from = msg.from?.emailAddress;
    const name = from?.name || from?.address || 'Unknown';
    const initial = name.charAt(0).toUpperCase();
    const subject = msg.subject || '(No subject)';
    const preview = msg.bodyPreview || '';
    const time = formatTime(msg.receivedDateTime);
    const isActive = state.activeEmail?.id === msg.id;
    const isUnread = !msg.isRead;

    const el = document.createElement('div');
    el.className = `conv-item${isActive ? ' active' : ''}${isUnread ? ' unread' : ''}`;
    el.onclick = () => openEmail(msg);
    el.innerHTML = `
      <div class="avatar ol">${initial}</div>
      <div class="conv-info">
        <div class="conv-name">${escHtml(name)}</div>
        <div class="conv-snippet"><strong>${escHtml(subject)}</strong> &mdash; ${escHtml(preview)}</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time">${time}</div>
        ${msg.hasAttachments ? '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">📎</div>' : ''}
      </div>
    `;
    list.appendChild(el);
  });
}

async function openEmail(msg) {
  state.activeEmail = msg;
  renderOutlookMessages();

  hideAllMainViews();
  document.getElementById('chatHeader').classList.remove('hidden');
  document.getElementById('emailView').classList.remove('hidden');
  document.getElementById('composeBar').classList.remove('hidden');

  const from = msg.from?.emailAddress;
  const name = from?.name || from?.address || 'Unknown';
  const initial = name.charAt(0).toUpperCase();

  document.getElementById('chatAvatar').textContent = initial;
  document.getElementById('chatAvatar').style.background = 'linear-gradient(135deg, #0078d4, #50a0e6)';
  document.getElementById('chatName').textContent = name;

  const badge = document.getElementById('chatPlatformBadge');
  badge.textContent = 'Outlook';
  badge.className = 'chat-platform ol';

  document.getElementById('composeInput').placeholder = 'Type a reply…';

  // Load full email
  try {
    const res = await fetch(`${API}/api/outlook/messages/${msg.id}`);
    const full = await res.json();
    if (full.error) throw new Error(full.error);

    const toList = (full.toRecipients || []).map(r => r.emailAddress?.address).join(', ');
    const dateStr = new Date(full.receivedDateTime).toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });

    document.getElementById('emailHeader').innerHTML = `
      <div class="email-subject">${escHtml(full.subject || '(No subject)')}</div>
      <div class="email-meta">
        <span class="from-name">${escHtml(from?.name || '')}</span>
        <span>&lt;${escHtml(from?.address || '')}&gt;</span>
        <span class="email-date">${dateStr}</span>
      </div>
      ${toList ? `<div class="email-to">To: ${escHtml(toList)}</div>` : ''}
    `;

    if (full.body?.contentType === 'html') {
      const iframe = document.createElement('iframe');
      iframe.sandbox = 'allow-same-origin';
      iframe.style.cssText = 'width:100%;border:none;min-height:400px;background:#fff;border-radius:8px;';
      document.getElementById('emailBody').innerHTML = '<div class="email-body-html"></div>';
      document.querySelector('.email-body-html').appendChild(iframe);
      iframe.srcdoc = full.body.content;
      iframe.onload = () => {
        iframe.style.height = iframe.contentDocument.body.scrollHeight + 40 + 'px';
      };
    } else {
      document.getElementById('emailBody').innerHTML =
        `<pre style="white-space:pre-wrap;font-family:inherit;">${escHtml(full.body?.content || '')}</pre>`;
    }
  } catch (err) {
    document.getElementById('emailBody').innerHTML =
      `<div class="empty-state" style="color:var(--danger)">Failed to load email: ${err.message || err}</div>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  PLATFORM SWITCHING
// ══════════════════════════════════════════════════════════════════════
function switchPlatform(platform) {
  const prevPlatform = state.platform;
  savePlatformCache(prevPlatform);

  platformGeneration++;
  state.platform = platform;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-platform="${platform}"]`).classList.add('active');

  resetConversations();

  const fbSelector = document.getElementById('pageSelector');
  const waSelector = document.getElementById('waPhoneSelector');
  const olSelector = document.getElementById('outlookSelector');

  fbSelector.classList.add('hidden');
  waSelector.classList.add('hidden');
  olSelector.classList.add('hidden');

  document.getElementById('conversationsLabel').textContent =
    platform === 'outlook' ? 'Emails' : 'Conversations';

  // Restore from cache if available
  const cached = platformCache[platform];
  const hasCachedData = cached && (cached.conversations.length || (cached.outlookMessages || []).length);
  if (hasCachedData) {
    state.conversations = cached.conversations;
    state.activeConversation = cached.activeConversation;
    state.messages = cached.messages;
    state.activeEmail = cached.activeEmail;
    activeChatName = cached.activeChatName;
    if (platform === 'instagram') igNextCursor = cached.igNextCursor;
    if (platform === 'outlook') state.outlookMessages = cached.outlookMessages || [];

    if (platform === 'outlook' && state.outlookMessages.length) {
      renderOutlookMessages();
    } else {
      renderConversations();
    }

    if (platform === 'outlook' && state.activeEmail) {
      // Outlook email view is already rendered via renderOutlookMessages click state
    } else if (state.activeConversation && activeChatName) {
      hideAllMainViews();
      showChatArea(activeChatName);
      renderMessages(true);
      if (platform === 'instagram') setupScrollLoadMore();
      startMessagePolling();
    }

    // Refresh conversations in the background
    if (platform === 'facebook' || platform === 'instagram') {
      startConvoPolling();
    }
  }

  if (platform === 'facebook') {
    fbSelector.classList.remove('hidden');
    if (!hasCachedData && state.selectedPage) loadConversations();
  } else if (platform === 'instagram') {
    if (!hasCachedData) loadConversations();
  } else if (platform === 'whatsapp') {
    waSelector.classList.remove('hidden');
    if (!state.waPhones.length) loadWaPhones();
    else if (state.selectedWaPhone) onWaPhoneChange();
  } else if (platform === 'outlook') {
    olSelector.classList.remove('hidden');
    if (!hasCachedData) checkOutlookStatus();
    else {
      // Restore Outlook connected UI state
      document.getElementById('outlookNotConnected').classList.add('hidden');
      document.getElementById('outlookConnected').classList.remove('hidden');
    }
  }
}

function savePlatformCache(platform) {
  if (!platform) return;
  platformCache[platform] = {
    conversations: state.conversations,
    activeConversation: state.activeConversation,
    messages: state.messages,
    activeChatName,
    igNextCursor: platform === 'instagram' ? igNextCursor : null,
    activeEmail: state.activeEmail,
    outlookMessages: platform === 'outlook' ? state.outlookMessages : []
  };
}

function resetConversations() {
  stopPolling();
  state.conversations = [];
  state.activeConversation = null;
  state.messages = [];
  state.activeEmail = null;
  activeChatName = null;
  renderConversations();
  hideAllMainViews();
  document.getElementById('chatPlaceholder').classList.remove('hidden');
  document.getElementById('composeInput').placeholder = 'Type a message…';
}

// ══════════════════════════════════════════════════════════════════════
//  POLLING
// ══════════════════════════════════════════════════════════════════════
function stopPolling() {
  if (pollMessageTimer) { clearInterval(pollMessageTimer); pollMessageTimer = null; }
  if (pollConvoTimer) { clearInterval(pollConvoTimer); pollConvoTimer = null; }
}

function startConvoPolling() {
  if (pollConvoTimer) clearInterval(pollConvoTimer);
  pollConvoTimer = setInterval(() => pollConversations(), POLL_CONVOS_MS);
}

function startMessagePolling() {
  if (pollMessageTimer) clearInterval(pollMessageTimer);
  pollMessageTimer = setInterval(() => pollMessages(), POLL_MESSAGES_MS);
}

async function pollConversations() {
  if (state.platform !== 'facebook' && state.platform !== 'instagram') return;
  const gen = platformGeneration;

  try {
    let url;
    if (state.platform === 'facebook') {
      if (!state.selectedPage) return;
      url = `${API}/api/facebook/conversations/${state.selectedPage.id}`;
    } else {
      url = `${API}/api/instagram/conversations`;
    }

    const res = await fetch(url);
    if (gen !== platformGeneration) return;
    const data = await res.json();
    if (data.error) return;

    state.conversations = data;
    renderConversations();
  } catch (_) {}
}

async function pollMessages() {
  if (!state.activeConversation) return;
  if (state.platform !== 'facebook' && state.platform !== 'instagram') return;
  const gen = platformGeneration;

  try {
    let url;
    if (state.platform === 'facebook') {
      url = `${API}/api/facebook/messages/${state.activeConversation.id}?pageId=${state.selectedPage.id}`;
    } else {
      url = `${API}/api/instagram/messages/${state.activeConversation.id}`;
    }

    const res = await fetch(url);
    if (gen !== platformGeneration) return;
    const raw = await res.json();
    if (raw.error) return;

    // Instagram returns { messages, nextCursor }, Facebook returns an array
    const latestPage = state.platform === 'instagram'
      ? (raw.messages || []).reverse()
      : (Array.isArray(raw) ? raw : raw.messages || raw).reverse();

    // Only re-render if message count changed (new message arrived)
    const oldIds = new Set(state.messages.filter(m => !m.id?.startsWith('temp_')).map(m => m.id));
    const hasNew = latestPage.some(m => !oldIds.has(m.id));

    if (hasNew) {
      // Check if user was scrolled to bottom before update
      const container = document.getElementById('messagesContainer');
      const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;

      // Merge: keep older loaded messages + replace the recent page with fresh data
      if (state.platform === 'instagram') {
        const latestIds = new Set(latestPage.map(m => m.id));
        const olderOnly = state.messages.filter(m => !latestIds.has(m.id) && !m.id?.startsWith('temp_'));
        state.messages = [...olderOnly, ...latestPage];
      } else {
        state.messages = latestPage;
      }
      renderMessages(wasAtBottom);
    }
  } catch (_) {}
}

function hideAllMainViews() {
  document.getElementById('chatPlaceholder').classList.add('hidden');
  document.getElementById('chatHeader').classList.add('hidden');
  document.getElementById('messagesContainer').classList.add('hidden');
  document.getElementById('composeBar').classList.add('hidden');
  document.getElementById('emailView').classList.add('hidden');
  document.getElementById('messagesList').innerHTML = '';
}

// ══════════════════════════════════════════════════════════════════════
//  CONVERSATIONS (FB / IG)
// ══════════════════════════════════════════════════════════════════════
async function loadConversations() {
  if (state.platform === 'whatsapp') {
    if (state.selectedWaPhone) onWaPhoneChange();
    return;
  }
  if (state.platform === 'outlook') {
    await loadOutlookMessages();
    return;
  }

  const gen = platformGeneration;
  const list = document.getElementById('conversationList');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    let url;
    if (state.platform === 'facebook') {
      if (!state.selectedPage) {
        list.innerHTML = '<div class="empty-state">Select a page first</div>';
        return;
      }
      url = `${API}/api/facebook/conversations/${state.selectedPage.id}`;
    } else if (state.platform === 'instagram') {
      await loadIgProfile();
      if (gen !== platformGeneration) return;
      url = `${API}/api/instagram/conversations`;
    }

    const res = await fetch(url);
    if (gen !== platformGeneration) return;
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    state.conversations = data;
    renderConversations();
    startConvoPolling();
  } catch (err) {
    list.innerHTML = `<div class="empty-state" style="color:var(--danger)">Error: ${err.message}</div>`;
    toast('Failed to load conversations', 'error');
  }
}

function renderConversations() {
  const list = document.getElementById('conversationList');

  if (!state.conversations.length) {
    list.innerHTML = '<div class="empty-state">No conversations found</div>';
    return;
  }

  list.innerHTML = '';

  // For Instagram, separate unread and read with section headers
  if (state.platform === 'instagram') {
    const unread = state.conversations.filter(c => c._unread);
    const read = state.conversations.filter(c => !c._unread);

    if (unread.length) {
      const header = document.createElement('div');
      header.className = 'conv-section-header';
      header.textContent = `Unread (${unread.length})`;
      list.appendChild(header);
      unread.forEach(conv => list.appendChild(buildConvItem(conv)));
    }

    if (read.length) {
      const header = document.createElement('div');
      header.className = 'conv-section-header';
      header.textContent = 'Recent';
      list.appendChild(header);
      read.forEach(conv => list.appendChild(buildConvItem(conv)));
    }
  } else {
    state.conversations.forEach(conv => list.appendChild(buildConvItem(conv)));
  }
}

function buildConvItem(conv) {
  const participants = conv.participants?.data || [];
  let myId;
  if (state.platform === 'facebook') myId = state.selectedPage?.id;
  else if (state.platform === 'instagram') myId = conv._igUserId || state.igUserId;

  const other = participants.find(p => p.id !== myId) || participants[0] || {};
  const name = other.name || other.username || 'Unknown';
  const initial = name.charAt(0).toUpperCase();
  const snippet = conv.snippet || conv.messages?.data?.[0]?.message || '';
  const time = formatTime(conv.updated_time);
  const isActive = state.activeConversation?.id === conv.id;
  const platformClass = state.platform === 'facebook' ? 'fb' : 'ig';
  const isUnread = conv._unread;

  const el = document.createElement('div');
  el.className = `conv-item${isActive ? ' active' : ''}${isUnread ? ' unread' : ''}`;
  el.onclick = () => openConversation(conv, name);
  el.innerHTML = `
    <div class="avatar ${platformClass}">${initial}</div>
    <div class="conv-info">
      <div class="conv-name">${escHtml(name)}</div>
      <div class="conv-snippet">${escHtml(snippet)}</div>
    </div>
    <div class="conv-meta">
      <div class="conv-time">${time}</div>
      ${isUnread ? '<div class="conv-unread-dot"></div>' : ''}
      ${conv.unread_count ? `<div class="conv-unread">${conv.unread_count}</div>` : ''}
    </div>
  `;
  return el;
}

// ══════════════════════════════════════════════════════════════════════
//  MESSAGES (FB / IG)
// ══════════════════════════════════════════════════════════════════════
async function openConversation(conv, name) {
  // Stop previous message polling
  if (pollMessageTimer) { clearInterval(pollMessageTimer); pollMessageTimer = null; }

  state.activeConversation = conv;
  activeChatName = name;

  // Mark this conversation as read on the server
  if (state.platform === 'instagram' && conv._unread) {
    conv._unread = false;
    fetch(`${API}/api/instagram/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conv.id })
    }).catch(() => {});
  }

  renderConversations();

  hideAllMainViews();
  showChatArea(name);

  const msgList = document.getElementById('messagesList');
  msgList.innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';

  try {
    let url;
    if (state.platform === 'facebook') {
      url = `${API}/api/facebook/messages/${conv.id}?pageId=${state.selectedPage.id}`;
    } else if (state.platform === 'instagram') {
      url = `${API}/api/instagram/messages/${conv.id}`;
    }

    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    if (state.platform === 'instagram') {
      igNextCursor = data.nextCursor || null;
      state.messages = (data.messages || []).reverse();
      setupScrollLoadMore();
    } else {
      state.messages = (Array.isArray(data) ? data : data.messages || data).reverse();
    }

    renderMessages(true);
    startMessagePolling();
  } catch (err) {
    msgList.innerHTML = `<div class="empty-state" style="color:var(--danger)">Error loading messages: ${err.message}</div>`;
    toast('Failed to load messages', 'error');
  }
}

function renderMessages(autoScroll = false) {
  const msgList = document.getElementById('messagesList');
  msgList.innerHTML = '';

  let lastDate = '';
  state.messages.forEach(msg => {
    const date = new Date(msg.created_time || msg.timestamp).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    if (date !== lastDate) {
      lastDate = date;
      const sep = document.createElement('div');
      sep.className = 'msg-group-date';
      sep.textContent = date;
      msgList.appendChild(sep);
    }

    const isOutgoing = isFromMe(msg);
    const el = document.createElement('div');
    el.className = `msg ${isOutgoing ? 'outgoing' : 'incoming'}`;

    const time = new Date(msg.created_time || msg.timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit'
    });

    let attachmentHtml = '';
    if (msg.attachments?.data) {
      msg.attachments.data.forEach(att => {
        if (att.image_data?.url) {
          attachmentHtml += `<div class="msg-attachment"><img src="${att.image_data.url}" alt="attachment" /></div>`;
        } else if (att.file_url) {
          attachmentHtml += `<div class="msg-attachment"><a href="${att.file_url}" target="_blank">Attachment</a></div>`;
        }
      });
    }

    el.innerHTML = `
      ${!isOutgoing ? `<div class="msg-sender">${escHtml(msg.from?.name || msg.from?.username || '')}</div>` : ''}
      ${msg.message ? `<div class="msg-bubble">${escHtml(msg.message)}</div>` : ''}
      ${attachmentHtml}
      <div class="msg-time">${time}</div>
    `;
    msgList.appendChild(el);
  });

  const container = document.getElementById('messagesContainer');
  if (autoScroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function setupScrollLoadMore() {
  const container = document.getElementById('messagesContainer');
  container.onscroll = async () => {
    if (state.platform !== 'instagram' || !igNextCursor || igLoadingOlder) return;
    if (container.scrollTop > 100) return;

    igLoadingOlder = true;

    // Show spinner at the top
    const msgList = document.getElementById('messagesList');
    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner scroll-loader';
    spinner.innerHTML = '<div class="spinner"></div>';
    msgList.prepend(spinner);
    container.scrollTop = spinner.offsetHeight;

    const prevScrollHeight = container.scrollHeight;

    try {
      const res = await fetch(`${API}/api/instagram/messages/${state.activeConversation.id}?cursor=${encodeURIComponent(igNextCursor)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);

      const olderMessages = (data.messages || []).reverse();
      igNextCursor = data.nextCursor || null;

      const spinnerH = spinner.offsetHeight;
      spinner.remove();

      if (data.rateLimited) {
        toast('Instagram rate limit — try scrolling up again in a minute', 'error');
      } else if (olderMessages.length) {
        state.messages = [...olderMessages, ...state.messages];
        renderMessages();
        container.scrollTop = container.scrollHeight - prevScrollHeight + spinnerH;
      }
    } catch (_) {
      spinner.remove();
    }

    igLoadingOlder = false;
  };
}

function isFromMe(msg) {
  if (!msg.from) return !!msg.is_echo;
  if (state.platform === 'facebook') {
    return msg.from.id === state.selectedPage?.id || state.pageNames[msg.from.id] !== undefined;
  }
  if (state.platform === 'instagram') {
    return msg.from.id === state.igUserId || msg.from.username === state.igUsername || !!msg.is_echo;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════
//  SEND MESSAGE
// ══════════════════════════════════════════════════════════════════════
async function sendMessage() {
  const input = document.getElementById('composeInput');
  const text = input.value.trim();
  if (!text) return;

  if (state.platform === 'whatsapp') return sendWhatsAppMessage(text, input);
  if (state.platform === 'outlook') return sendOutlookReply(text, input);

  if (!state.activeConversation) return;
  input.value = '';

  try {
    if (state.platform === 'facebook') {
      await fetch(`${API}/api/facebook/send/${state.activeConversation.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: state.selectedPage.id, message: text })
      });
    } else if (state.platform === 'instagram') {
      const participants = state.activeConversation.participants?.data || [];
      const other = participants.find(p => p.id !== state.igUserId) || participants[0];
      const resp = await fetch(`${API}/api/instagram/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipientId: other?.id, message: text })
      });
      const rData = await resp.json();
      if (rData.error) throw new Error(rData.error.message || JSON.stringify(rData.error));
    }

    state.messages.push({
      id: 'temp_' + Date.now(),
      message: text,
      from: { id: state.platform === 'facebook' ? state.selectedPage?.id : state.igUserId },
      created_time: new Date().toISOString(),
      is_echo: true
    });
    renderMessages(true);
    toast('Message sent!', 'success');

    // Quick poll to get the confirmed message from API
    setTimeout(() => pollMessages(), 1000);
    setTimeout(() => pollConversations(), 1500);
  } catch (err) {
    toast('Failed to send: ' + err.message, 'error');
  }
}

async function sendWhatsAppMessage(text, input) {
  const colonIdx = text.indexOf(':');
  if (colonIdx === -1) {
    toast('Format: +1234567890: Your message here', 'error');
    return;
  }

  const phone = text.substring(0, colonIdx).trim().replace(/[^0-9+]/g, '');
  const message = text.substring(colonIdx + 1).trim();
  if (!phone || !message) { toast('Both phone number and message required', 'error'); return; }

  input.value = '';

  try {
    const resp = await fetch(`${API}/api/whatsapp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId: state.selectedWaPhone.id, to: phone.replace('+', ''), message })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

    const msgList = document.getElementById('messagesList');
    const placeholder = msgList.querySelector('.empty-state');
    if (placeholder) placeholder.remove();

    const el = document.createElement('div');
    el.className = 'msg outgoing';
    el.innerHTML = `
      <div class="msg-bubble">${escHtml(message)}</div>
      <div class="msg-time">To: ${escHtml(phone)} &middot; ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div>
    `;
    msgList.appendChild(el);

    document.getElementById('messagesContainer').scrollTop =
      document.getElementById('messagesContainer').scrollHeight;
    toast('WhatsApp message sent!', 'success');
  } catch (err) {
    toast('Failed to send WhatsApp message: ' + err.message, 'error');
  }
}

async function sendOutlookReply(text, input) {
  if (!state.activeEmail) {
    toast('Select an email first to reply', 'error');
    return;
  }
  input.value = '';

  try {
    const resp = await fetch(`${API}/api/outlook/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyToId: state.activeEmail.id, body: text })
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    toast('Reply sent!', 'success');
  } catch (err) {
    toast('Failed to send reply: ' + (err.message || err), 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════════════════════
function showChatArea(name) {
  const initial = name.charAt(0).toUpperCase();
  const gradients = {
    facebook: 'linear-gradient(135deg, #1877f2, #42a5f5)',
    instagram: 'linear-gradient(135deg, #833ab4, #e1306c, #fd1d1d)',
    whatsapp: 'linear-gradient(135deg, #128c7e, #25d366)',
    outlook: 'linear-gradient(135deg, #0078d4, #50a0e6)'
  };
  const labels = {
    facebook: 'Facebook Messenger',
    instagram: 'Instagram DM',
    whatsapp: 'WhatsApp Business',
    outlook: 'Outlook'
  };
  const classes = { facebook: 'fb', instagram: 'ig', whatsapp: 'wa', outlook: 'ol' };

  document.getElementById('chatPlaceholder').classList.add('hidden');
  document.getElementById('chatHeader').classList.remove('hidden');
  document.getElementById('messagesContainer').classList.remove('hidden');
  document.getElementById('composeBar').classList.remove('hidden');

  document.getElementById('chatAvatar').textContent = initial;
  document.getElementById('chatAvatar').style.background = gradients[state.platform];
  document.getElementById('chatName').textContent = name;

  const badge = document.getElementById('chatPlatformBadge');
  badge.textContent = labels[state.platform];
  const liveClass = (state.platform === 'facebook' || state.platform === 'instagram') ? ' live' : '';
  badge.className = `chat-platform ${classes[state.platform]}${liveClass}`;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;

  if (diff < 60_000) return 'Just now';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + 'h';
  if (diff < 604800_000) return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
