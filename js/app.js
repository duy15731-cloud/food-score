// Food Score — page logic (camera, lookups, rendering). All scoring lives in engine.js.
import * as E from './engine.js';
import { STR } from './i18n.js';

const $ = (id) => document.getElementById(id);
const VERSION = self.APP_VERSION || 'dev';
const abs = (p) => new URL(p, location.href).href;
let lang = localStorage.getItem('fs_lang') || 'vi';
let current = null;        // what the result screen is showing: {kind, ...}
let sortWorst = false;

const t = (k, vars) => {
  let out = STR[k] ? STR[k][lang] : k;
  if (vars) for (const [n, v] of Object.entries(vars)) out = out.replace(`{${n}}`, v);
  return out;
};
const L = (o) => (o == null ? '' : typeof o === 'string' ? o : (o[lang] || o.en || ''));
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ language
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('.lang-opt').forEach((b) => {
    const on = b.dataset.lang === lang;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-ph]').forEach((el) => { el.placeholder = t(el.dataset.ph); });
  $('scanNext').textContent = t('scanNext');
  $('updateBtn').textContent = t('update');
  $('iosTip').textContent = t('iosTip');
  $('buildStamp').textContent = `v${VERSION}`;
  if (!$('busy').hidden) busyRender();
  renderHistory();
  if (current) renderCurrent();
  if (!$('ranking').hidden) renderRanking();
}
document.querySelectorAll('.lang-opt').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.lang === lang) return;
    lang = b.dataset.lang; localStorage.setItem('fs_lang', lang); applyLang();
  };
});

// ------------------------------------------------------------------ views + the phone's Back button
// Opening the camera or a result adds ONE history entry, so Android's hardware/gesture Back (and the
// iPhone swipe) closes the camera / returns home instead of leaving the app. Camera -> result replaces
// that entry, so Back from a result always lands on home.
const navState = () => (history.state && history.state.fs) || null;
function navTo(view, push = false) {
  if (navState() && !push) history.replaceState({ fs: view }, '');
  else history.pushState({ fs: view }, '');
}
function goHome() {                       // on-screen "Back"/"Home" buttons
  if (navState()) history.back();        // -> popstate below does the work
  else { stopScanner(); showHome(); }
}
window.addEventListener('popstate', () => {
  const s = navState();
  if (!$('scanner').hidden && s !== 'camera') stopScanner();
  if (!s) showHome();
  else if (s === 'ranking') showRanking();
  else if (s === 'result' && current) showResultView();
});
function showHome() {
  current = null;
  $('result').hidden = true; $('ranking').hidden = true; $('home').hidden = false; $('scanNext').hidden = true;
  renderHistory();
  window.scrollTo(0, 0);
}
function showResultView() {
  $('home').hidden = true; $('ranking').hidden = true; $('result').hidden = false; $('scanNext').hidden = false;
  window.scrollTo(0, 0);
}
// busy overlay: text is kept as a string KEY so a language switch mid-way re-translates it
const busyNow = { key: '', step: '' };
function busyRender() { $('busyText').textContent = busyNow.key ? t(busyNow.key) : ''; $('busyStep').textContent = busyNow.step || ''; }
function busy(on, key = '', step = '') { busyNow.key = key; busyNow.step = step; $('busy').hidden = !on; busyRender(); }

// ------------------------------------------------------------------ product cache (raw OFF JSON = inputs; failures never cached)
const CACHE_PREFIX = 'fs_p_';
const CACHE_DAYS = 30;
const cacheKey = (code, db = 'food') => CACHE_PREFIX + (db === 'food' ? '' : db + '_') + code;   // food keys unchanged from v1.0
function cacheGet(code, db = 'food') {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(code, db)) || 'null');
    if (v && Date.now() - v.t < CACHE_DAYS * 864e5) return v.p;
  } catch { /* ignore */ }
  return null;
}
function cachePut(code, product, db = 'food') {
  const write = () => localStorage.setItem(cacheKey(code, db), JSON.stringify({ t: Date.now(), p: product }));
  try { write(); } catch {
    // storage full: drop the oldest half of cached products, then retry once
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX))
      .map((k) => [k, (JSON.parse(localStorage.getItem(k) || '{}').t || 0)]).sort((a, b) => a[1] - b[1]);
    keys.slice(0, Math.ceil(keys.length / 2)).forEach(([k]) => localStorage.removeItem(k));
    try { write(); } catch { /* give up quietly: caching is optional */ }
  }
}

// Look one code up in ONE database (all barcode candidates, in order). Same three states as before.
async function lookupIn(db, cands) {
  let failed = false;
  for (const c of cands) {
    let state = 'failed', body = null, status = 0;
    try {
      const res = await fetch(E.offUrl(c, db));
      status = res.status;
      body = await res.json().catch(() => null);
      state = E.classifyOffResponse(status, body);
    } catch { state = 'failed'; }
    if (state === 'found') { cachePut(c, body.product, db); return { state, product: body.product, code: c, db }; }
    if (state === 'failed') failed = true;
  }
  return { state: failed ? 'failed' : 'notfound', db };
}
// Open Food Facts first (most scans are food); if it does not have the code, ask Open Beauty Facts and
// Open Products Facts at the same time. A database that did not answer makes the result "failed", never "not found".
async function lookup(code, format = '') {
  const cands = E.lookupCandidates(code, format);
  for (const d of E.DATABASES) for (const c of cands) { const p = cacheGet(c, d.id); if (p) return { state: 'found', product: p, code: c, db: d.id, cached: true, tried: cands }; }
  const food = await lookupIn('food', cands);
  if (food.state === 'found') return { ...food, tried: cands };
  const rest = await Promise.all(E.DATABASES.filter((d) => d.id !== 'food').map((d) => lookupIn(d.id, cands)));
  const all = [food, ...rest];
  const r = E.combineLookups(all);
  return { ...r, code: r.code || code, tried: cands, dbStates: all.map((x) => `${x.db}:${x.state}`) };
}

