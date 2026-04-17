// ============================================================
// CONSTANTS
// ============================================================

const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbz1u6kZeHj8LSuGuEh8PdApVTLU1AedVRlAvVff_0Tg00UgBpeKYSdOrsfJC-2_HQoD0Q/exec';

const UNITS = ['박스', '케이스', '봉지', '세트', '묶음', '다스', '개', '병', '캔', '봉', '팩', '장', '권', '통', '잔', '컵', '포', '롤'];

// Longer patterns first to avoid partial matching
const KOREAN_NATIVE_NUM = [
  ['스물아홉', 29], ['스물여덟', 28], ['스물일곱', 27], ['스물여섯', 26],
  ['스물다섯', 25], ['스물넷', 24], ['스물네', 24], ['스물셋', 23], ['스물세', 23],
  ['스물둘', 22], ['스물두', 22], ['스물하나', 21], ['스물한', 21],
  ['열아홉', 19], ['열여덟', 18], ['열일곱', 17], ['열여섯', 16],
  ['열다섯', 15], ['열넷', 14], ['열네', 14], ['열셋', 13], ['열세', 13],
  ['열둘', 12], ['열두', 12], ['열하나', 11], ['열한', 11],
  ['아홉', 9], ['여덟', 8], ['일곱', 7], ['여섯', 6],
  ['다섯', 5], ['넷', 4], ['네', 4], ['셋', 3], ['세', 3],
  ['둘', 2], ['두', 2], ['하나', 1], ['한', 1],
  ['스물', 20], ['열', 10],
  ['서른', 30], ['마흔', 40], ['쉰', 50],
  ['예순', 60], ['일흔', 70], ['여든', 80], ['아흔', 90],
];

const KOREAN_SINO_NUM = [
  ['구십', 90], ['팔십', 80], ['칠십', 70], ['육십', 60],
  ['오십', 50], ['사십', 40], ['삼십', 30], ['이십', 20],
  ['십구', 19], ['십팔', 18], ['십칠', 17], ['십육', 16],
  ['십오', 15], ['십사', 14], ['십삼', 13], ['십이', 12], ['십일', 11],
  ['천', 1000], ['백', 100], ['십', 10],
  ['구', 9], ['팔', 8], ['칠', 7], ['육', 6],
  ['오', 5], ['삼', 3], ['이', 2], ['일', 1],
];

// ============================================================
// STATE
// ============================================================

let state = {
  mode: 'dispatch',            // 'dispatch' | 'return'
  screen: 'main',              // 'main' | 'confirm' | 'candidates' | 'records' | 'settings' | 'products'
  products: [],
  settings: { manager: '', gasUrl: DEFAULT_GAS_URL },
  recognition: null,
  isListening: false,
  pendingRecord: null,
  voiceText: '',
  candidates: [],
  toast: null,
  installPrompt: null,
};

// ============================================================
// LOCALSTORAGE
// ============================================================

function loadFromStorage() {
  try {
    state.products = JSON.parse(localStorage.getItem('sm_products') || '[]');
    const saved = JSON.parse(localStorage.getItem('sm_settings') || '{}');
    state.settings = { manager: saved.manager || '', gasUrl: saved.gasUrl || DEFAULT_GAS_URL };
  } catch (e) {
    console.error('Storage load error:', e);
  }
}

function saveSettings() {
  localStorage.setItem('sm_settings', JSON.stringify(state.settings));
}

function saveProducts() {
  localStorage.setItem('sm_products', JSON.stringify(state.products));
}

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getTimeStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function getTodayRecords() {
  try {
    return JSON.parse(localStorage.getItem(`sm_records_${getTodayKey()}`) || '[]');
  } catch (e) { return []; }
}

function saveRecord(record) {
  const key = `sm_records_${getTodayKey()}`;
  const records = getTodayRecords();
  records.unshift(record);
  localStorage.setItem(key, JSON.stringify(records));
}

function updateRecordSync(id, synced) {
  const key = `sm_records_${getTodayKey()}`;
  const records = getTodayRecords();
  const rec = records.find(r => r.id === id);
  if (rec) {
    rec.synced = synced;
    localStorage.setItem(key, JSON.stringify(records));
  }
}

// ============================================================
// QUANTITY PARSING
// ============================================================

