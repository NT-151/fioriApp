// ══════════════════════════════════════════════════════════════════════
//  NOTES APP — Clinical Notes, Lot Scanner, Patients
// ══════════════════════════════════════════════════════════════════════

// ── Sub-tab navigation ──
function switchNotesTab(tab) {
  document.querySelectorAll('.notes-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.notes-tab[data-ntab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.notes-tabcontent').forEach(s => s.classList.add('hidden'));
  document.getElementById('ntab-' + tab).classList.remove('hidden');
}

// ── Shared helpers (localStorage) ──
function nGenerateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function nGetPatients() { try { return JSON.parse(localStorage.getItem('nPatients') || '[]'); } catch { return []; } }
function nSavePatients(a) { localStorage.setItem('nPatients', JSON.stringify(a)); }
function nGetPatientNotes() { try { return JSON.parse(localStorage.getItem('nPatientNotes') || '[]'); } catch { return []; } }
function nSavePatientNotes(a) { localStorage.setItem('nPatientNotes', JSON.stringify(a)); }
function nGetLotLinks() { try { return JSON.parse(localStorage.getItem('nLotLinks') || '[]'); } catch { return []; } }
function nSaveLotLinks(a) { localStorage.setItem('nLotLinks', JSON.stringify(a)); }
function nGetNotesHistory() { try { return JSON.parse(localStorage.getItem('nNotesHistory') || '[]'); } catch { return []; } }
function nSaveNotesHistory(a) { localStorage.setItem('nNotesHistory', JSON.stringify(a)); }
function nGetScanHistory() { try { return JSON.parse(localStorage.getItem('nScanHistory') || '[]'); } catch { return []; } }
function nSaveScanHistory(a) { localStorage.setItem('nScanHistory', JSON.stringify(a)); }
function nEsc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function nFormatDob(d) { if (!d) return ''; const dt = new Date(d + 'T00:00:00'); return dt.toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric' }); }
function nFormatNotes(t) { return t.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>'); }
function nTimestamp() { return new Date().toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }); }

async function nCopyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  }
  if (btn) { btn.classList.add('copy-success'); setTimeout(() => btn.classList.remove('copy-success'), 1500); }
}