// ------------------------------------------------------------------ history = "My products" (last 200)
const HIST_MAX = 200;
function histGet() { try { return JSON.parse(localStorage.getItem('fs_hist') || '[]'); } catch { return []; } }
function histAdd(item) {
  let list = histGet().filter((x) => !(item.code && x.code === item.code) && !(item.ocr && x.ocr === item.ocr));
  list.unshift({ ...item, t: Date.now() });
  list = list.slice(0, HIST_MAX);
  for (let i = 0; i < 4; i++) {
    try { localStorage.setItem('fs_hist', JSON.stringify(list)); return; } catch {
      // storage full: drop the photo text of the oldest half (the scores stay), then retry
      list = list.map((x, j) => (j > list.length / 2 && x.ocr ? { ...x, ocr: x.ocr.slice(0, 1500) } : x));
      if (i === 2) list = list.slice(0, Math.ceil(list.length / 2));
    }
  }
}
const histEntry = (a, extra) => ({ score: a.score, ecs: a.eczemaScore ? a.eczemaScore.score : null, type: a.type || 'food', ecz: a.eczema.overall, ...extra });
const TYPE_ICON = { food: '🍎', cosmetic: '🧴', household: '🧽' };
const mini = (v, title) => `<span class="mini" title="${h(title)}" style="background:${v == null ? '#9aa0a6' : E.bandFor(v).color}">${v == null ? '?' : v}</span>`;
function histRow(x, i) {
  return `<li><button type="button" class="hist-item" data-i="${i}">
    <span class="hist-type">${TYPE_ICON[x.type || 'food']}</span>
    <span class="hist-name">${h(x.name || x.code)}</span>
    <span class="mini-pair"><span class="mini-lab">${h(t((x.type || 'food') === 'food' ? 'scoreHealthShort' : 'scoreHarmShort'))}</span>${mini(x.score, t('scoreHealth'))}
    <span class="mini-lab">${h(t('scoreEczemaShort'))}</span>${mini(x.ecs, t('scoreEczema'))}</span>
  </button></li>`;
}
function openHist(x, push) { if (x.ocr) showPhotoResult(x.ocr, { push, type: x.type }); else openBarcode(x.code, '', { push }); }
function renderHistory() {
  const list = histGet();
  $('histList').innerHTML = list.length ? list.slice(0, 8).map(histRow).join('') : `<li class="empty">${h(t('noHistory'))}</li>`;
  $('histList').querySelectorAll('.hist-item').forEach((b) => { b.onclick = () => openHist(histGet()[Number(b.dataset.i)]); });
  $('rankBtn').hidden = !list.length;
}
$('clearHist').onclick = () => { localStorage.removeItem('fs_hist'); renderHistory(); };

// ------------------------------------------------------------------ "My products": every scanned product, ranked
const rk = { q: '', filter: 'all', sort: 'score', dir: 'best' };
function showRanking() {
  current = null;
  $('home').hidden = true; $('result').hidden = true; $('ranking').hidden = false; $('scanNext').hidden = true;
  renderRanking();
  window.scrollTo(0, 0);
}
const seg = (group, opts, active) => `<div class="seg" role="group" data-group="${group}">${opts.map(([v, k]) => `<button type="button" class="seg-opt${v === active ? ' active' : ''}" data-v="${v}" aria-pressed="${v === active}">${h(t(k))}</button>`).join('')}</div>`;
function renderRanking() {
  $('ranking').innerHTML = `<button type="button" class="link back" id="rkBack">${h(t('back'))}</button>
    <h2 class="rk-title">📊 ${h(t('myProducts'))}</h2>
    <input id="rkSearch" class="rk-search" type="search" autocomplete="off" placeholder="${h(t('rkSearchPh'))}" value="${h(rk.q)}">
    ${seg('filter', [['all', 'rkAll'], ['food', 'rkFood'], ['nonfood', 'rkNonFood']], rk.filter)}
    ${seg('sort', [['score', 'rkSortScore'], ['eczema', 'rkSortEczema']], rk.sort)}
    ${seg('dir', [['best', 'rkBest'], ['worst', 'rkWorst']], rk.dir)}
    <p class="muted small" id="rkCount"></p><ul id="rkList" class="rk-list"></ul>`;
  $('rkBack').onclick = goHome;
  $('rkSearch').oninput = (e) => { rk.q = e.target.value; renderRankList(); };
  $('ranking').querySelectorAll('.seg').forEach((g) => g.querySelectorAll('.seg-opt').forEach((b) => {
    b.onclick = () => { rk[g.dataset.group] = b.dataset.v; renderRanking(); };
  }));
  renderRankList();
}
function rankedItems() {
  const all = histGet().map((x, i) => ({ ...x, i }));
  const q = rk.q.trim().toLowerCase();
  const key = rk.sort === 'eczema' ? 'ecs' : 'score';
  return all.filter((x) => (rk.filter === 'all' || (rk.filter === 'food' ? (x.type || 'food') === 'food' : (x.type || 'food') !== 'food'))
      && (!q || String(x.name || x.code || '').toLowerCase().includes(q)))
    .sort((a, b) => {
      const va = a[key], vb = b[key];
      if (va == null && vb == null) return b.t - a.t;
      if (va == null) return 1;                       // "no score" always last, whichever direction
      if (vb == null) return -1;
      return rk.dir === 'best' ? vb - va : va - vb;
    });
}
function renderRankList() {
  const items = rankedItems();
  $('rkCount').textContent = t('rkCount', { n: items.length });
  $('rkList').innerHTML = items.length ? items.map((x) => histRow(x, x.i)).join('') : `<li class="empty">${h(t('rkEmpty'))}</li>`;
  $('rkList').querySelectorAll('.hist-item').forEach((b) => { b.onclick = () => openHist(histGet()[Number(b.dataset.i)], true); });
}
$('rankBtn').onclick = () => { navTo('ranking', true); showRanking(); };