function parseQuantity(text) {
  if (!text) return { qty: 1, unit: '개' };

  // Pattern 1: Arabic number + unit (e.g., "3박스", "10 개")
  for (const unit of UNITS) {
    const m = text.match(new RegExp(`(\\d+)\\s*${unit}`));
    if (m) return { qty: parseInt(m[1]), unit };
  }

  // Pattern 2: Korean native number + unit (e.g., "세 박스")
  for (const unit of UNITS) {
    for (const [word, num] of KOREAN_NATIVE_NUM) {
      if (new RegExp(`${word}\\s*${unit}`).test(text)) return { qty: num, unit };
    }
  }

  // Pattern 3: Sino-Korean number + unit (e.g., "삼십 개")
  for (const unit of UNITS) {
    for (const [word, num] of KOREAN_SINO_NUM) {
      if (new RegExp(`${word}\\s*${unit}`).test(text)) return { qty: num, unit };
    }
  }

  // Pattern 4: Just Arabic number
  const numMatch = text.match(/(\d+)/);
  if (numMatch) return { qty: parseInt(numMatch[1]), unit: '개' };

  // Pattern 5: Just Korean native number
  for (const [word, num] of KOREAN_NATIVE_NUM) {
    if (text.includes(word)) return { qty: num, unit: '개' };
  }

  return { qty: 1, unit: '개' };
}

// ============================================================
// PRODUCT MATCHING
// ============================================================

function bigramSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const getBigrams = s => {
    const bg = [];
    for (let i = 0; i < s.length - 1; i++) bg.push(s.slice(i, i + 2));
    return bg;
  };
  const bg1 = getBigrams(a), bg2 = getBigrams(b);
  if (!bg1.length || !bg2.length) return a.includes(b) || b.includes(a) ? 0.5 : 0;
  const used = new Array(bg2.length).fill(false);
  let hits = 0;
  for (const bg of bg1) {
    const idx = bg2.findIndex((x, i) => !used[i] && x === bg);
    if (idx !== -1) { hits++; used[idx] = true; }
  }
  return (2 * hits) / (bg1.length + bg2.length);
}

function findMatches(text, products) {
  if (!products.length) return { confidence: 'none', product: '', candidates: [] };

  // Exact match
  for (const p of products) {
    if (text === p) return { confidence: 'exact', product: p, candidates: [] };
  }

  // Product name contained in text (longest wins)
  let bestContain = null, bestLen = 0;
  for (const p of products) {
    if (text.includes(p) && p.length > bestLen) { bestContain = p; bestLen = p.length; }
  }
  if (bestContain) return { confidence: 'exact', product: bestContain, candidates: [] };

  // Similarity scoring
  const scored = products
    .map(p => ({ product: p, score: bigramSimilarity(text, p) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (top.score >= 0.7) return { confidence: 'high', product: top.product, candidates: scored.slice(0, 5) };
  if (top.score >= 0.3) return { confidence: 'low', product: top.product, candidates: scored.slice(0, 5) };
  return { confidence: 'none', product: '', candidates: scored.filter(s => s.score > 0.1).slice(0, 5) };
}

function extractProductAndQty(voiceText, products) {
  const text = voiceText.trim();
  const matchResult = findMatches(text, products);

  // Remove matched product name from text before qty parsing
  let qtyText = text;
  if (matchResult.product) qtyText = text.replace(matchResult.product, '').trim() || text;

  return { ...matchResult, ...parseQuantity(qtyText), rawText: text };
}

// ============================================================
// VOICE RECOGNITION
// ============================================================

function initRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.lang = 'ko-KR';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 3;

  rec.onstart = () => {
    state.isListening = true;
    state.voiceText = '';
    render();
  };

  rec.onresult = (event) => {
    const last = event.results[event.results.length - 1];
    state.voiceText = last[0].transcript;
    const el = document.querySelector('.voice-interim');
    if (el) el.textContent = `"${state.voiceText}"`;
    if (last.isFinal) {
      state.isListening = false;
      processVoiceResult(state.voiceText);
    }
  };

  rec.onerror = (event) => {
    state.isListening = false;
    const msg = event.error === 'not-allowed'
      ? '마이크 권한이 필요합니다. 설정에서 허용해주세요.'
      : `음성 인식 오류: ${event.error}`;
    showToast(msg, 'error');
    render();
  };

  rec.onend = () => {
    if (state.isListening) { state.isListening = false; render(); }
  };

  return rec;
}

function startListening() {
  if (!state.recognition) state.recognition = initRecognition();
  if (!state.recognition) {
    showToast('이 브라우저는 음성 인식을 지원하지 않습니다.', 'error');
    return;
  }
  try { state.recognition.start(); }
  catch (e) { if (e.name !== 'InvalidStateError') showToast('마이크 오류가 발생했습니다.', 'error'); }
}

function stopListening() {
  if (state.recognition) state.recognition.stop();
  state.isListening = false;
}

function processVoiceResult(text) {
  if (!text?.trim()) { showToast('음성이 인식되지 않았습니다. 다시 시도하세요.', 'error'); render(); return; }

  const parsed = extractProductAndQty(text, state.products);

  state.pendingRecord = {
    type: state.mode === 'dispatch' ? '출고' : '반품',
    product: parsed.product,
    qty: parsed.qty,
    unit: parsed.unit,
    date: getTodayKey(),
    time: getTimeStr(),
    manager: state.settings.manager,
    rawText: text,
  };

  if (parsed.confidence === 'none' || parsed.confidence === 'low') {
    state.candidates = parsed.candidates || [];
    state.screen = 'candidates';
  } else {
    state.screen = 'confirm';
  }
  render();
}

// ============================================================
// GOOGLE APPS SCRIPT
// ============================================================

async function sendToGAS(record) {
  const url = DEFAULT_GAS_URL;

  const params = new URLSearchParams({
    type: record.type,
    product: record.product || '',
    qty: record.qty,
    unit: record.unit || '',
    date: record.date,
    time: record.time,
    manager: record.manager || '미설정',
    rawText: record.rawText || '',
  });

  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve({ success: false, reason: 'timeout' }), 8000);
    img.onload = img.onerror = () => { clearTimeout(timer); resolve({ success: true }); };
    img.src = `${url}?${params}`;
  });
}