// ══════════════════════════════════════════════════════════════════════
//  CLINICAL NOTES
// ══════════════════════════════════════════════════════════════════════
(function() {
  const transcript = document.getElementById('n-transcript');
  const extractBtn = document.getElementById('n-extract-btn');
  const clearBtn = document.getElementById('n-clear-btn');
  const copyBtn = document.getElementById('n-copy-btn');
  const newBtn = document.getElementById('n-new-btn');
  const retryBtn = document.getElementById('n-retry-btn');
  const savePatientBtn = document.getElementById('n-save-to-patient-btn');
  const cancelPicker = document.getElementById('n-cancel-picker');

  const inputSection = document.getElementById('n-input-section');
  const loading = document.getElementById('n-loading');
  const outputSection = document.getElementById('n-output-section');
  const errorSection = document.getElementById('n-error-section');
  const patientPicker = document.getElementById('n-patient-picker');
  const output = document.getElementById('n-output');
  const errorMsg = document.getElementById('n-error-msg');
  const historySection = document.getElementById('n-history-section');
  const historyOutput = document.getElementById('n-history-output');
  const copyHistoryBtn = document.getElementById('n-copy-history-btn');
  const clearHistoryBtn = document.getElementById('n-clear-history-btn');
  const pickerList = document.getElementById('n-picker-list');
  const pickerEmpty = document.getElementById('n-picker-empty');

  let lastNotes = '';

  transcript.addEventListener('input', () => {
    const has = transcript.value.trim().length > 0;
    extractBtn.disabled = !has;
    clearBtn.disabled = !has;
  });

  clearBtn.addEventListener('click', () => {
    transcript.value = '';
    extractBtn.disabled = true;
    clearBtn.disabled = true;
    transcript.focus();
  });

  extractBtn.addEventListener('click', async () => {
    const text = transcript.value.trim();
    if (!text) return;
    inputSection.classList.add('hidden');
    errorSection.classList.add('hidden');
    outputSection.classList.add('hidden');
    loading.classList.remove('hidden');
    try {
      const res = await fetch('/api/notes/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Extraction failed');
      lastNotes = data.notes;
      output.innerHTML = nFormatNotes(data.notes);
      loading.classList.add('hidden');
      outputSection.classList.remove('hidden');
      addToNotesHistory(data.notes);
    } catch (err) {
      loading.classList.add('hidden');
      errorMsg.textContent = err.message;
      errorSection.classList.remove('hidden');
    }
  });

  copyBtn.addEventListener('click', () => nCopyText(output.innerText, copyBtn));

  newBtn.addEventListener('click', () => {
    outputSection.classList.add('hidden');
    inputSection.classList.remove('hidden');
    transcript.value = '';
    extractBtn.disabled = true;
    clearBtn.disabled = true;
    transcript.focus();
  });

  retryBtn.addEventListener('click', () => {
    errorSection.classList.add('hidden');
    inputSection.classList.remove('hidden');
  });

  // Save to patient picker
  savePatientBtn.addEventListener('click', () => {
    const patients = nGetPatients();
    if (!patients.length) {
      pickerList.innerHTML = '';
      pickerEmpty.classList.remove('hidden');
    } else {
      pickerEmpty.classList.add('hidden');
      pickerList.innerHTML = patients.map(p => `
        <div class="n-patient-row" data-id="${p.id}">
          <div class="n-patient-row-info">
            <div class="n-patient-row-name">${nEsc(p.name)}</div>
            <div class="n-patient-row-meta">${p.dob ? nFormatDob(p.dob) : ''}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
        </div>
      `).join('');
      pickerList.querySelectorAll('.n-patient-row').forEach(row => {
        row.addEventListener('click', () => {
          const notes = nGetPatientNotes();
          notes.unshift({ id: nGenerateId(), patientId: row.dataset.id, name: nTimestamp(), content: lastNotes, createdAt: nTimestamp() });
          nSavePatientNotes(notes);
          patientPicker.classList.add('hidden');
          outputSection.classList.remove('hidden');
          savePatientBtn.textContent = 'Saved!';
          setTimeout(() => { savePatientBtn.textContent = 'Save to Patient'; }, 1500);
        });
      });
    }
    outputSection.classList.add('hidden');
    patientPicker.classList.remove('hidden');
  });

  cancelPicker.addEventListener('click', () => {
    patientPicker.classList.add('hidden');
    outputSection.classList.remove('hidden');
  });

  // Notes history
  function addToNotesHistory(content) {
    const history = nGetNotesHistory();
    const titleMatch = content.match(/\*\*(.+?)\*\*/);
    history.unshift({ id: nGenerateId(), title: titleMatch ? titleMatch[1] : 'Extracted Notes', content, createdAt: nTimestamp() });
    nSaveNotesHistory(history);
    renderNotesHistory();
  }

  function renderNotesHistory() {
    const history = nGetNotesHistory();
    if (!history.length) { historySection.classList.add('hidden'); return; }
    historySection.classList.remove('hidden');
    historyOutput.innerHTML = history.map((item, i) => `
      <div class="n-result-card n-history-card" data-index="${i}">
        <div class="n-note-card-header">
          <input class="n-note-name-input" type="text" value="${nEsc(item.title).replace(/"/g,'&quot;')}" data-index="${i}">
          <button class="n-btn-copy-sm" data-index="${i}" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
          <button class="n-btn-delete-sm" data-index="${i}" title="Remove"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="n-notes-body n-note-preview">${nFormatNotes(item.content)}</div>
        <div class="n-timestamp">${item.createdAt}</div>
      </div>
    `).join('');

    historyOutput.querySelectorAll('.n-note-name-input').forEach(input => {
      function save() { const t = input.value.trim(); if (!t) return; const h = nGetNotesHistory(); if (h[input.dataset.index]) { h[input.dataset.index].title = t; nSaveNotesHistory(h); } }
      input.addEventListener('blur', save);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    });

    historyOutput.querySelectorAll('.n-btn-delete-sm').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); const h = nGetNotesHistory(); h.splice(parseInt(btn.dataset.index), 1); nSaveNotesHistory(h); renderNotesHistory(); });
    });

    historyOutput.querySelectorAll('.n-btn-copy-sm').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); const h = nGetNotesHistory(); nCopyText(h[parseInt(btn.dataset.index)].content, btn); });
    });

    historyOutput.querySelectorAll('.n-history-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('.n-btn-delete-sm') || e.target.closest('.n-btn-copy-sm') || e.target.closest('.n-note-name-input')) return;
        const h = nGetNotesHistory();
        lastNotes = h[parseInt(card.dataset.index)].content;
        output.innerHTML = nFormatNotes(lastNotes);
        inputSection.classList.add('hidden');
        outputSection.classList.remove('hidden');
      });
    });
  }

  copyHistoryBtn.addEventListener('click', () => nCopyText(historyOutput.innerText, copyHistoryBtn));
  clearHistoryBtn.addEventListener('click', () => { if (confirm('Clear all notes history?')) { nSaveNotesHistory([]); renderNotesHistory(); } });

  renderNotesHistory();
})();