// ------------------------------------------------------------------ barcode flow
async function openBarcode(raw, format = '', opts = {}) {
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) { alert(t('badCode')); return; }
  busy(true, 'looking');
  const res = await lookup(code, format);
  busy(false);
  if (res.state === 'found') {
    const analysis = E.analyze(E.inputFromOff(res.product, res.db));
    current = { kind: 'off', product: res.product, code: res.code, db: res.db, analysis, cached: res.cached };
    histAdd(histEntry(analysis, { code: res.code, name: productName(res.product) }));
  } else {
    current = { kind: res.state, code, tried: res.tried, format, dbStates: res.dbStates };
  }
  current.push = !!opts.push;
  window.__lastResult = current;   // for automated checks
  renderCurrent();
  navTo('result', opts.push);
  showResultView();
}
$('typeForm').onsubmit = (e) => { e.preventDefault(); const v = $('codeInput').value; $('codeInput').blur(); openBarcode(v); };
const productName = (p) => p.product_name_vi && lang === 'vi' ? p.product_name_vi : (p.product_name || p.product_name_en || p.product_name_vi || '');

// ------------------------------------------------------------------ rendering
function renderCurrent() {
  const c = current;
  const back = `<button type="button" class="link back" id="backBtn">${h(t(c.push ? 'camBack' : 'back'))}</button>`;
  let html = '';
  if (c.kind === 'off') html = back + (c.fromPhoto ? renderPhotoBg(c.fromPhoto) : '') + renderAnalysis(c.analysis, { product: c.product, code: c.code, db: c.db });
  else if (c.kind === 'photo' && c.outcome === 'unreadable') html = back + renderUnreadable(c);
  else if (c.kind === 'photo') html = back + renderAnalysis(c.analysis, { photo: c });
  else if (c.kind === 'notfound') {
    html = back + `<section class="card msg" id="notFoundCard"><h2>${h(t('notFound'))}</h2><p>${h(t('notFoundHelp'))}</p>
      <label class="big primary">📷 ${h(t('photoIngredients'))}<input type="file" accept="image/*" capture="environment" hidden class="photo-again"></label>
      <p class="muted small">${h(t('barcode'))}: ${h(c.code)} · ${h(t('tried'))}: ${h(c.tried.join(', '))}</p></section>`;
  } else if (c.kind === 'failed') {
    html = back + `<section class="card msg warn"><h2>${h(t('failed'))}</h2>
      <p class="muted">${h(t('barcode'))}: ${h(c.code)}</p><button type="button" class="big primary" id="retryBtn">${h(t('retry'))}</button></section>`;
  }
  $('result').innerHTML = html;
  $('backBtn').onclick = goHome;
  const see = $('seePhotoRead'); if (see) see.onclick = () => showPhotoResult(c.fromPhoto.read.text, c.fromPhoto.read.meta);
  const rb = $('retryBtn'); if (rb) rb.onclick = () => openBarcode(c.code, c.format);
  $('result').querySelectorAll('.photo-again').forEach((inp) => { inp.onchange = () => inp.files[0] && onPhoto(inp.files[0]); });
  const sb = $('sortBtn'); if (sb) sb.onclick = () => { sortWorst = !sortWorst; renderCurrent(); };
}

function circle(id, title, score, band, partial, unknownText) {
  const head = `<div class="circle-title">${h(title)}</div>`;
  if (score == null) return `<div class="score-col">${head}<div class="circle unknown" id="${id}"><span class="num">?</span></div><div class="band" style="color:#5f6368">${h(unknownText)}</div></div>`;
  return `<div class="score-col">${head}<div class="circle${partial ? ' partial' : ''}" id="${id}" style="--c:${band.color}"><span class="num">${score}</span><span class="of">/100</span></div>
    <div class="band" style="color:${band.color}">${h(L(band.label))}</div></div>`;
}
// TWO numbers side by side: health (food) or harmful-ingredients (non-food), and eczema
function scoreCircles(a) {
  const food = (a.type || 'food') === 'food';
  const es = a.eczemaScore;
  return circle('scoreCircle', t(food ? 'scoreHealth' : 'scoreHarm'), a.score, a.band, a.partial, t(food ? 'notEnough' : 'cantCheck'))
    + circle('eczemaCircle', t('scoreEczema'), es ? es.score : null, es ? es.band : null, false, t('cantCheck'));
}