function getGASCode() {
  return `function doGet(e)  { return handleRequest(e); }
function doPost(e)  { return handleRequest(e); }

function handleRequest(e) {
  var p = e.parameter;
  var action = p.action || 'record';
  var cb = p.callback;

  var result;
  if (action === 'getProducts')         result = getProductsData();
  else if (action === 'addProduct')     result = addProductData(p.name);
  else if (action === 'deleteProduct')  result = deleteProductData(p.name);
  else                                  result = recordEntryData(p);

  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(result) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getProductSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('제품목록');
  if (!sheet) {
    sheet = ss.insertSheet('제품목록');
    sheet.appendRow(['제품명']);
    sheet.getRange(1,1,1,1)
      .setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getProductsData() {
  var sheet = getProductSheet();
  var last = sheet.getLastRow();
  if (last < 2) return {products: []};
  var data = sheet.getRange(2, 1, last - 1, 1).getValues();
  var products = data.map(function(r){ return r[0]; }).filter(Boolean);
  return {products: products};
}

function addProductData(name) {
  if (!name) return {success: false};
  var sheet = getProductSheet();
  var last = sheet.getLastRow();
  if (last >= 2) {
    var existing = sheet.getRange(2, 1, last - 1, 1).getValues().flat();
    if (existing.indexOf(name) !== -1) return {success: true, duplicate: true};
  }
  sheet.appendRow([name]);
  return {success: true};
}

function deleteProductData(name) {
  if (!name) return {success: false};
  var sheet = getProductSheet();
  var last = sheet.getLastRow();
  if (last < 2) return {success: true};
  var data = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (data[i][0] === name) { sheet.deleteRow(i + 2); break; }
  }
  return {success: true};
}

function recordEntryData(p) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var today = p.date || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  // 날짜별 시트 가져오기 or 생성
  var sheet = ss.getSheetByName(today);
  if (!sheet) {
    sheet = ss.insertSheet(today);
    sheet.appendRow(['시간', '유형', '제품명', '수량', '단위', '담당자', '원본텍스트']);
    sheet.getRange(1,1,1,7)
      .setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }

  // 전체기록 시트 가져오기 or 생성
  var allSheet = ss.getSheetByName('전체기록');
  if (!allSheet) {
    allSheet = ss.insertSheet('전체기록', 0);
    allSheet.appendRow(['날짜','시간','유형','제품명','수량','단위','담당자','원본텍스트']);
    allSheet.getRange(1,1,1,8)
      .setBackground('#334155').setFontColor('#ffffff').setFontWeight('bold');
    allSheet.setFrozenRows(1);
  }

  // 출고=연파란, 반품=연노란
  var color = p.type === '출고' ? '#dbeafe' : '#fef9c3';

  sheet.appendRow([p.time, p.type, p.product, p.qty, p.unit, p.manager, p.rawText]);
  sheet.getRange(sheet.getLastRow(), 1, 1, 7).setBackground(color);

  allSheet.appendRow([p.date,p.time,p.type,p.product,p.qty,p.unit,p.manager,p.rawText]);
  allSheet.getRange(allSheet.getLastRow(), 1, 1, 8).setBackground(color);

  return {success: true};
}`;
}