// ══════════════════════════════════════════════════════════════════════
//  LOT SCANNER
// ══════════════════════════════════════════════════════════════════════
(function() {
  const fileInput = document.getElementById('n-file-input');
  const dropZone = document.getElementById('n-drop-zone');
  const dropPlaceholder = document.getElementById('n-drop-placeholder');
  const scanBtn = document.getElementById('n-scan-btn');
  const scanCopyBtn = document.getElementById('n-scan-copy-btn');
  const newScanBtn = document.getElementById('n-new-scan-btn');
  const scanRetryBtn = document.getElementById('n-scan-retry-btn');
  const addMoreBtn = document.getElementById('n-add-more-btn');
  const clearAllBtn = document.getElementById('n-clear-all-btn');
  const previewGrid = document.getElementById('n-preview-grid');
  const linkPatientBtn = document.getElementById('n-link-patient-btn');
  const cancelLotPicker = document.getElementById('n-cancel-lot-picker');
  const lotPickerList = document.getElementById('n-lot-picker-list');
  const lotPickerEmpty = document.getElementById('n-lot-picker-empty');

  const uploadSection = document.getElementById('n-upload-section');
  const scanLoading = document.getElementById('n-scan-loading');
  const scanResults = document.getElementById('n-scan-results');
  const scanError = document.getElementById('n-scan-error');
  const lotPicker = document.getElementById('n-lot-picker');
  const scanOutput = document.getElementById('n-scan-output');
  const scanErrorMsg = document.getElementById('n-scan-error-msg');
  const scanHistorySection = document.getElementById('n-scan-history');
  const scanHistoryOutput = document.getElementById('n-scan-history-output');
  const copyScanHistBtn = document.getElementById('n-copy-scan-history-btn');
  const clearScanHistBtn = document.getElementById('n-clear-scan-history-btn');

  let imageDataList = [];
  let lastScanResultIds = [];

  function renderPreviews() {
    if (!imageDataList.length) {
      previewGrid.classList.add('hidden');
      previewGrid.innerHTML = '';
      dropPlaceholder.classList.remove('hidden');
      dropZone.style.display = '';
      addMoreBtn.classList.add('hidden');
      clearAllBtn.classList.add('hidden');
      scanBtn.disabled = true;
      return;
    }
    dropZone.style.display = 'none';
    previewGrid.classList.remove('hidden');
    addMoreBtn.classList.remove('hidden');
    clearAllBtn.classList.remove('hidden');
    scanBtn.disabled = false;
    previewGrid.innerHTML = imageDataList.map((src, i) => `
      <div class="n-preview-thumb">
        <img src="${src}" alt="Preview ${i+1}">
        <button class="n-preview-remove" data-index="${i}" title="Remove"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
    `).join('');
    previewGrid.querySelectorAll('.n-preview-remove').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); imageDataList.splice(parseInt(btn.dataset.index), 1); renderPreviews(); });
    });
  }

  function addFiles(files) {
    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = e => { imageDataList.push(e.target.result); renderPreviews(); };
      reader.readAsDataURL(file);
    });
  }

  dropZone.addEventListener('click', () => fileInput.click());
  addMoreBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files.length) addFiles(e.target.files); fileInput.value = ''; });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
  clearAllBtn.addEventListener('click', () => { imageDataList = []; renderPreviews(); });

  scanBtn.addEventListener('click', async () => {
    if (!imageDataList.length) return;
    uploadSection.classList.add('hidden');
    scanError.classList.add('hidden');
    scanResults.classList.add('hidden');
    scanLoading.classList.remove('hidden');
    try {
      const res = await fetch('/api/notes/scan-lot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images: imageDataList })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      scanOutput.innerHTML = formatScanResults(data.results);
      scanLoading.classList.add('hidden');
      scanResults.classList.remove('hidden');
      if (data.results && data.results.length) lastScanResultIds = addToScanHistory(data.results);
    } catch (err) {
      scanLoading.classList.add('hidden');
      scanErrorMsg.textContent = err.message;
      scanError.classList.remove('hidden');
    }
  });

  scanCopyBtn.addEventListener('click', () => nCopyText(scanOutput.innerText, scanCopyBtn));

  newScanBtn.addEventListener('click', () => {
    scanResults.classList.add('hidden');
    uploadSection.classList.remove('hidden');
    imageDataList = [];
    renderPreviews();
  });

  scanRetryBtn.addEventListener('click', () => {
    scanError.classList.add('hidden');
    uploadSection.classList.remove('hidden');
  });

  function formatScanResults(results) {
    if (!results || !results.length) return '<p class="n-empty">No lot numbers or expiry dates found.</p>';
    return results.map(item => `
      <div class="n-result-card">
        <div class="n-result-product">${nEsc(item.product || 'Unknown Product')}</div>
        <div class="n-result-fields">
          <div class="n-result-field"><span class="n-field-label">Lot Number</span><span class="n-field-value">${nEsc(item.lot || 'Not found')}</span></div>
          <div class="n-result-field"><span class="n-field-label">Expiry Date</span><span class="n-field-value">${nEsc(item.expiry || 'Not found')}</span></div>
        </div>
      </div>
    `).join('');
  }

  function addToScanHistory(results) {
    const history = nGetScanHistory();
    const ts = nTimestamp();
    const ids = [];
    results.forEach(item => { const id = nGenerateId(); ids.push(id); history.unshift({ ...item, id, scannedAt: ts }); });
    nSaveScanHistory(history);
    renderScanHistory();
    return ids;
  }

  function renderScanHistory() {
    const history = nGetScanHistory();
    if (!history.length) { scanHistorySection.classList.add('hidden'); return; }
    scanHistorySection.classList.remove('hidden');
    scanHistoryOutput.innerHTML = history.map((item, i) => `
      <div class="n-result-card">
        <div class="n-note-card-header">
          <div class="n-result-product" style="margin-bottom:0">${nEsc(item.product || 'Unknown Product')}</div>
          <div style="display:flex;gap:4px;">
            <button class="n-btn-copy-sm" data-index="${i}" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
            <button class="n-btn-delete-sm" data-index="${i}" title="Remove"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
          </div>
        </div>
        <div class="n-result-fields">
          <div class="n-result-field"><span class="n-field-label">Lot Number</span><span class="n-field-value">${nEsc(item.lot || 'Not found')}</span></div>
          <div class="n-result-field"><span class="n-field-label">Expiry Date</span><span class="n-field-value">${nEsc(item.expiry || 'Not found')}</span></div>
        </div>
        <div class="n-timestamp">${item.scannedAt}</div>
      </div>
    `).join('');

    scanHistoryOutput.querySelectorAll('.n-btn-copy-sm').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const item = history[parseInt(btn.dataset.index)];
        nCopyText(`Product: ${item.product || 'Unknown'}\nLot: ${item.lot || 'N/A'}\nExpiry: ${item.expiry || 'N/A'}`, btn);
      });
    });

    scanHistoryOutput.querySelectorAll('.n-btn-delete-sm').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); const h = nGetScanHistory(); h.splice(parseInt(btn.dataset.index), 1); nSaveScanHistory(h); renderScanHistory(); });
    });
  }

  copyScanHistBtn.addEventListener('click', () => nCopyText(scanHistoryOutput.innerText, copyScanHistBtn));
  clearScanHistBtn.addEventListener('click', () => { if (confirm('Clear all scan history?')) { nSaveScanHistory([]); renderScanHistory(); } });

  // Link to patient picker
  linkPatientBtn.addEventListener('click', () => {
    const patients = nGetPatients();
    if (!patients.length) { lotPickerList.innerHTML = ''; lotPickerEmpty.classList.remove('hidden'); }
    else {
      lotPickerEmpty.classList.add('hidden');
      lotPickerList.innerHTML = patients.map(p => `
        <div class="n-patient-row" data-id="${p.id}">
          <div class="n-patient-row-info"><div class="n-patient-row-name">${nEsc(p.name)}</div><div class="n-patient-row-meta">${p.dob ? nFormatDob(p.dob) : ''}</div></div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
        </div>
      `).join('');
      lotPickerList.querySelectorAll('.n-patient-row').forEach(row => {
        row.addEventListener('click', () => {
          const links = nGetLotLinks();
          lastScanResultIds.forEach(id => { if (!links.some(l => l.lotId === id && l.patientId === row.dataset.id)) links.push({ lotId: id, patientId: row.dataset.id }); });
          nSaveLotLinks(links);
          lotPicker.classList.add('hidden');
          scanResults.classList.remove('hidden');
          linkPatientBtn.textContent = 'Linked!';
          setTimeout(() => { linkPatientBtn.textContent = 'Link to Patient'; }, 1500);
        });
      });
    }
    scanResults.classList.add('hidden');
    lotPicker.classList.remove('hidden');
  });

  cancelLotPicker.addEventListener('click', () => { lotPicker.classList.add('hidden'); scanResults.classList.remove('hidden'); });

  renderScanHistory();
})();