function renderAnalysis(a, { product, code, photo, db }) {
  if ((a.type || 'food') !== 'food') return renderNonFood(a, { product, code, photo, db });
  const parts = a.parts;
  const name = product ? productName(product) : t('photoName');
  const img = product && (product.image_front_small_url || product.image_front_url);
  let out = `<section class="card score-card">`;
  out += `<div class="prod">${img ? `<img src="${h(img)}" alt="" class="prod-img" referrerpolicy="no-referrer">` : ''}
    <div><div class="prod-name">${h(name || code)}</div>${product && product.brands ? `<div class="muted">${h(product.brands)}</div>` : ''}
    ${code ? `<div class="muted small">${h(t('barcode'))} ${h(code)}</div>` : ''}</div></div>`;
  if (photo) {
    out += `<div class="banner warn">${h(t('photoWarn'))}</div>`;
    if (photo.barcode && photo.barcodeState === 'notfound') out += `<div class="banner info">${h(t('bcNotInDb', { code: photo.barcode }))}</div>`;
    if (photo.barcode && photo.barcodeState === 'failed') out += `<div class="banner info">${h(t('bcLookupFailed', { code: photo.barcode }))}</div>`;
    if (photo.outcome === 'ingredients_only') out += `<div class="banner info" id="noFactsMsg">${h(t('photoNoFacts'))}</div>`;
  }
  out += `<div class="score-row">${scoreCircles(a)}</div>`;
  if (a.score == null && !(photo && photo.outcome === 'ingredients_only')) out += `<p class="explain">${h(photo ? t('photoNoScore') : t('notEnoughWhy'))}</p>`;
  if (a.score != null && a.partial) out += `<div class="banner warn">${h(t('partialWarn'))}${a.missing.map((m) => h(t('miss_' + m))).join(', ')}</div>`;
  out += `<ul class="reasons">${a.reasons.map((r) => `<li class="r-${r.kind}">${h(L(r))}</li>`).join('')}</ul>`;
  const ns = parts.nutrition.nutriscore;
  out += `<details class="breakdown"><summary>${h(t('breakdown'))}</summary><table>
    <tr><td>${h(t('nutrition'))}</td><td>${parts.nutrition.points == null ? h(t('unknown')) : `${Math.round(parts.nutrition.points)}/60`}${ns && ns.grade ? ` · Nutri-Score ${ns.grade.toUpperCase()}${ns.score != null ? ` (${ns.score})` : ''}` : ''}</td></tr>
    <tr><td>${h(t('additives'))}</td><td>${parts.additives.points == null ? h(t('unknown')) : `${parts.additives.points}/30`}</td></tr>
    <tr><td>${h(t('processing'))}</td><td>${parts.processing.points == null ? h(t('unknown')) : `${parts.processing.points}/10 · NOVA ${parts.processing.nova}${parts.processing.estimated ? ` (${h(t('estimate'))})` : ''}`}</td></tr>
    ${a.capped ? `<tr><td colspan="2" class="r-bad">${h(t('capped'))}</td></tr>` : ''}</table></details>`;
  out += `</section>`;

  out += renderEczema(a.eczema, a.eczemaScore, 'food');
  out += renderIngredients(a.ingredients, product);
  out += renderAdditives(parts.additives);
  out += photo ? renderPhotoRead(photo) : '';
  if (!photo || photo.per100) out += renderNutrients(a);
  return out;
}
// cosmetics / personal care / household: harmful-ingredients score instead of the nutrition score
function renderNonFood(a, { product, code, photo, db }) {
  const name = product ? productName(product) : t('photoName');
  const img = product && (product.image_front_small_url || product.image_front_url);
  const dbName = db ? (E.DATABASES.find((d) => d.id === db) || {}).name : '';
  let out = `<section class="card score-card">`;
  out += `<div class="prod">${img ? `<img src="${h(img)}" alt="" class="prod-img" referrerpolicy="no-referrer">` : ''}
    <div><div class="prod-name">${h(name || code)}</div>${product && product.brands ? `<div class="muted">${h(product.brands)}</div>` : ''}
    <div class="type-chip" id="typeChip">${TYPE_ICON[a.type]} ${h(t('type_' + a.type))}${dbName ? ` · ${h(dbName)}` : ''}</div>
    ${code ? `<div class="muted small">${h(t('barcode'))} ${h(code)}</div>` : ''}</div></div>`;
  if (photo) out += `<div class="banner warn">${h(t('photoWarn'))}</div>`;
  out += `<div class="score-row">${scoreCircles(a)}</div>`;
  if (a.score == null) {
    out += `<div class="banner info" id="noIngMsg">${h(t('nfNoIngredients'))}</div>
      <label class="big primary">📷 ${h(t('photoIngredients'))}<input type="file" accept="image/*" capture="environment" hidden class="photo-again"></label>`;
  }
  out += `<ul class="reasons">${a.reasons.map((r) => `<li class="r-${r.kind}">${h(L(r))}</li>`).join('')}</ul>`;
  out += `<details class="breakdown"><summary>${h(t('breakdown'))}</summary><p class="small">${h(t('harmRule'))}</p></details></section>`;
  out += renderEczema(a.eczema, a.eczemaScore, a.type);
  out += renderHarm(a.parts.harm);
  out += renderIngredients(a.ingredients, product);
  out += photo ? `<section class="card photo-read" id="photoRead"><h2>${h(t('whatRead'))}</h2>
    ${photo.rotation ? `<p class="muted small">${h(t('photoTurned', { deg: photo.rotation }))}</p>` : ''}
    <details><summary>${h(t('ocrText'))}</summary><pre class="ocr">${h(photo.text)}</pre></details></section>` : '';
  return out;
}
function renderHarm(hz) {
  let out = `<section class="card additives" id="harmPanel"><h2>${h(t('harmHead'))}</h2>`;
  if (hz.points == null) return out + `<p class="muted">${h(t('cantCheck'))}</p></section>`;
  if (!hz.list.length) return out + `<p class="ec-msg ok">✓ ${h(t('harmNone'))}</p></section>`;
  out += `<ul class="add-list">${hz.list.map((x) => `<li><span class="dot risk-${x.risk}"></span><div><b>${h(L(x.label))}</b>
    <span class="tag risk-${x.risk}">${h(t('risk_' + x.risk))}</span>${x.via ? ` <span class="muted small">(${h(x.via)})</span>` : ''}<div class="ing-why">${h(L(x.why))}</div></div></li>`).join('')}</ul></section>`;
  return out;
}