function jsonpFetch(url, params) {
  return new Promise((resolve, reject) => {
    const cbName = '_gasCb_' + Date.now();
    const script = document.createElement('script');
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 8000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      script.remove();
    }
    window[cbName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error('script error')); };
    params.set('callback', cbName);
    script.src = `${url}?${params}`;
    document.head.appendChild(script);
  });
}

function gasBeacon(url, params) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve({ success: false, reason: 'timeout' }), 8000);
    img.onload = img.onerror = () => { clearTimeout(timer); resolve({ success: true }); };
    img.src = `${url}?${params}`;
  });
}

async function syncProductToGAS(action, name) {
  const url = DEFAULT_GAS_URL;
  gasBeacon(url, new URLSearchParams({ action, name }));
}

async function fetchProductsFromGAS() {
  const url = DEFAULT_GAS_URL;
  showToast('불러오는 중...', 'info');
  try {
    const data = await jsonpFetch(url, new URLSearchParams({ action: 'getProducts' }));
    if (Array.isArray(data.products)) {
      const merged = [...new Set([...data.products, ...state.products])];
      state.products = merged;
      saveProducts();
      render();
      showToast(`✅ ${merged.length}개 제품 동기화 완료`, 'success');
    } else {
      showToast('불러오기 실패. GAS 코드를 재배포해주세요.', 'error');
    }
  } catch (e) {
    showToast(`불러오기 실패: ${e.message}`, 'error');
  }
}

// ============================================================
// TOAST
// ============================================================

function showToast(message, type = 'info') {
  state.toast = { message, type };
  const el = document.getElementById('toast-container');
  if (el) {
    el.innerHTML = `<div class="toast toast-${type}">${escHtml(message)}</div>`;
  }
  clearTimeout(state._toastTimer);
  state._toastTimer = setTimeout(() => {
    state.toast = null;
    const el2 = document.getElementById('toast-container');
    if (el2) el2.innerHTML = '';
  }, 3000);
}

// ============================================================
// HELPERS
// ============================================================

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// RENDERING
// ============================================================

function render() {
  const app = document.getElementById('app');
  let html = '';
  switch (state.screen) {
    case 'main':       html = renderMainScreen();       break;
    case 'confirm':    html = renderConfirmScreen();    break;
    case 'candidates': html = renderCandidatesScreen(); break;
    case 'records':    html = renderRecordsScreen();    break;
    case 'settings':   html = renderSettingsScreen();   break;
    case 'products':   html = renderProductsScreen();   break;
    default:           html = renderMainScreen();
  }
  app.innerHTML = html + `<div id="toast-container"></div>`;

  // Restore toast if active
  if (state.toast) {
    const tc = document.getElementById('toast-container');
    if (tc) tc.innerHTML = `<div class="toast toast-${state.toast.type}">${escHtml(state.toast.message)}</div>`;
  }
}