// ══════════════════════════════════════════════════════════════════════
//  PATIENTS
// ══════════════════════════════════════════════════════════════════════
(function() {
  const patientsListSection = document.getElementById('n-patients-list');
  const createSection = document.getElementById('n-create-section');
  const detailSection = document.getElementById('n-detail-section');

  const addBtn = document.getElementById('n-add-patient-btn');
  const search = document.getElementById('n-patient-search');
  const patientListEl = document.getElementById('n-patient-list');
  const noPatients = document.getElementById('n-no-patients');

  const formTitle = document.getElementById('n-form-title');
  const editId = document.getElementById('n-edit-patient-id');
  const nameInput = document.getElementById('n-patient-name');
  const dobInput = document.getElementById('n-patient-dob');
  const phoneInput = document.getElementById('n-patient-phone');
  const cancelCreateBtn = document.getElementById('n-cancel-create-btn');
  const saveBtn = document.getElementById('n-save-patient-btn');

  const backBtn = document.getElementById('n-back-btn');
  const editBtn = document.getElementById('n-edit-patient-btn');
  const deleteBtn = document.getElementById('n-delete-patient-btn');
  const patientInfo = document.getElementById('n-patient-info');
  const patientNotesEl = document.getElementById('n-patient-notes');
  const noNotes = document.getElementById('n-no-notes');
  const patientLotsEl = document.getElementById('n-patient-lots');
  const noLots = document.getElementById('n-no-lots');

  const linkNoteBtn = document.getElementById('n-link-note-btn');
  const noteDropdown = document.getElementById('n-note-dropdown');
  const closeNoteDd = document.getElementById('n-close-note-dd');
  const notePickerList = document.getElementById('n-note-picker-list');
  const noAvailNotes = document.getElementById('n-no-avail-notes');
  const confirmNoteLink = document.getElementById('n-confirm-note-link');

  const linkLotBtn = document.getElementById('n-link-lot-detail-btn');
  const lotDropdown = document.getElementById('n-lot-dropdown');
  const closeLotDd = document.getElementById('n-close-lot-dd');
  const lotPickerDetailList = document.getElementById('n-lot-picker-detail-list');
  const noAvailLots = document.getElementById('n-no-avail-lots');
  const confirmLotLink = document.getElementById('n-confirm-lot-link');

  let currentPatientId = null;
  let selectedLotIds = new Set();
  let selectedNoteIds = new Set();

  function showSection(section) {
    [patientsListSection, createSection, detailSection].forEach(s => s.classList.add('hidden'));
    section.classList.remove('hidden');
    noteDropdown.classList.add('hidden');
    lotDropdown.classList.add('hidden');
  }

  function renderPatientList(filter) {
    const patients = nGetPatients();
    const filtered = filter ? patients.filter(p => p.name.toLowerCase().includes(filter.toLowerCase())) : patients;
    if (!filtered.length) {
      patientListEl.innerHTML = '';
      noPatients.classList.remove('hidden');
      noPatients.textContent = filter ? 'No patients match your search.' : 'No patients yet. Tap + New to add one.';
      return;
    }
    noPatients.classList.add('hidden');
    patientListEl.innerHTML = filtered.map(p => {
      const nc = nGetPatientNotes().filter(n => n.patientId === p.id).length;
      const lc = nGetLotLinks().filter(l => l.patientId === p.id).length;
      return `<div class="n-patient-row" data-id="${p.id}">
        <div class="n-patient-row-info">
          <div class="n-patient-row-name">${nEsc(p.name)}</div>
          <div class="n-patient-row-meta">${p.dob ? nFormatDob(p.dob) : ''}${p.dob && (nc||lc) ? ' &middot; ' : ''}${nc ? nc+' note'+(nc>1?'s':'') : ''}${nc&&lc?', ':''}${lc ? lc+' lot'+(lc>1?'s':'') : ''}</div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>
      </div>`;
    }).join('');
    patientListEl.querySelectorAll('.n-patient-row').forEach(row => {
      row.addEventListener('click', () => showPatientDetail(row.dataset.id));
    });
  }

  addBtn.addEventListener('click', () => {
    formTitle.textContent = 'New Patient';
    editId.value = '';
    nameInput.value = '';
    dobInput.value = '';
    phoneInput.value = '';
    saveBtn.disabled = true;
    showSection(createSection);
    nameInput.focus();
  });

  nameInput.addEventListener('input', () => { saveBtn.disabled = !nameInput.value.trim(); });

  cancelCreateBtn.addEventListener('click', () => {
    if (currentPatientId && editId.value) showSection(detailSection);
    else { showSection(patientsListSection); renderPatientList(); }
  });

  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const patients = nGetPatients();
    const id = editId.value;
    if (id) {
      const p = patients.find(p => p.id === id);
      if (p) { p.name = name; p.dob = dobInput.value || ''; p.phone = phoneInput.value.trim() || ''; }
      nSavePatients(patients);
      showPatientDetail(id);
    } else {
      const patient = { id: nGenerateId(), name, dob: dobInput.value || '', phone: phoneInput.value.trim() || '', createdAt: nTimestamp() };
      patients.unshift(patient);
      nSavePatients(patients);
      showPatientDetail(patient.id);
    }
  });

  function showPatientDetail(id) {
    currentPatientId = id;
    const patient = nGetPatients().find(p => p.id === id);
    if (!patient) return;
    showSection(detailSection);
    patientInfo.innerHTML = `
      <h3 class="n-patient-detail-name">${nEsc(patient.name)}</h3>
      <div class="n-patient-detail-fields">
        ${patient.dob ? `<div class="n-patient-detail-field"><span class="n-field-label">Date of Birth</span><span class="n-field-value">${nFormatDob(patient.dob)}</span></div>` : ''}
        ${patient.phone ? `<div class="n-patient-detail-field"><span class="n-field-label">Phone</span><span class="n-field-value">${nEsc(patient.phone)}</span></div>` : ''}
        <div class="n-patient-detail-field"><span class="n-field-label">Added</span><span class="n-field-value">${patient.createdAt}</span></div>
      </div>`;
    renderPatientNotes(id);
    renderPatientLots(id);
  }

  function renderPatientNotes(patientId) {
    const notes = nGetPatientNotes().filter(n => n.patientId === patientId);
    if (!notes.length) { patientNotesEl.innerHTML = ''; noNotes.classList.remove('hidden'); return; }
    noNotes.classList.add('hidden');
    patientNotesEl.innerHTML = notes.map(n => `
      <div class="n-result-card">
        <div class="n-note-card-header">
          <input class="n-note-name-input" type="text" value="${nEsc(n.name || n.createdAt).replace(/"/g,'&quot;')}" data-note-id="${n.id}">
          <button class="n-btn-delete-sm" data-note-id="${n.id}" title="Remove"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="n-timestamp">${n.createdAt}</div>
        <div class="n-notes-body n-note-preview">${nFormatNotes(n.content)}</div>
      </div>
    `).join('');

    patientNotesEl.querySelectorAll('.n-note-name-input').forEach(input => {
      function save() { const t = input.value.trim(); if (!t) return; const all = nGetPatientNotes(); const n = all.find(n => n.id === input.dataset.noteId); if (n && n.name !== t) { n.name = t; nSavePatientNotes(all); } }
      input.addEventListener('blur', save);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
    });

    patientNotesEl.querySelectorAll('.n-btn-delete-sm[data-note-id]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (confirm('Remove this note?')) {
          const all = nGetPatientNotes();
          const idx = all.findIndex(n => n.id === btn.dataset.noteId);
          if (idx !== -1) all.splice(idx, 1);
          nSavePatientNotes(all);
          renderPatientNotes(patientId);
        }
      });
    });
  }

  function renderPatientLots(patientId) {
    const links = nGetLotLinks().filter(l => l.patientId === patientId);
    const history = nGetScanHistory();
    if (!links.length) { patientLotsEl.innerHTML = ''; noLots.classList.remove('hidden'); return; }
    noLots.classList.add('hidden');
    const items = links.map(l => { const lot = history.find(h => h.id === l.lotId); return lot ? { ...lot, linkLotId: l.lotId } : null; }).filter(Boolean);
    if (!items.length) { patientLotsEl.innerHTML = ''; noLots.classList.remove('hidden'); return; }
    patientLotsEl.innerHTML = items.map(item => `
      <div class="n-result-card">
        <div class="n-note-card-header">
          <div class="n-result-product" style="margin-bottom:0">${nEsc(item.product || 'Unknown')}</div>
          <button class="n-btn-delete-sm" data-lot-id="${item.linkLotId}" title="Unlink"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="n-result-fields">
          <div class="n-result-field"><span class="n-field-label">Lot</span><span class="n-field-value">${nEsc(item.lot || 'N/A')}</span></div>
          <div class="n-result-field"><span class="n-field-label">Expiry</span><span class="n-field-value">${nEsc(item.expiry || 'N/A')}</span></div>
        </div>
        ${item.scannedAt ? `<div class="n-timestamp">Scanned ${item.scannedAt}</div>` : ''}
      </div>
    `).join('');
    patientLotsEl.querySelectorAll('.n-btn-delete-sm[data-lot-id]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const links = nGetLotLinks();
        const idx = links.findIndex(l => l.lotId === btn.dataset.lotId && l.patientId === patientId);
        if (idx !== -1) links.splice(idx, 1);
        nSaveLotLinks(links);
        renderPatientLots(patientId);
      });
    });
  }

  // Link Note dropdown
  linkNoteBtn.addEventListener('click', () => {
    if (!noteDropdown.classList.contains('hidden')) { noteDropdown.classList.add('hidden'); return; }
    const history = nGetNotesHistory();
    const existing = nGetPatientNotes().filter(n => n.patientId === currentPatientId);
    const linkedSet = new Set(existing.map(n => n.content));
    const available = history.filter(h => !linkedSet.has(h.content));
    selectedNoteIds.clear();
    confirmNoteLink.disabled = true;
    if (!available.length) { notePickerList.innerHTML = ''; noAvailNotes.classList.remove('hidden'); confirmNoteLink.classList.add('hidden'); }
    else {
      noAvailNotes.classList.add('hidden');
      confirmNoteLink.classList.remove('hidden');
      notePickerList.innerHTML = available.map(item => `
        <div class="n-dropdown-item n-note-picker-item" data-note-id="${item.id}">
          <div class="n-dropdown-item-main"><span class="n-dropdown-item-name">${nEsc(item.title)}</span><span class="n-dropdown-item-detail">${item.createdAt}</span></div>
          <div class="n-dropdown-check hidden"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
        </div>
      `).join('');
      notePickerList.querySelectorAll('.n-note-picker-item').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.noteId;
          const check = el.querySelector('.n-dropdown-check');
          if (selectedNoteIds.has(id)) { selectedNoteIds.delete(id); el.classList.remove('selected'); check.classList.add('hidden'); }
          else { selectedNoteIds.add(id); el.classList.add('selected'); check.classList.remove('hidden'); }
          confirmNoteLink.disabled = !selectedNoteIds.size;
          confirmNoteLink.textContent = selectedNoteIds.size ? `Link ${selectedNoteIds.size} Note${selectedNoteIds.size > 1 ? 's' : ''}` : 'Link Selected';
        });
      });
    }
    noteDropdown.classList.remove('hidden');
  });

  closeNoteDd.addEventListener('click', () => noteDropdown.classList.add('hidden'));

  confirmNoteLink.addEventListener('click', () => {
    const history = nGetNotesHistory();
    const notes = nGetPatientNotes();
    selectedNoteIds.forEach(hid => {
      const h = history.find(x => x.id === hid);
      if (h) notes.unshift({ id: nGenerateId(), patientId: currentPatientId, name: h.title, content: h.content, createdAt: h.createdAt });
    });
    nSavePatientNotes(notes);
    noteDropdown.classList.add('hidden');
    renderPatientNotes(currentPatientId);
  });

  // Link Lot dropdown
  linkLotBtn.addEventListener('click', () => {
    if (!lotDropdown.classList.contains('hidden')) { lotDropdown.classList.add('hidden'); return; }
    const history = nGetScanHistory();
    const existing = nGetLotLinks().filter(l => l.patientId === currentPatientId);
    const linkedIds = new Set(existing.map(l => l.lotId));
    const available = history.filter(h => h.id && !linkedIds.has(h.id));
    selectedLotIds.clear();
    confirmLotLink.disabled = true;
    if (!available.length) { lotPickerDetailList.innerHTML = ''; noAvailLots.classList.remove('hidden'); confirmLotLink.classList.add('hidden'); }
    else {
      noAvailLots.classList.add('hidden');
      confirmLotLink.classList.remove('hidden');
      lotPickerDetailList.innerHTML = available.map(item => `
        <div class="n-dropdown-item n-lot-picker-item" data-lot-id="${item.id}">
          <div class="n-dropdown-item-main"><span class="n-dropdown-item-name">${nEsc(item.product || 'Unknown')}</span><span class="n-dropdown-item-detail">${nEsc(item.lot || 'N/A')} &middot; ${nEsc(item.expiry || 'N/A')}</span></div>
          <div class="n-dropdown-check hidden"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>
        </div>
      `).join('');
      lotPickerDetailList.querySelectorAll('.n-lot-picker-item').forEach(el => {
        el.addEventListener('click', () => {
          const id = el.dataset.lotId;
          const check = el.querySelector('.n-dropdown-check');
          if (selectedLotIds.has(id)) { selectedLotIds.delete(id); el.classList.remove('selected'); check.classList.add('hidden'); }
          else { selectedLotIds.add(id); el.classList.add('selected'); check.classList.remove('hidden'); }
          confirmLotLink.disabled = !selectedLotIds.size;
          confirmLotLink.textContent = selectedLotIds.size ? `Link ${selectedLotIds.size} Lot${selectedLotIds.size > 1 ? 's' : ''}` : 'Link Selected';
        });
      });
    }
    lotDropdown.classList.remove('hidden');
  });

  closeLotDd.addEventListener('click', () => lotDropdown.classList.add('hidden'));

  confirmLotLink.addEventListener('click', () => {
    const links = nGetLotLinks();
    selectedLotIds.forEach(lotId => {
      if (!links.some(l => l.lotId === lotId && l.patientId === currentPatientId)) links.push({ lotId, patientId: currentPatientId });
    });
    nSaveLotLinks(links);
    lotDropdown.classList.add('hidden');
    renderPatientLots(currentPatientId);
  });

  // Edit / Delete
  editBtn.addEventListener('click', () => {
    const p = nGetPatients().find(p => p.id === currentPatientId);
    if (!p) return;
    formTitle.textContent = 'Edit Patient';
    editId.value = p.id;
    nameInput.value = p.name;
    dobInput.value = p.dob || '';
    phoneInput.value = p.phone || '';
    saveBtn.disabled = false;
    showSection(createSection);
    nameInput.focus();
  });

  deleteBtn.addEventListener('click', () => {
    if (!confirm('Delete this patient and all linked data?')) return;
    nSavePatients(nGetPatients().filter(p => p.id !== currentPatientId));
    nSavePatientNotes(nGetPatientNotes().filter(n => n.patientId !== currentPatientId));
    nSaveLotLinks(nGetLotLinks().filter(l => l.patientId !== currentPatientId));
    currentPatientId = null;
    showSection(patientsListSection);
    renderPatientList();
  });

  backBtn.addEventListener('click', () => {
    currentPatientId = null;
    showSection(patientsListSection);
    renderPatientList();
  });

  search.addEventListener('input', () => renderPatientList(search.value));

  renderPatientList();
})();