// result came from a barcode found in the photo: say so, and offer what the text reading found
function renderPhotoBg(fp) {
  let out = `<div class="banner ok" id="bcInPhoto">${h(t('bcFoundDb'))}</div>`;
  if (fp.state === 'reading') out += `<div class="banner info" id="photoBg">${h(t('photoReadingBg'))} <b id="photoPct">${fp.pct ? `${fp.pct}%` : ''}</b></div>`;
  else if (fp.state === 'done' && fp.read && fp.read.outcome !== 'unreadable') out += `<button type="button" class="big secondary" id="seePhotoRead">${h(t('photoSeeRead'))}</button>`;
  else out += `<div class="banner info" id="photoBg">${h(t('photoBgFail'))}</div>`;
  return out;
}
// OCR found nothing usable: never a blank page — say so, give tips, show the raw read, offer a retry
function renderUnreadable(c) {
  return `<section class="card msg warn" id="ocrFail"><h2>${h(t('ocrNothing'))}</h2>
    <ul class="tips"><li>${h(t('ocrTip1'))}</li><li>${h(t('ocrTip2'))}</li><li>${h(t('ocrTip3'))}</li><li>${h(t('ocrTip4'))}</li></ul>
    <label class="big primary" id="photoRetry">${h(t('tryAgainPhoto'))}<input type="file" accept="image/*" capture="environment" hidden class="photo-again"></label>
    <p class="muted small">${h(t('ocrRawRead'))}</p><pre class="ocr">${c.text && c.text.trim() ? h(c.text) : h(t('ocrRawNone'))}</pre></section>`;
}

function renderEczema(ec, es, type = 'food') {
  let out = `<section class="card eczema" id="eczemaPanel"><h2>🩹 ${h(t(type === 'food' ? 'ecHead' : 'ecHeadContact'))}</h2>`;
  if (es) {
    out += `<details class="breakdown" id="ecScoreBreakdown"><summary>${h(t('ecScoreHead'))}: ${es.score}/100</summary>
      <table>${es.items.map((it) => `<tr><td>${h(L(it.name))} <span class="tag sev-${it.sev}">${h(t('sev_' + it.sev))}</span>${it.traces ? ` <span class="traces">${h(t('ecTraces'))}</span>` : ''}</td><td>−${fmtN(it.penalty)}</td></tr>`).join('')}
      <tr><td><b>${h(t('ecScoreTotal'))}</b></td><td><b>${Math.max(0, Math.round(100 - es.total))}</b></td></tr>
      ${es.capped ? `<tr><td colspan="2" class="r-bad">${h(t('ecScoreCap'))}</td></tr>` : ''}</table>
      <p class="muted small">${h(t('ecScoreRule'))}</p></details>`;
  }
  if (ec.status === 'unknown') out += `<p class="ec-msg unknown">${h(t('ecUnknown'))}</p>`;
  else if (ec.status === 'none') out += `<p class="ec-msg ok">✓ ${h(t('ecNone'))}</p>`;
  else {
    out += `<div class="ec-overall sev-${ec.overall}">${h(t('ecOverall'))}: <b>${h(t('sev_' + ec.overall))}</b> · ${ec.count} ${h(t('ecTriggers'))}</div>`;
    if (ec.status === 'found_partial') out += `<p class="ec-msg unknown">${h(t('ecPartial'))}</p>`;
    out += `<ul class="chips">${ec.triggers.map((tr) => `<li class="chip sev-${tr.sev}"><div class="chip-top"><b>${h(L(tr.name))}</b>
      <span class="sev">${h(t('sev_' + tr.sev))}</span>${tr.traces ? `<span class="traces">${h(t('ecTraces'))}</span>` : ''}</div>
      <div class="chip-why">${h(L(tr.why))}</div></li>`).join('')}</ul>`;
  }
  out += `<p class="ec-foot">${h(t('ecFoot'))}</p></section>`;
  return out;
}

function renderIngredients(list, product) {
  let out = `<section class="card ingredients" id="ingPanel"><div class="sec-head"><h2>${h(t('ingHead'))}</h2>`;
  if (list.length) out += `<button type="button" class="link" id="sortBtn">${h(sortWorst ? t('ingSortLabel') : t('ingSortWorst'))}</button>`;
  out += `</div>`;
  if (!list.length) return out + `<p class="muted">${h(t('ingNone'))}</p></section>`;
  const rows = sortWorst ? E.sortWorstFirst(list) : list;
  const showEn = product && product.lang && product.lang !== 'en';
  out += `<ul class="ing-list">${rows.map((i) => {
    const en = showEn && /^en:/.test(i.id) ? i.id.slice(3).replace(/-/g, ' ') : '';
    return `<li class="ing" style="--d:${sortWorst ? 0 : i.depth}">
      <span class="dot r-${i.health.rating}"></span>
      <div class="ing-main"><div class="ing-name">${h(i.text)}${en && en.toLowerCase() !== i.text.toLowerCase() ? ` <span class="muted small">(${h(en)})</span>` : ''}</div>
        <div class="ing-why">${h(L(i.health.why))}</div></div>
      <div class="ing-tags"><span class="tag r-${i.health.rating}">${h(t('r_' + i.health.rating))}</span>
        ${i.eczema.sev !== 'none' ? `<span class="tag sev-${i.eczema.sev}" title="${h(t('ingEczema'))}">${h(t('ingEczema'))}: ${h(t('sev_' + i.eczema.sev))}</span>` : `<span class="tag ec-none">${h(t('ingEczema'))}: ${h(t('sev_none'))}</span>`}</div>
    </li>`;
  }).join('')}</ul></section>`;
  return out;
}

function renderAdditives(ad) {
  let out = `<section class="card additives"><h2>${h(t('addHead'))}</h2>`;
  if (ad.points == null) return out + `<p class="muted">${h(t('unknown'))}</p></section>`;
  if (!ad.list.length) return out + `<p class="ec-msg ok">✓ ${h(t('addNone'))}</p></section>`;
  out += `<ul class="add-list">${ad.list.map((x) => `<li><span class="dot risk-${x.risk}"></span><div><b>${h(L(x.label))}</b>${x.code ? ` <span class="muted">${h(x.code)}</span>` : ''}
    <span class="tag risk-${x.risk}">${h(t('risk_' + x.risk))}</span><div class="ing-why">${h(L(x.why))}</div></div></li>`).join('')}</ul></section>`;
  return out;
}