function renderMainScreen() {
  const isDispatch = state.mode === 'dispatch';
  const mc = isDispatch ? 'dispatch' : 'return';
  const hasProducts = state.products.length > 0;

  return `
<div class="screen main-screen ${mc}-mode">
  <header class="header">
    <div class="logo">
      <span class="logo-icon">📦</span>
      <span class="logo-text">StockManager</span>
    </div>
    <div class="header-actions">
      ${state.installPrompt ? `<button class="icon-btn" data-action="install-pwa" title="홈화면에 추가">⬇️</button>` : ''}
      <button class="icon-btn" data-action="go-settings" title="설정">⚙️</button>
    </div>
  </header>

  <div class="mode-section">
    <div class="mode-toggle">
      <button class="mode-btn ${isDispatch ? 'active dispatch-active' : ''}" data-action="set-mode" data-mode="dispatch">
        <span>📤</span> 출고
      </button>
      <button class="mode-btn ${!isDispatch ? 'active return-active' : ''}" data-action="set-mode" data-mode="return">
        <span>📥</span> 반품
      </button>
    </div>
    ${state.settings.manager
      ? `<div class="manager-badge">👤 ${escHtml(state.settings.manager)}</div>`
      : `<button class="manager-set-btn" data-action="go-settings">담당자 미설정 →</button>`}
  </div>

  <div class="voice-section">
    <p class="voice-hint">${isDispatch ? '출고할' : '반품할'} 제품과 수량을 말씀해주세요</p>
    ${!hasProducts ? `<div class="no-products-warn">⚠️ 등록된 제품이 없습니다. <button class="link-btn" data-action="go-products">제품 추가 →</button></div>` : ''}

    <button class="mic-btn ${state.isListening ? 'listening' : ''} mic-${mc}" data-action="toggle-mic">
      <span class="mic-ripple"></span>
      <span class="mic-body">
        <span class="mic-icon">${state.isListening ? '◼' : '🎤'}</span>
        <span class="mic-label">${state.isListening ? '듣는 중...' : '탭하여 말하기'}</span>
      </span>
    </button>

    ${state.isListening ? `
    <div class="listening-dots">
      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      <span class="dot"></span><span class="dot"></span>
    </div>` : ''}

    <div class="voice-interim ${state.isListening && state.voiceText ? '' : 'hidden'}">
      "${escHtml(state.voiceText)}"
    </div>

    <div class="divider"><span>직접 입력</span></div>
    <div class="manual-row">
      <input type="text" id="manualInput" class="manual-input"
             placeholder='예: "콜라 세 박스" 또는 "사과 10개"'
             value="${escHtml(state.voiceText)}">
      <button class="manual-btn ${mc}-btn" data-action="manual-submit">확인</button>
    </div>
  </div>

  <div class="info-bar">
    <span class="info-chip">제품 ${state.products.length}종 등록</span>
    <button class="link-btn" data-action="go-records">오늘 기록 보기 →</button>
  </div>

  ${renderBottomNav('main')}
</div>`;
}