const fmtN = (v, d = 1) => (v == null ? null : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US'));
function renderNutrients(a) {
  const n = a.nutrients || {};
  const bev = a.category === 'beverage' || a.category === 'water';
  const der = n.derived || [];
  const row = (k, v, unit, d = 1) => `<tr><td>${h(t('n_' + k))}</td><td>${v == null ? `<span class="muted">${h(t('notListed'))}</span>` : `${fmtN(v, d)} ${unit}`}${der.includes(k) ? ` <span class="muted small">${h(t('n_derived'))}</span>` : ''}</td></tr>`;
  return `<section class="card nutrients"><h2>${h(t(bev ? 'nutHeadBev' : 'nutHead'))}</h2><table>
    ${row('energy', n.energy_kj == null ? null : n.energy_kj / 4.184, 'kcal', 0)}
    ${row('fat', n.fat, 'g')}${row('satfat', n.satfat, 'g')}${row('sugars', n.sugars, 'g')}${row('salt', n.salt, 'g', 2)}
    ${row('fiber', n.fiber, 'g')}${row('protein', n.protein, 'g')}${row('fvl', n.fvl, '%', 0)}</table></section>`;
}

function renderPhotoRead(p) {
  const f = p.facts;
  const per = p.per100 || {};
  const r = (label, sv, unit, v100) => `<tr><td>${h(label)}</td><td>${sv == null ? `<span class="muted">—</span>` : `${h(sv)} ${unit}`}</td><td>${v100 == null ? '' : `${fmtN(v100)} ${unit === 'mg' ? 'g' : unit}`}</td></tr>`;
  const facts = p.outcome === 'ingredients_only' ? '' : `<table><tr><th></th><th>${h(t('perServing'))}</th><th>${h(t('per100'))}</th></tr>
    ${r(t('serving'), f.serving, f.servingUnit || 'g', null)}
    ${r(t('n_energy'), f.kcal, 'kcal', per.energy_kj == null ? null : per.energy_kj / 4.184)}
    ${r(t('n_fat'), f.fat, 'g', per.fat)}${r(t('n_satfat'), f.satfat, 'g', per.satfat)}
    ${r(t('n_sugars'), f.sugars, 'g', per.sugars)}
    <tr><td>${h(t('n_salt'))} (sodium)</td><td>${f.sodium_mg == null ? '<span class="muted">—</span>' : `${h(f.sodium_mg)} mg`}</td><td>${per.salt == null ? '' : `${fmtN(per.salt, 2)} g`}</td></tr>
    ${r(t('n_fiber'), f.fiber, 'g', per.fiber)}${r(t('n_protein'), f.protein, 'g', per.protein)}</table>`;
  return `<section class="card photo-read" id="photoRead"><h2>${h(t('whatRead'))}</h2>${facts}
    ${p.rotation ? `<p class="muted small">${h(t('photoTurned', { deg: p.rotation }))}</p>` : ''}
    ${p.analysis.ingredients.length ? `<p class="muted small">${p.analysis.ingredients.length} ${h(t('ingRead'))}</p>` : ''}
    ${f.repairs && f.repairs.length ? `<p class="muted small">${h(t('ocrRepairs'))}: ${f.repairs.map(h).join(' · ')}</p>` : ''}
    ${f.dvMismatch && f.dvMismatch.length ? `<div class="banner warn">${h(t('dvMismatch'))}: ${f.dvMismatch.map((k) => h(t('n_' + (k === 'sodium_mg' ? 'salt' : k === 'addedSugars' ? 'sugars' : k)))).join(', ')}</div>` : ''}
    ${p.label.contains ? `<p><b>CONTAINS:</b> ${h(p.label.contains)}</p>` : ''}${p.label.mayContain ? `<p><b>MAY CONTAIN:</b> ${h(p.label.mayContain)}</p>` : ''}
    <details><summary>${h(t('ocrText'))}</summary><pre class="ocr">${h(p.text)}</pre></details></section>`;
}

// ------------------------------------------------------------------ photo of label (on-device OCR, lazy-loaded)
// Pipeline: decode with EXIF orientation -> look for a barcode in the photo -> find which way up the text
// is (small 1000px reads at 0/90/270/180, stop at the first good one) -> read the winner at 2000px.
// The rules (sizes, order, the quality score) live in engine.js (E.OCR_PLAN, E.ocrReadScore).
let ocrWorker = null;
const ocrProgress = { cb: null };
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); });
}
// Decode the photo the right way up. createImageBitmap honours EXIF with imageOrientation:'from-image';
// where that option is missing, an <img> decode does (every current browser applies EXIF to <img>).
async function loadPhoto(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  return img;
}
// Draw `src` turned clockwise by `deg` (0/90/180/270), long side at most `maxLong` px.
function drawRotated(src, deg, maxLong) {
  const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
  const k = Math.min(1, maxLong / Math.max(W, H));
  const sw = Math.round(W * k), sh = Math.round(H * k);
  const cv = document.createElement('canvas');
  cv.width = deg % 180 ? sh : sw; cv.height = deg % 180 ? sw : sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
  return cv;
}
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) await loadScript('./vendor/tesseract/tesseract.min.js');
  ocrWorker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: abs('./vendor/tesseract/worker.min.js'), corePath: abs('./vendor/tesseract/core/'),
    langPath: abs('./vendor/tesseract/lang'), gzip: true, cacheMethod: 'write',
    logger: (m) => { if (ocrProgress.cb && m.status === 'recognizing text') ocrProgress.cb(Math.round((m.progress || 0) * 100)); },
  });
  return ocrWorker;
}
async function ocrAt(worker, src, deg, px, onPct) {
  const cv = drawRotated(src, deg, px);
  ocrProgress.cb = onPct || null;
  try {
    const { data } = await worker.recognize(cv);
    return { deg, px, text: data.text || '', ...E.ocrReadScore(data.text, data.confidence) };
  } finally { ocrProgress.cb = null; }
}
// Find which way up the label is, then read it properly. Returns the best read + timings.
async function readLabel(src, onStep) {
  const plan = E.OCR_PLAN;
  const timings = {};
  let t0 = performance.now();
  onStep('ocrLoading', '');
  const w = await getOcr();
  timings.loadMs = Math.round(performance.now() - t0);
  let best = null;
  const probes = [];
  t0 = performance.now();
  for (let i = 0; i < plan.order.length; i++) {
    const deg = plan.order[i];
    onStep('photoTurning', `${i + 1}/${plan.order.length}`);
    const r = await ocrAt(w, src, deg, plan.probePx);
    probes.push({ deg, score: r.score, conf: r.conf, dictWords: r.dictWords, keyword: r.keyword });
    if (!best || r.score > best.score) best = r;
    if (r.score >= plan.goodEnough) break;
  }
  timings.orientMs = Math.round(performance.now() - t0);
  t0 = performance.now();
  const full = await ocrAt(w, src, best.deg, plan.readPx, (pct) => onStep('ocrReading', `${pct}%`));
  timings.readMs = Math.round(performance.now() - t0);
  const pick = full.score >= best.score ? full : best;   // a small read can beat the big one; keep the better
  return { text: pick.text, rotation: best.deg, px: pick.px, quality: { score: pick.score, conf: pick.conf, dictWords: pick.dictWords }, probes, timings };
}
// Barcode anywhere in the photo (zxing tries 90/180/270 itself with tryRotate; a turned copy is tried too).
async function findBarcodeInPhoto(src) {
  const ZX = await loadZxing();
  for (const deg of [0, 90]) {
    const cv = drawRotated(src, deg, 2000);
    const img = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height);
    const res = await ZX.readBarcodes(img, { formats: ZX_FORMATS, tryHarder: true, tryRotate: true, maxNumberOfSymbols: 4 });
    const hit = res.find((r) => r.isValid && validScan(r.text, r.format));
    if (hit) return { text: hit.text, format: hit.format };
  }
  return null;
}
let photoRun = 0;
async function onPhoto(file) {
  const run = ++photoRun;
  const T = { start: performance.now() };
  const step = (key, s = '') => { if (run === photoRun && !$('busy').hidden) busy(true, key, s); };
  busy(true, 'photoOpening');
  let src;
  try { src = await loadPhoto(file); } catch (err) {
    console.warn('photo decode', err); busy(false);
    showPhotoResult('', { error: 'decode' });
    return;
  }
  T.decodeMs = Math.round(performance.now() - T.start);
  // 1) a barcode in the photo -> database lookup (more reliable than reading the text)
  step('photoBarcode');
  let bc = null;
  let t0 = performance.now();
  try { bc = await findBarcodeInPhoto(src); } catch (err) { console.warn('photo barcode', err); }
  T.barcodeMs = Math.round(performance.now() - t0);
  window.__photoBarcode = bc;
  let res = null;
  if (bc) { step('looking'); res = await lookup(bc.text, bc.format); }
  if (res && res.state === 'found') {
    // show the database result now; keep reading the label text in the background and offer it when done
    const analysis = E.analyze(E.inputFromOff(res.product, res.db));
    const fp = { state: 'reading', pct: 0, read: null };
    current = { kind: 'off', product: res.product, code: res.code, db: res.db, analysis, cached: res.cached, fromPhoto: fp };
    histAdd(histEntry(analysis, { code: res.code, name: productName(res.product) }));
    window.__lastResult = current;
    busy(false);
    renderCurrent(); navTo('result'); showResultView();
    const mine = current;
    try {
      const read = await readLabel(src, (key, s) => {
        const m = /(\d+)%/.exec(s || '');
        if (m) { fp.pct = Number(m[1]); const el = $('photoPct'); if (el) el.textContent = `${fp.pct}%`; }
      });
      const parsed = E.inputFromOcr(read.text);
      fp.read = { text: read.text, outcome: parsed.outcome, meta: { rotation: read.rotation, barcode: bc.text, barcodeState: 'found' } };
      fp.state = 'done';
      window.__photoTimings = { ...T, ...read.timings, totalMs: Math.round(performance.now() - T.start), probes: read.probes, rotation: read.rotation, quality: read.quality };
    } catch (err) { console.warn('OCR failed', err); fp.state = 'failed'; }
    if (current === mine) renderCurrent();
    return;
  }
  // 2) no barcode, or not in the database: read the label text
  try {
    const read = await readLabel(src, step);
    window.__photoTimings = { ...T, ...read.timings, totalMs: Math.round(performance.now() - T.start), probes: read.probes, rotation: read.rotation, quality: read.quality };
    busy(false);
    showPhotoResult(read.text, { rotation: read.rotation, barcode: bc && bc.text, barcodeState: res && res.state });
  } catch (err) {
    console.warn('OCR failed', err);
    busy(false);
    showPhotoResult('', { error: 'ocr', barcode: bc && bc.text, barcodeState: res && res.state });
  }
}
function showPhotoResult(text, meta = {}) {
  const { input, facts, label, per100, outcome } = E.inputFromOcr(text);
  const analysis = E.analyze(input);
  current = { kind: 'photo', text, facts, label, per100, analysis, outcome, rotation: meta.rotation || 0, barcode: meta.barcode || '', barcodeState: meta.barcodeState || '', push: !!meta.push };
  window.__lastResult = current;
  if (outcome !== 'unreadable') {
    histAdd(histEntry(analysis, { code: '', name: `📷 ${label.ingredients.slice(0, 40) || t('photoName')}`, ocr: text.slice(0, 4000) }));
  }
  renderCurrent();
  navTo('result', meta.push);
  showResultView();
}
$('photoInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); };

// ------------------------------------------------------------------ live barcode scanner
const scan = { stream: null, track: null, running: false, torch: false, detector: null, session: 0 };
const ZX_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'];
let zxReady = null;
function loadZxing() {
  if (!zxReady) {
    zxReady = (async () => {
      if (!window.ZXingWASM) await loadScript('./vendor/zxing/zxing-reader.js');
      const ZX = window.ZXingWASM;
      ZX.prepareZXingModule({ overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? abs('./vendor/zxing/' + p) : prefix + p) }, fireImmediately: true });
      return ZX;
    })().catch((err) => { zxReady = null; throw err; });
  }
  return zxReady;
}
async function getDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter((f) => sup.includes(f));
      if (want.includes('ean_13') && want.includes('upc_a')) {
        const det = new window.BarcodeDetector({ formats: want });
        return { name: 'native', detect: async (video) => (await det.detect(video)).map((b) => ({ text: b.rawValue, format: b.format })) };
      }
    } catch { /* fall through to the library */ }
  }
  const ZX = await loadZxing();
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  return {
    name: 'zxing-wasm',
    detect: async (video) => {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return [];
      // centre band of the frame (where the box is), max 1280 wide
      const sw = vw, sh = Math.round(vh * 0.6), sy = Math.round((vh - sh) / 2);
      const k = Math.min(1, 1280 / sw);
      cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
      ctx.drawImage(video, 0, sy, sw, sh, 0, 0, cv.width, cv.height);
      const res = await ZX.readBarcodes(ctx.getImageData(0, 0, cv.width, cv.height), { formats: ZX_FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
      return res.filter((r) => r.isValid).map((r) => ({ text: r.text, format: r.format }));
    },
  };
}
function validScan(text, format) {
  const code = String(text || '').replace(/\D/g, '');
  const f = String(format).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (f === 'upce' && code.length === 8) return !!E.expandUpcE(code) || E.checkDigitOk(code);
  return [8, 12, 13].includes(code.length) && E.checkDigitOk(code);
}
async function startScanner() {
  if (!window.isSecureContext || !navigator.mediaDevices) { alert(t('camHttps')); return; }
  const session = ++scan.session;           // Back pressed while the camera is still starting -> this start is stale
  const stale = () => session !== scan.session || $('scanner').hidden;
  $('scanner').hidden = false; $('scanEngine').textContent = t('camStarting');
  navTo('camera');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (err) {
    console.warn('camera', err);
    if (!stale()) { closeCamera(); alert(t('camError')); }
    return;
  }
  if (stale()) { stream.getTracks().forEach((tr) => tr.stop()); return; }
  scan.stream = stream; window.__lastStream = stream;
  const video = $('video');
  video.srcObject = scan.stream;
  try { await video.play(); } catch { /* autoplay attrs cover iOS */ }
  scan.track = scan.stream.getVideoTracks()[0];
  const caps = scan.track.getCapabilities ? scan.track.getCapabilities() : {};
  $('torchBtn').hidden = !caps.torch;
  if (caps.focusMode && caps.focusMode.includes('continuous')) scan.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  try { scan.detector = await getDetector(); } catch (err) { console.warn('detector', err); if (!stale()) { closeCamera(); alert(t('camError')); } return; }
  if (stale()) return;
  $('scanEngine').textContent = scan.detector.name;
  window.__scanEngine = scan.detector.name;
  scan.running = true;
  loop();
}
async function loop() {
  if (!scan.running) return;
  const video = $('video');
  try {
    if (video.readyState >= 2) {
      const found = await scan.detector.detect(video);
      const hit = found.find((b) => validScan(b.text, b.format));
      if (hit && scan.running) {
        stopScanner();
        if (navigator.vibrate) navigator.vibrate(120);
        window.__lastScan = hit;
        openBarcode(hit.text, hit.format);
        return;
      }
    }
  } catch (err) { console.warn('scan frame', err); }
  setTimeout(loop, 120);
}
function stopScanner() {
  scan.session++;
  scan.running = false;
  if (scan.stream) scan.stream.getTracks().forEach((tr) => tr.stop());
  scan.stream = null; scan.track = null; scan.torch = false;
  $('video').srcObject = null;
  $('scanner').hidden = true;
}
// close the camera the same way the phone's Back button does (stops every camera track, back to home)
function closeCamera() {
  if (navState() === 'camera') history.back();   // popstate stops the scanner
  else stopScanner();
}
$('scanBtn').onclick = startScanner;
$('scanNext').onclick = () => { showHome(); startScanner(); };
$('closeScan').onclick = closeCamera;
$('scanBack').onclick = closeCamera;
$('torchBtn').onclick = async () => {
  if (!scan.track) return;
  scan.torch = !scan.torch;
  try { await scan.track.applyConstraints({ advanced: [{ torch: scan.torch }] }); } catch { scan.torch = false; }
  $('torchBtn').classList.toggle('on', scan.torch);
};

// ------------------------------------------------------------------ install (Android prompt / iPhone tip) + updates
let deferredPrompt = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredPrompt = e;
  $('installBox').hidden = false; $('installBtn').hidden = false;
});
$('installBtn').onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => null);
  deferredPrompt = null; $('installBtn').hidden = true; $('installBox').hidden = true;
};
window.addEventListener('appinstalled', () => { $('installBox').hidden = true; });
if (isIOS() && !standalone()) { $('installBox').hidden = false; $('iosTip').hidden = false; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
    window.__swReg = reg;
    const offer = (w) => { $('updateBar').hidden = false; $('updateBtn').onclick = () => w.postMessage('SKIP_WAITING'); };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((err) => console.warn('service worker', err));
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && $('updateBar').hidden === false) { reloaded = true; location.reload(); } });
}

applyLang();