function renderConfirmScreen() {
  const r = state.pendingRecord;
  if (!r) return renderMainScreen();
  const isDispatch = r.type === '출고';
  const mc = isDispatch ? 'dispatch' : 'return';

  return `
<div class="screen confirm-screen">
  <header class="header">
    <button class="back-btn" data-action="go-main">‹ 뒤로</button>
    <h2 class="header-title">저장 확인</h2>
    <div style="width:40px"></div>
  </header>

  <div class="confirm-card">
    <div class="type-badge ${mc}-badge">${r.type}</div>

    <div class="confirm-field">
      <label class="field-label">제품명</label>
      <div class="confirm-row">
        <input type="text" id="cfProduct" class="confirm-input"
               value="${escHtml(r.product)}" placeholder="제품명 입력">
        <button class="small-btn" data-action="go-candidates">목록</button>
      </div>
    </div>

    <div class="confirm-field">
      <label class="field-label">수량</label>
      <div class="confirm-qty-row">
        <input type="number" id="cfQty" class="confirm-input qty-input"
               value="${r.qty}" min="1" max="9999">
        <select id="cfUnit" class="confirm-select">
          ${UNITS.map(u => `<option value="${u}" ${u === r.unit ? 'selected' : ''}>${u}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="confirm-field">
      <label class="field-label">담당자</label>
      <input type="text" id="cfManager" class="confirm-input"
             value="${escHtml(r.manager)}" placeholder="담당자명">
    </div>

    <div class="confirm-field">
      <label class="field-label">인식된 음성</label>
      <div class="raw-text-box">"${escHtml(r.rawText)}"</div>
    </div>

    <div class="confirm-meta">
      <span>📅 ${r.date}</span>
      <span>🕐 ${r.time}</span>
    </div>
  </div>

  <div class="confirm-actions">
    <button class="btn-cancel" data-action="go-main">취소</button>
    <button class="btn-save ${mc}-btn" data-action="save-record">
      ${isDispatch ? '📤 출고 저장' : '📥 반품 저장'}
    </button>
  </div>
</div>`;
}

function renderCandidatesScreen() {
  const r = state.pendingRecord;
  if (!r) return renderMainScreen();

  return `
<div class="screen candidates-screen">
  <header class="header">
    <button class="back-btn" data-action="go-main">‹ 뒤로</button>
    <h2 class="header-title">제품 선택</h2>
    <div style="width:40px"></div>
  </header>

  <div class="raw-voice-box">
    <p class="raw-label">인식된 음성</p>
    <p class="raw-content">"${escHtml(r.rawText)}"</p>
  </div>

  ${state.candidates.length ? `
  <div class="candidates-section">
    <p class="section-title">유사도 높은 제품</p>
    <div class="candidates-list">
      ${state.candidates.map((c, i) => `
        <button class="candidate-item" data-action="select-candidate" data-idx="${i}">
          <span class="candidate-name">${escHtml(c.product)}</span>
          <span class="candidate-score">${Math.round(c.score * 100)}%</span>
        </button>
      `).join('')}
    </div>
  </div>` : ''}

  <div class="all-products-section">
    <p class="section-title">전체 제품 목록</p>
    ${state.products.length === 0
      ? `<div class="empty-state"><p>등록된 제품이 없습니다.</p><button class="link-btn" data-action="go-products">제품 추가 →</button></div>`
      : `<div class="all-products-grid">
          ${state.products.map(p => `
            <button class="product-chip" data-action="select-product" data-product="${escHtml(p)}">
              ${escHtml(p)}
            </button>`).join('')}
        </div>`}
  </div>

  <div class="candidates-footer">
    <button class="btn-secondary" data-action="go-confirm">직접 입력으로 계속</button>
  </div>
</div>`;
}

function renderRecordsScreen() {
  const records = getTodayRecords();
  const dispatches = records.filter(r => r.type === '출고');
  const returns = records.filter(r => r.type === '반품');

  return `
<div class="screen records-screen">
  <header class="header">
    <h2 class="header-title">오늘의 기록</h2>
    <span class="date-chip">${getTodayKey()}</span>
  </header>

  <div class="summary-row">
    <div class="summary-card dispatch-summary">
      <span class="summary-num">${dispatches.length}</span>
      <span class="summary-lbl">출고</span>
    </div>
    <div class="summary-card return-summary">
      <span class="summary-num">${returns.length}</span>
      <span class="summary-lbl">반품</span>
    </div>
    <div class="summary-card total-summary">
      <span class="summary-num">${records.length}</span>
      <span class="summary-lbl">전체</span>
    </div>
  </div>

  <div class="records-list">
    ${records.length === 0
      ? `<div class="empty-state">
           <p class="empty-icon">📋</p>
           <p>오늘 기록이 없습니다.</p>
           <button class="link-btn" data-action="go-main">음성으로 기록하기 →</button>
         </div>`
      : records.map((r, i) => `
        <div class="record-item ${r.type === '출고' ? 'dispatch-record' : 'return-record'}">
          <div class="record-left">
            <span class="record-badge ${r.type === '출고' ? 'dispatch-badge' : 'return-badge'}">${r.type}</span>
          </div>
          <div class="record-body">
            <div class="record-product">${escHtml(r.product || '(제품 미지정)')}</div>
            <div class="record-detail">
              <span class="record-qty">${r.qty}${r.unit}</span>
              ${r.manager ? `<span class="record-manager">${escHtml(r.manager)}</span>` : ''}
              <span class="record-time">${r.time}</span>
            </div>
          </div>
          <div class="record-right">
            ${r.synced === true  ? '<span class="sync-ok"  title="전송됨">✓</span>' : ''}
            ${r.synced === false ? '<span class="sync-fail" title="전송실패">!</span>' : ''}
            <button class="record-del" data-action="delete-record" data-idx="${i}" title="삭제">×</button>
          </div>
        </div>`).join('')}
  </div>

  ${renderBottomNav('records')}
</div>`;
}

function renderSettingsScreen() {
  return `
<div class="screen settings-screen">
  <header class="header">
    <button class="back-btn" data-action="go-main">‹ 뒤로</button>
    <h2 class="header-title">설정</h2>
    <div style="width:40px"></div>
  </header>

  <div class="settings-group">
    <h3 class="group-title">기본 설정</h3>

    <div class="setting-field">
      <label class="setting-label">담당자 이름</label>
      <input type="text" id="stManager" class="setting-input"
             value="${escHtml(state.settings.manager)}" placeholder="이름 입력"
             data-action="autosave-manager">
    </div>

    <div class="setting-field">
      <label class="setting-label">Google Apps Script URL</label>
      <div class="gas-url-display">${escHtml(DEFAULT_GAS_URL)}</div>
    </div>
  </div>

  <div class="settings-group">
    <h3 class="group-title">제품 관리</h3>
    <button class="settings-nav-btn" data-action="go-products">
      <span>📦 제품 목록 관리</span>
      <span class="nav-meta">${state.products.length}종 등록 →</span>
    </button>
  </div>

  <div class="settings-group">
    <h3 class="group-title">Google Apps Script 코드</h3>
    <p class="setting-hint">아래 코드를 GAS에 붙여넣고 배포 후 URL을 위에 입력하세요.</p>
    <button class="btn-secondary" data-action="toggle-gas-code">코드 보기/숨기기</button>
    <div id="gasCodeBlock" class="gas-code-block hidden">
      <pre><code>${escHtml(getGASCode())}</code></pre>
      <button class="btn-copy dispatch-btn" data-action="copy-gas-code">복사</button>
    </div>
  </div>

  ${renderBottomNav('settings')}
</div>`;
}

function renderProductsScreen() {
  return `
<div class="screen products-screen">
  <header class="header">
    <button class="back-btn" data-action="go-settings">‹ 뒤로</button>
    <h2 class="header-title">제품 목록 (${state.products.length})</h2>
    <div style="width:40px"></div>
  </header>

  <div class="add-product-row">
    <input type="text" id="newProduct" class="setting-input"
           placeholder='제품명 입력 (예: 콜라 1.5L)'>
    <button class="btn-add dispatch-btn" data-action="add-product">추가</button>
  </div>

  <div class="sync-bar">
    <span class="sync-info">Sheets와 동기화</span>
    <button class="btn-sync" data-action="sync-products">
      ↕ Sheets 불러오기
    </button>
  </div>

  <div class="products-list">
    ${state.products.length === 0
      ? `<div class="empty-state"><p class="empty-icon">📦</p><p>등록된 제품이 없습니다.</p></div>`
      : state.products.map((p, i) => `
        <div class="product-list-item">
          <span class="product-list-name">${escHtml(p)}</span>
          <button class="product-del-btn" data-action="delete-product" data-idx="${i}">삭제</button>
        </div>`).join('')}
  </div>
</div>`;
}

function renderBottomNav(active) {
  const items = [
    { id: 'main',     icon: '🎤', label: '메인',  action: 'go-main'     },
    { id: 'records',  icon: '📋', label: '기록',  action: 'go-records'  },
    { id: 'settings', icon: '⚙️', label: '설정',  action: 'go-settings' },
  ];
  return `
<nav class="bottom-nav">
  ${items.map(item => `
    <button class="nav-item ${item.id === active ? 'nav-active' : ''}"
            data-action="${item.action}">
      <span class="nav-icon">${item.icon}</span>
      <span class="nav-label">${item.label}</span>
    </button>`).join('')}
</nav>`;
}

// ============================================================
// ACTION HANDLER
// ============================================================

async function handleAction(action, dataset) {
  switch (action) {

    case 'set-mode':
      state.mode = dataset.mode;
      render();
      break;

    case 'toggle-mic':
      state.isListening ? stopListening() : startListening();
      break;

    case 'manual-submit': {
      const inp = document.getElementById('manualInput');
      const txt = inp?.value?.trim();
      if (txt) processVoiceResult(txt);
      else showToast('텍스트를 입력해주세요.', 'error');
      break;
    }

    case 'go-main':
      if (state.isListening) stopListening();
      state.pendingRecord = null;
      state.screen = 'main';
      render();
      break;

    case 'go-records':   state.screen = 'records';   render(); break;
    case 'go-settings':  state.screen = 'settings';  render(); break;
    case 'go-products':  state.screen = 'products';  render(); break;
    case 'go-confirm':   state.screen = 'confirm';   render(); break;

    case 'go-candidates':
      state.candidates = state.products.map(p => ({ product: p, score: 0 }));
      state.screen = 'candidates';
      render();
      break;

    case 'select-candidate': {
      const c = state.candidates[parseInt(dataset.idx)];
      if (c && state.pendingRecord) state.pendingRecord.product = c.product;
      state.screen = 'confirm';
      render();
      break;
    }

    case 'select-product': {
      if (state.pendingRecord) state.pendingRecord.product = dataset.product;
      state.screen = 'confirm';
      render();
      break;
    }

    case 'save-record': {
      if (!state.pendingRecord) break;
      const product = document.getElementById('cfProduct')?.value?.trim() ?? state.pendingRecord.product;
      const qty = parseInt(document.getElementById('cfQty')?.value) || state.pendingRecord.qty;
      const unit = document.getElementById('cfUnit')?.value ?? state.pendingRecord.unit;
      const manager = document.getElementById('cfManager')?.value?.trim() ?? state.pendingRecord.manager;

      if (!product) { showToast('제품명을 입력해주세요.', 'error'); break; }

      const record = { ...state.pendingRecord, product, qty, unit, manager, id: Date.now(), synced: null };
      saveRecord(record);

      // Update default manager if changed
      if (manager && manager !== state.settings.manager) {
        state.settings.manager = manager;
        saveSettings();
      }

      state.pendingRecord = null;
      state.screen = 'main';
      state.voiceText = '';
      render();
      showToast('💾 저장 중...', 'info');

      sendToGAS(record).then(result => {
        if (result.success) {
          updateRecordSync(record.id, true);
          showToast('✅ 저장 및 전송 완료!', 'success');
        } else if (result.reason === 'no_url') {
          updateRecordSync(record.id, null);
          showToast('💾 저장 완료 (GAS URL 미설정)', 'info');
        } else {
          updateRecordSync(record.id, false);
          showToast('⚠️ 저장 완료, Sheets 전송 실패', 'warning');
        }
      });
      break;
    }

    case 'save-settings': {
      state.settings.manager = document.getElementById('stManager')?.value?.trim() ?? '';
      state.settings.gasUrl  = document.getElementById('stGasUrl')?.value?.trim() ?? '';
      saveSettings();
      showToast('✅ 설정 저장됨', 'success');
      render();
      break;
    }

    case 'test-gas': {
      window.open(`${DEFAULT_GAS_URL}?action=getProducts`, '_blank');
      showToast('새 탭에서 GAS 응답을 확인하세요.', 'info');
      break;
    }

    case 'add-product': {
      const inp = document.getElementById('newProduct');
      const name = inp?.value?.trim();
      if (!name) { showToast('제품명을 입력하세요.', 'error'); break; }
      if (state.products.includes(name)) { showToast('이미 등록된 제품입니다.', 'error'); break; }
      state.products.push(name);
      saveProducts();
      render();
      showToast(`'${name}' 추가됨`, 'success');
      syncProductToGAS('addProduct', name);
      // Re-focus input for rapid entry
      setTimeout(() => document.getElementById('newProduct')?.focus(), 50);
      break;
    }

    case 'delete-product': {
      const idx = parseInt(dataset.idx);
      const name = state.products[idx];
      state.products.splice(idx, 1);
      saveProducts();
      render();
      showToast(`'${name}' 삭제됨`, 'info');
      syncProductToGAS('deleteProduct', name);
      break;
    }

    case 'sync-products':
      fetchProductsFromGAS();
      break;

    case 'delete-record': {
      const idx = parseInt(dataset.idx);
      const key = `sm_records_${getTodayKey()}`;
      const recs = getTodayRecords();
      recs.splice(idx, 1);
      localStorage.setItem(key, JSON.stringify(recs));
      render();
      break;
    }

    case 'toggle-gas-code': {
      document.getElementById('gasCodeBlock')?.classList.toggle('hidden');
      break;
    }

    case 'copy-gas-code': {
      navigator.clipboard?.writeText(getGASCode())
        .then(() => showToast('📋 코드 복사됨', 'success'))
        .catch(() => showToast('복사 실패 — 직접 선택해주세요.', 'error'));
      break;
    }

    case 'install-pwa': {
      if (state.installPrompt) {
        state.installPrompt.prompt();
        const choice = await state.installPrompt.userChoice;
        state.installPrompt = null;
        if (choice.outcome === 'accepted') showToast('홈화면에 추가되었습니다!', 'success');
        render();
      }
      break;
    }
  }
}

// ============================================================
// INIT
// ============================================================

function init() {
  loadFromStorage();

  // Auto-save manager name on blur
  document.body.addEventListener('change', (e) => {
    if (e.target.id === 'stManager') {
      state.settings.manager = e.target.value.trim();
      saveSettings();
      showToast('✅ 담당자 저장됨', 'success');
    }
  });

  // Single delegated event listeners
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) {
      e.preventDefault();
      handleAction(el.dataset.action, el.dataset);
    }
  });

  // Enter key on manual input
  document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'manualInput') {
      const txt = e.target.value?.trim();
      if (txt) processVoiceResult(txt);
    }
    if (e.key === 'Enter' && e.target.id === 'newProduct') {
      handleAction('add-product', {});
    }
  });

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    render();
  });

  // Service worker registration (for manual fallback)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  render();
}

init();
