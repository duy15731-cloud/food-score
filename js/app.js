// Food Score — page logic (camera, lookups, rendering). All scoring lives in engine.js.
import * as E from './engine.js';
import { STR } from './i18n.js';
import { initTracker } from './tracker.js';
import { CONFIG } from './config.js';
import { mountLivePrices, PRICE_STRINGS, getSavedZip, saveZip, cleanZip } from './prices.js';

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
  if (!$('allergies').hidden) renderAllergies();
  if (!$('settings').hidden) renderSettings();
  TR.onRender();
  renderAlgHome();
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
// every full-page screen is a <main class="view">. SCREENS maps a history-state name to the function that shows it.
const VIEWS = () => [...document.querySelectorAll('main.view')];
function showOnly(id) {
  VIEWS().forEach((m) => { m.hidden = m.id !== id; });
  $('scanNext').hidden = id !== 'result';
  window.scrollTo(0, 0);
}
const SCREENS = {};
window.addEventListener('popstate', () => {
  const s = navState();
  if (!$('scanner').hidden && s !== 'camera') stopScanner();
  if (!s) showHome();
  else if (s === 'result' && current) showResultView();
  else if (SCREENS[s]) SCREENS[s]();
});
function showHome() {
  current = null;
  showOnly('home');
  renderHistory();
}
function showResultView() {
  if ($('result').hidden && current) renderCurrent();   // the allergy profile / units may have changed on another screen
  showOnly('result');
}
// busy overlay: text is kept as a string KEY so a language switch mid-way re-translates it
const busyNow = { key: '', step: '' };
function busyRender() { $('busyText').textContent = busyNow.key ? t(busyNow.key) : ''; $('busyStep').textContent = busyNow.step || ''; }
function busy(on, key = '', step = '') { busyNow.key = key; busyNow.step = step; $('busy').hidden = !on; busyRender(); }

// ------------------------------------------------------------------ product cache (raw OFF JSON = inputs; failures never cached)
const CACHE_PREFIX = 'fs_p_';
const CACHE_DAYS = 30;
const cacheKey = (code, db = 'food') => CACHE_PREFIX + (db === 'food' ? '' : db + '_') + code;   // food keys unchanged from v1.0
function cacheGet(code, db = 'food', anyAge = false) {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(code, db)) || 'null');
    if (v && (anyAge || Date.now() - v.t < CACHE_DAYS * 864e5)) return v.p;
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

// The lookup chain lives in engine.js (E.lookupProduct): ONE combined Open*Facts call (?product_type=all), the old
// per-site chain only when that call gets no answer, then the FDA drug label for OTC personal care. The page only
// supplies the network and the cache. Same three states: found / notfound / failed.
const CACHE_DBS = [...E.DATABASES.map((d) => d.id), E.FDA_SOURCE.id];
const fetchJson = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json().catch(() => null), url: r.url || url }; };
async function lookup(code, format = '') {
  const cands = E.lookupCandidates(code, format);
  for (const db of CACHE_DBS) for (const c of cands) { const p = cacheGet(c, db); if (p) return { state: 'found', product: p, code: c, db, cached: true, tried: cands }; }
  const r = await E.lookupProduct(code, { fetchJson, format });
  window.__lastLookup = { state: r.state, db: r.db, via: r.via, fda: r.fda };
  if (r.state === 'found') cachePut(r.code, r.product, r.db);
  return { ...r, code: r.code || code };
}

// ------------------------------------------------------------------ product pictures: database by barcode, else the extra source
// The Open*Facts picture comes with the product. When there is none (or the code is in no database), ask the extra
// sources from engine.js (our Cloudflare Worker, CONFIG.WORKER_URL) — a no-op until that URL is set.
const workerMemo = new Map();
function workerProduct(code) {
  const url = E.workerProductUrl(CONFIG.WORKER_URL, code);
  if (!url) return Promise.resolve(null);
  if (!workerMemo.has(url)) {
    workerMemo.set(url, (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      try { const r = await fetch(url, { signal: ctrl.signal, credentials: 'omit' }); const b = await r.json().catch(() => null); return r.ok ? b : null; }
      catch { workerMemo.delete(url); return null; }   // network trouble: may ask again later
      finally { clearTimeout(timer); }
    })());
  }
  return workerMemo.get(url);
}
async function productImageFallback(code) { return E.pickWorkerImage(await workerProduct(code)); }
// After the result is on screen: fill the gaps the databases left (ingredients / picture / name) from the worker,
// or turn "not found" into a product. Never blocks the result; any failure or the daily limit = nothing changes.
async function enhanceFromWorker(res, push) {
  if (!CONFIG.WORKER_URL || !E.needsWorker(res)) return;
  const code = res.code;
  const w = await workerProduct(code);
  const m = E.mergeWorkerProduct(res, w, code);
  window.__lastWorker = { code, asked: true, used: m ? m.worker : [], answer: w ? { title: w.title || null, manufacturer: !!(w.manufacturer && w.manufacturer.found), skipped: w.skipped || null } : null };
  if (!m) return;
  cachePut(m.code, m.product, m.db);
  const analysis = E.analyze(E.inputFromOff(m.product, m.db));
  histAdd(histEntry(analysis, { code: m.code, name: productName(m.product), brand: m.product.brands || '', img: E.productThumb(m.product) }));
  if (current && (current.code === code || current.code === m.code) && (current.kind === 'off' || current.kind === 'notfound')) {
    current = { kind: 'off', product: m.product, code: m.code, db: m.db, analysis, push: current.push, fromPhoto: current.fromPhoto, buzzed: current.buzzed };
    window.__lastResult = current;
    if (!$('result').hidden) renderCurrent();
  }
}
// live prices: one request per product + ZIP per session, however often the result is re-drawn
const priceMemo = new Map();
const memoFetch = (url, opts) => {
  if (!priceMemo.has(url)) {
    priceMemo.set(url, fetch(url, opts).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }))
      .catch((e) => { priceMemo.delete(url); throw e; }));
  }
  return priceMemo.get(url).then((x) => ({ ok: x.ok, status: x.status, json: async () => x.body }));
};
const livePricesSlot = (upc, name, brand) => (CONFIG.WORKER_URL && upc ? `<div class="live-prices" id="livePrices" data-upc="${h(upc)}" data-name="${h(name || '')}" data-brand="${h(String(brand || '').split(',')[0])}"></div>` : '');
function mountPrices() {
  const el = $('livePrices');
  if (!el) return;
  mountLivePrices(el, { upc: el.dataset.upc, name: el.dataset.name, brand: el.dataset.brand }, { workerUrl: CONFIG.WORKER_URL, strings: PRICE_STRINGS[lang] || PRICE_STRINGS.en, lang, fetchImpl: memoFetch });
}
// where the ingredient list / name / picture came from, when not from Open*Facts
function sourceNotes(product) {
  if (!product) return '';
  let out = '';
  if (product.ingredients_source === 'fda') out += `<div class="banner info src-note" id="fdaSource">${h(t('fdaSource'))}</div>`;
  if (product.ingredients_source === 'manufacturer') out += `<div class="banner info src-note" id="srcMaker">${h(t('srcMaker', { who: product.ingredients_source_name || 'SmartLabel' }))}</div>`;
  if (product.ingredients_source === 'upcitemdb') out += `<div class="banner info src-note" id="srcUpc">${h(t('srcUpcIngr'))}</div>`;
  if (product.name_source === 'upcitemdb' || product.image_source === 'upcitemdb') out += `<div class="banner info src-note" id="srcUpcName">${h(t('srcUpcName'))}</div>`;
  return out;
}
const imgAsked = new Set();
async function fillImage(code) {
  if (!code || imgAsked.has(code)) return;
  imgAsked.add(code);
  const img = await productImageFallback(code);
  if (!img) { imgAsked.delete(code); return; }   // nothing (or a failure): ask again next time
  const list = histGet();
  let changed = false;
  for (const x of list) if ((x.code === code || x.bcode === code) && !x.img) { x.img = img; changed = true; }
  if (changed) histWrite(list);
  if (current && (current.code === code || current.barcode === code) && !current.fallbackImg) { current.fallbackImg = img; if (!$('result').hidden) renderCurrent(); }
  if (!$('home').hidden) renderHistory();
  if (!$('ranking').hidden) renderRankList();
}

// ------------------------------------------------------------------ history = "My products" (last 200)
const HIST_MAX = 200;
function histGet() { try { return JSON.parse(localStorage.getItem('fs_hist') || '[]'); } catch { return []; } }
function histAdd(item) {
  let list = histGet().filter((x) => !(item.code && x.code === item.code) && !(item.ocr && x.ocr === item.ocr));
  list.unshift({ ...item, t: Date.now() });
  histWrite(list.slice(0, HIST_MAX));
}
function histWrite(list) {
  list = list.map(({ thumb, ...x }) => x);   // the user's own label photos are never kept or shown (pictures come from the database)
  for (let i = 0; i < 4; i++) {
    try { localStorage.setItem('fs_hist', JSON.stringify(list)); return; } catch {
      // storage full: shorten the label-photo text of the oldest half (the scores stay), then retry
      list = list.map((x, j) => (j > list.length / 2 && x.ocr ? { ...x, ocr: x.ocr.slice(0, 1500) } : x));
      if (i === 2) list = list.slice(0, Math.ceil(list.length / 2));
    }
  }
}
// bf: 1 = saved by the current entry format (picture, brand, cancer score) — the backfill below skips it
const histEntry = (a, extra) => ({ score: a.score, ecs: a.eczemaScore ? a.eczemaScore.score : null, cr: a.cancer ? a.cancer.score : null, type: a.type || 'food', ecz: a.eczema.overall,
  alg: a.allergens ? E.allergenSummary(a.allergens) : null, bf: 1, ...extra });
// One-time backfill of entries saved before v1.6 (no picture / brand / cancer score): re-load the product
// (local product cache first, else the normal lookup chain), re-score it with the current engine, and update
// the entry IN PLACE (same date, same position). At most 2 lookups at a time. A failed lookup is skipped and
// NOT marked done, so it is tried again the next time the app opens; photo-only entries are never touched.
const bfState = { running: false, tried: new Set(), done: 0, failed: 0 };
window.__backfill = bfState;
const needsBackfill = (x) => x && x.code && !x.ocr && !x.bf && (!x.img || !('cr' in x) || !x.brand);
function backfillHistory() {
  if (bfState.running) return;
  const queue = histGet().filter((x) => needsBackfill(x) && !bfState.tried.has(x.code)).map((x) => x.code);
  if (!queue.length) return;
  bfState.running = true;
  const worker = async () => {
    while (queue.length) {
      const code = queue.shift();
      bfState.tried.add(code);
      let res = null;
      try { res = await lookup(code); } catch { res = null; }
      if (!res || res.state === 'failed') { bfState.failed++; continue; }   // retried next app open
      const list = histGet();
      const i = list.findIndex((x) => x.code === code && !x.ocr);
      if (i < 0) continue;
      if (res.state === 'found') {
        const a = E.analyze(E.inputFromOff(res.product, res.db));
        list[i] = { ...list[i], ...histEntry(a, { code: list[i].code, name: productName(res.product) || list[i].name, brand: res.product.brands || '', img: E.productThumb(res.product) }), t: list[i].t };
      } else list[i] = { ...list[i], bf: 1 };   // the databases answered "no such product": nothing to fill, stop asking
      if (!list[i].img) fillImage(code);         // no database picture: the extra source (off until configured)
      histWrite(list);
      bfState.done++;
      if (!$('home').hidden) renderHistory();
      if (!$('ranking').hidden) renderRankList();
      await new Promise((r) => setTimeout(r, 250));   // gentle on Open Food Facts
    }
  };
  Promise.all([worker(), worker()]).finally(() => { bfState.running = false; });
}
// ⚠️ chip in a list row: red = one of MY allergens is in it, amber = may contain / can't confirm
function algChip(x) {
  const prof = algGet();
  if (!prof.length || !x.alg) return '';
  if (x.alg.c.some((id) => prof.includes(id))) return `<span class="alg-chip red" title="${h(t('algRed'))}">⚠️</span>`;
  if (x.alg.t.some((id) => prof.includes(id)) || x.alg.u) return `<span class="alg-chip amber" title="${h(t('algAmber'))}">⚠</span>`;
  return '';
}
const TYPE_ICON = { food: '🍎', cosmetic: '🧴', household: '🧽' };
// list-row picture: product photo (lazy) or the photo the user took; a broken / missing picture falls back to the emoji
const rowThumb = (x) => {
  const src = x.img;   // database picture only (never the user's own photo); none -> category emoji
  return `<span class="hist-thumb" data-emoji="${TYPE_ICON[x.type || 'food']}">${src ? `<img src="${h(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : TYPE_ICON[x.type || 'food']}</span>`;
};
function wireThumbs(root) {
  root.querySelectorAll('.hist-thumb img').forEach((img) => {
    const fail = () => { const sp = img.parentElement; if (sp) sp.textContent = sp.dataset.emoji; };
    if (img.complete && img.naturalWidth === 0 && img.src) fail(); else img.onerror = fail;
  });
}
const mini = (v, title) => `<span class="mini" title="${h(title)}" style="background:${v == null ? '#9aa0a6' : E.bandFor(v).color}">${v == null ? '<span class="mini-n">?</span>' : `<span class="mini-n">${v}</span><span class="mini-of">/100</span>`}</span>`;
function histRow(x, i) {
  return `<li><button type="button" class="hist-item" data-i="${i}">
    ${rowThumb(x)}
    <span class="hist-text"><span class="hist-name">${h(x.name || x.code)}</span>${x.brand ? `<span class="hist-brand">${h(String(x.brand).split(',').slice(0, 2).join(', '))}</span>` : ''}</span>${algChip(x)}
    <span class="mini-pair"><span class="mini-lab">${h(t((x.type || 'food') === 'food' ? 'scoreHealthShort' : 'scoreHarmShort'))}</span>${mini(x.score, t('scoreHealth'))}
    <span class="mini-lab">${h(t('scoreEczemaShort'))}</span>${mini(x.ecs, t('scoreEczema'))}
    <span class="mini-lab">${h(t('scoreCancerShort'))}</span>${mini(x.cr === undefined ? null : x.cr, t('scoreCancer'))}</span>
  </button></li>`;
}
function openHist(x, push) { if (x.ocr) showPhotoResult(x.ocr, { push, type: x.type, barcode: x.bcode || '' }); else openBarcode(x.code, '', { push }); }
function renderHistory() {
  const list = histGet();
  $('histList').innerHTML = list.length ? list.slice(0, 8).map(histRow).join('') : `<li class="empty">${h(t('noHistory'))}</li>`;
  $('histList').querySelectorAll('.hist-item').forEach((b) => { b.onclick = () => openHist(histGet()[Number(b.dataset.i)]); });
  wireThumbs($('histList'));
  $('rankBtn').hidden = !list.length;
  TR.renderHomeBar();
  backfillHistory();
}
$('clearHist').onclick = () => { localStorage.removeItem('fs_hist'); renderHistory(); };

// ------------------------------------------------------------------ "My products": every scanned product, ranked
const rk = { q: '', filter: 'all', sort: 'score', dir: 'best' };
function showRanking() {
  current = null;
  showOnly('ranking');
  renderRanking();
}
SCREENS.ranking = showRanking;
const seg = (group, opts, active) => `<div class="seg" role="group" data-group="${group}">${opts.map(([v, k]) => `<button type="button" class="seg-opt${v === active ? ' active' : ''}" data-v="${v}" aria-pressed="${v === active}">${h(t(k))}</button>`).join('')}</div>`;
function renderRanking() {
  $('ranking').innerHTML = `<button type="button" class="link back" id="rkBack">${h(t('back'))}</button>
    <h2 class="rk-title">📊 ${h(t('myProducts'))}</h2>
    <input id="rkSearch" class="rk-search" type="search" autocomplete="off" placeholder="${h(t('rkSearchPh'))}" value="${h(rk.q)}">
    ${seg('filter', [['all', 'rkAll'], ['food', 'rkFood'], ['nonfood', 'rkNonFood']], rk.filter)}
    ${seg('sort', [['score', 'rkSortScore'], ['eczema', 'rkSortEczema'], ['cancer', 'rkSortCancer']], rk.sort)}
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
  const key = rk.sort === 'eczema' ? 'ecs' : rk.sort === 'cancer' ? 'cr' : 'score';
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
  wireThumbs($('rkList'));
  backfillHistory();
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
    histAdd(histEntry(analysis, { code: res.code, name: productName(res.product), brand: res.product.brands || '', img: E.productThumb(res.product) }));
  } else {
    current = { kind: res.state, code, tried: res.tried, format, dbStates: res.dbStates };
  }
  current.push = !!opts.push;
  window.__lastResult = current;   // for automated checks
  renderCurrent();
  enhanceFromWorker(res);
  navTo('result', opts.push);
  showResultView();
}
$('typeForm').onsubmit = (e) => { e.preventDefault(); const v = $('codeInput').value; $('codeInput').blur(); openBarcode(v); };
const productName = (p) => p.product_name_vi && lang === 'vi' ? p.product_name_vi : (p.product_name || p.product_name_en || p.product_name_vi || '');

// ------------------------------------------------------------------ rendering
function renderCurrent() {
  const c = current;
  const hasA = (c.kind === 'off' || (c.kind === 'photo' && c.outcome !== 'unreadable')) && c.analysis;
  const back = `<div class="res-top"><button type="button" class="link back" id="backBtn">${h(t(c.push ? 'camBack' : 'back'))}</button>
    <button type="button" class="link gear" id="algGear">${h(t('algGear'))}</button></div>` + (hasA ? allergyBanner(c.analysis) : '');
  let html = '';
  if (c.kind === 'off') html = back + (c.fromPhoto ? renderPhotoBg(c.fromPhoto) : '') + renderAnalysis(c.analysis, { product: c.product, code: c.code, db: c.db });
  else if (c.kind === 'photo' && c.outcome === 'unreadable') html = back + renderUnreadable(c);
  else if (c.kind === 'photo') html = back + renderAnalysis(c.analysis, { photo: c });
  else if (c.kind === 'notfound') {
    html = back + `<section class="card msg" id="notFoundCard">${c.fallbackImg ? `<img src="${h(c.fallbackImg)}" alt="" class="prod-img" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<h2>${h(t('notFound'))}</h2><p>${h(t('notFoundHelp'))}</p>
      ${photoActions()}${renderPrices({ code: c.code }, true)}${livePricesSlot(c.code)}
      <p class="muted small">${h(t('barcode'))}: ${h(c.code)} · ${h(t('tried'))}: ${h(c.tried.join(', '))}</p></section>`;
  } else if (c.kind === 'failed') {
    html = back + `<section class="card msg warn"><h2>${h(t('failed'))}</h2>
      <p class="muted">${h(t('barcode'))}: ${h(c.code)}</p><button type="button" class="big primary" id="retryBtn">${h(t('retry'))}</button></section>`;
  }
  $('result').innerHTML = html;
  TR.wireAte();
  mountPrices();
  $('backBtn').onclick = goHome;
  $('algGear').onclick = openAllergies;
  const ab = $('algBannerEdit'); if (ab) ab.onclick = openAllergies;
  // buzz once when one of MY allergens is in a newly shown product
  if (hasA && !c.buzzed && E.allergyReport(c.analysis.allergens, algGet()).status === 'red') { c.buzzed = true; if (navigator.vibrate) navigator.vibrate([250, 120, 250]); window.__algBuzz = (window.__algBuzz || 0) + 1; }
  const see = $('seePhotoRead'); if (see) see.onclick = () => showPhotoResult(c.fromPhoto.read.text, c.fromPhoto.read.meta);
  const rb = $('retryBtn'); if (rb) rb.onclick = () => openBarcode(c.code, c.format);
  $('result').querySelectorAll('.photo-again').forEach((inp) => { inp.onchange = () => inp.files[0] && onPhoto(inp.files[0]); });
  $('result').querySelectorAll('.open-photo-cam').forEach((b) => { b.onclick = () => startScanner({ photo: true, push: true }); });
  const sb = $('sortBtn'); if (sb) sb.onclick = () => { sortWorst = !sortWorst; renderCurrent(); };
}

// "take a photo" from a result screen: the IN-APP camera (photo mode, no barcode auto-scan) + a gallery picker.
// Never <input capture>: on Android that hands over to the phone's camera app and the photo often never comes back.
const photoActions = (id = '', key = 'photoIngredients') => `<button type="button" class="big primary open-photo-cam"${id ? ` id="${id}"` : ''}>📷 ${h(t(key))}</button>
  <label class="gallery-link">🖼 ${h(t('gallery'))}<input type="file" accept="image/*" hidden class="photo-again"></label>`;
// ------------------------------------------------------------------ MY ALLERGIES (profile on this phone only)
const ALG_KEY = 'fs_allergies';
function algGet() { try { const v = JSON.parse(localStorage.getItem(ALG_KEY) || '[]'); return Array.isArray(v) ? v.filter((id) => E.ALLERGEN_BY_ID[id]) : []; } catch { return []; } }
function algSet(ids) { localStorage.setItem(ALG_KEY, JSON.stringify([...new Set(ids)])); }
// header badge "⚠️ 2" (hidden when no allergies are set) -> opens My allergies directly
function renderAlgHome() {
  const n = algGet().length;
  $('algBadge').hidden = !n;
  $('algBadge').textContent = `⚠️ ${n}`;
  $('algBadge').setAttribute('aria-label', t('algBadgeLabel', { n }));
  $('algBadge').title = t('algBadgeLabel', { n });
  $('settingsBtn').setAttribute('aria-label', t('settings'));
  $('settingsBtn').title = t('settings');
}
const algItem = (x) => `${h(L(x.name))}${x.tagOnly ? '' : ` <span class="alg-what">(${x.matched.slice(0, 3).map(h).join(', ')})</span>`}`;
// The banner at the very top of every result. Never says "safe": "none found" always points to the package.
function allergyBanner(a) {
  const r = E.allergyReport(a.allergens, algGet());
  window.__allergyReport = r;
  if (r.status === 'off') return '';
  let out = `<section class="alg-banner ${r.status}" id="algBanner">`;
  if (r.red.length) {
    out += `<div class="alg-title">${h(t('algRed'))} ${r.red.filter((x) => !x.tagOnly).map(algItem).join(', ') || r.red.map((x) => h(L(x.name))).join(', ')}</div>`;
    const notes = r.red.filter((x) => x.tagOnly || x.sources.includes('contains')).map((x) =>
      `<li><b>${h(L(x.name))}</b> — ${h(t(x.tagOnly ? 'algTagOnly' : 'algFromContains'))}</li>`);
    if (notes.length) out += `<ul class="alg-notes">${notes.join('')}</ul>`;
  }
  if (r.amber.length) {
    out += `<div class="alg-sub amber">${h(t('algAmber'))} ${r.amber.map((x) => (x.sources.includes('maybe') && x.maybeWhy
      ? `${h(L(x.name))} <span class="alg-what">(${h(L(x.maybeWhy))})</span>` : `${h(L(x.name))} <span class="alg-what">(${h(t('algTraces'))})</span>`)).join(', ')}</div>`;
  }
  if (r.unknown) out += `<div class="alg-sub amber" id="algUnknown">${h(t('algUnknown'))}</div>`;
  if (r.status === 'none') out += `<div class="alg-title">${h(t('algNone'))}</div>`;
  if (r.notes.length) out += `<ul class="alg-notes">${r.notes.map((x) => `<li><b>${h(L(x.name))}:</b> ${h(L(x.note))}</li>`).join('')}</ul>`;
  out += `<button type="button" class="link alg-edit" id="algBannerEdit">${h(t('algGear'))}</button></section>`;
  return out;
}
function openAllergies() { navTo('allergies', true); showAllergies(); }
function showAllergies() {
  showOnly('allergies');
  renderAllergies();
}
SCREENS.allergies = showAllergies;
let algQuery = '';
function renderAllergies() {
  const prof = algGet();
  const group = (g, key) => `<h3 class="alg-group">${h(t(key))}</h3><ul class="alg-list">${E.ALLERGENS.filter((a) => a.group === g).map((a) => `
    <li class="alg-row" data-id="${a.id}" data-q="${h([a.name.en, a.name.vi, ...a.words, ...a.cosmeticWords].join(' ').toLowerCase())}">
      <label><input type="checkbox" class="alg-cb" value="${a.id}"${prof.includes(a.id) ? ' checked' : ''}>
      <span class="alg-name">${h(L(a.name))}</span></label>
      <div class="alg-syn muted small">${h(t('algAlso'))}: ${h(a.words.filter((w) => w !== a.name.en.toLowerCase()).slice(0, 6).join(', '))}</div>
      ${a.note ? `<div class="alg-note small">${h(L(a.note))}</div>` : ''}</li>`).join('')}</ul>`;
  $('allergies').innerHTML = `<button type="button" class="link back" id="algBack">${h(t('camBack'))}</button>
    <h2 class="rk-title">⚠️ ${h(t('algTitle'))}</h2><p class="small">${h(t('algIntro'))}</p>
    <input id="algSearch" class="rk-search" type="search" autocomplete="off" placeholder="${h(t('algSearchPh'))}" value="${h(algQuery)}">
    <p class="muted small" id="algCount"></p>
    ${group('food', 'algGroupFood')}${group('skin', 'algGroupSkin')}
    <p class="muted small" id="algNoMatch" hidden>${h(t('algNoMatch'))}</p>
    <p class="muted small">${h(t('algNotMedical'))}</p>
    <button type="button" class="link" id="algClear">${h(t('algClearAll'))}</button>
    <button type="button" class="big primary" id="algDone">${h(t('algDone'))}</button>`;
  const count = () => { $('algCount').textContent = t('algCount', { n: algGet().length }); renderAlgHome(); };
  const filter = () => {
    const q = algQuery.trim().toLowerCase();
    let shown = 0;
    $('allergies').querySelectorAll('.alg-row').forEach((li) => { const on = !q || li.dataset.q.includes(q); li.hidden = !on; if (on) shown++; });
    $('algNoMatch').hidden = shown > 0;
  };
  $('allergies').querySelectorAll('.alg-cb').forEach((cb) => {
    cb.onchange = () => { const cur = algGet().filter((id) => id !== cb.value); algSet(cb.checked ? [...cur, cb.value] : cur); count(); };
  });
  $('algSearch').oninput = (e) => { algQuery = e.target.value; filter(); };
  $('algBack').onclick = goHome;
  $('algDone').onclick = goHome;
  $('algClear').onclick = () => { algSet([]); renderAllergies(); };
  count(); filter();
}
$('algBadge').onclick = openAllergies;

// ------------------------------------------------------------------ SETTINGS (gear in the header)
// units: 'us' (lb, ft+in, oz, fl oz) or 'metric' (kg, cm, g, ml). Stored on this phone only.
const unitsGet = () => (localStorage.getItem('fs_units') === 'metric' ? 'metric' : 'us');
function unitsSet(u) { localStorage.setItem('fs_units', u === 'metric' ? 'metric' : 'us'); }
const SETTINGS_ROWS = [];   // rows other screens add: {id, icon, key, sub(), open}
function openSettings() { if (navState() === 'settings') return; navTo('settings', true); showSettings(); }
function showSettings() { showOnly('settings'); renderSettings(); }
SCREENS.settings = showSettings;
function renderSettings() {
  const n = algGet().length;
  const row = (id, icon, label, sub) => `<button type="button" class="set-row" id="${id}"><span class="set-ico">${icon}</span><span class="set-text"><b>${h(label)}</b>${sub ? `<small>${h(sub)}</small>` : ''}</span><span class="set-go">›</span></button>`;
  $('settings').innerHTML = `<button type="button" class="link back" id="setBack">${h(t('back'))}</button>
    <h2 class="rk-title">⚙ ${h(t('settings'))}</h2>
    ${row('setAlg', '⚠️', t('algTitle'), n ? t('algSetN', { n }) : t('algSetNone'))}
    ${SETTINGS_ROWS.map((r) => row(r.id, r.icon, t(r.key), r.sub ? r.sub() : '')).join('')}
    ${CONFIG.WORKER_URL ? `<h3 class="set-h">${h(t('zipHead'))}</h3><form class="zip-form" id="zipForm"><input id="zipIn" inputmode="numeric" autocomplete="postal-code" maxlength="10" placeholder="${h(t('zipPh'))}" value="${h(getSavedZip() || '')}">
      <button type="submit" class="go">${h(t('zipSave'))}</button></form><p class="muted small" id="zipMsg">${h(t('zipHint'))}</p>` : ''}
    <h3 class="set-h">${h(t('unitsHead'))}</h3>
    ${seg('units', [['us', 'unitsUs'], ['metric', 'unitsMetric']], unitsGet())}
    <p class="muted small">${h(t('unitsNote'))}</p>`;
  $('setBack').onclick = goHome;
  $('setAlg').onclick = openAllergies;
  const zf = $('zipForm');
  if (zf) zf.onsubmit = (e) => { e.preventDefault(); const z = cleanZip($('zipIn').value); $('zipMsg').textContent = z ? `✓ ${t('zipSaved', { zip: saveZip(z) })}` : t('zipBad'); if (z) $('zipIn').value = z; };
  SETTINGS_ROWS.forEach((r) => { $(r.id).onclick = r.open; });
  $('settings').querySelectorAll('.seg[data-group=units] .seg-opt').forEach((b) => { b.onclick = () => { unitsSet(b.dataset.v); renderSettings(); TR.onRender(); }; });
}
$('settingsBtn').onclick = openSettings;

// "Compare prices": plain https store-search links, opened only when tapped (nothing is fetched or sent)
function renderPrices(prod, inline = false) {
  const links = E.storeLinks({ name: prod.name || '', brand: prod.brand || '', code: prod.code || '' });
  if (!links.length) return '';
  const body = `<h2>🛒 ${h(t('pricesHead'))}</h2><div class="price-grid">${links.map((l) =>
    `<a class="price-btn" href="${h(l.url)}" target="_blank" rel="noopener noreferrer" data-store="${l.id}">${h(l.name)}</a>`).join('')}</div>
    <p class="muted small">${h(t('pricesNote'))}${links.every((l) => l.by === 'barcode') ? ` ${h(t('pricesByCode'))}` : ''}</p>`;
  return inline ? `<div class="prices-inline" id="pricePanel">${body}</div>` : `<section class="card prices" id="pricePanel">${body}</section>`;
}
// 0->100 red-orange-lightgreen-green gauge with a marker at the score, end labels + "Higher = better"
function scaleBar(score, lowKey, highKey) {
  const pct = Math.max(0, Math.min(100, score));
  return `<div class="scale-bar"><div class="scale-track"><div class="scale-marker" style="left:${pct}%"></div></div>
    <div class="scale-ends"><span>${h(t(lowKey))}</span><span>${h(t(highKey))}</span></div>
    <div class="scale-dir">${h(t('higherBetter'))}</div></div>`;
}
function circle(id, title, score, band, partial, unknownShort, unknownLong, lowKey, highKey, verdictPrefix) {
  const head = `<div class="circle-title">${h(title)}</div>`;
  if (score == null) {
    return `<div class="score-col">${head}<div class="circle unknown" id="${id}"><span class="num">?</span></div>
      <div class="band" style="color:#5f6368">${h(unknownShort)}</div><p class="score-explain">${h(unknownLong)}</p></div>`;
  }
  const verdict = t(`${verdictPrefix}_${band.key}`);
  return `<div class="score-col">${head}<div class="circle${partial ? ' partial' : ''}" id="${id}" style="--c:${band.color}"><span class="num">${score}</span><span class="of">/100</span></div>
    <div class="band" style="color:${band.color}">${h(L(band.label))}</div>
    ${scaleBar(score, lowKey, highKey)}
    <p class="score-verdict">${h(verdict)}</p></div>`;
}
// TWO numbers side by side: health (food) or harmful-ingredients (non-food), and eczema
function scoreCircles(a) {
  const food = (a.type || 'food') === 'food';
  const es = a.eczemaScore;
  return circle('scoreCircle', t(food ? 'scoreHealth' : 'scoreHarm'), a.score, a.band, a.partial,
      t(food ? 'notEnough' : 'cantCheck'), food ? t('notEnoughWhy') : t('noScoreIngredients'),
      food ? 'healthScaleLow' : 'harmScaleLow', food ? 'healthScaleHigh' : 'harmScaleHigh', food ? 'healthVerdict' : 'harmVerdict')
    + circle('eczemaCircle', t('scoreEczema'), es ? es.score : null, es ? es.band : null, false,
      t('cantCheck'), t('noScoreIngredients'), 'eczemaScaleLow', 'eczemaScaleHigh', 'ecVerdict')
    + circle('cancerCircle', t('scoreCancer'), a.cancer ? a.cancer.score : null, a.cancer ? a.cancer.band : null, false,
      t('cantCheck'), t('noScoreIngredients'), 'cancerScaleLow', 'cancerScaleHigh', 'cxVerdict');
}
// cancer-linked ingredients: what was found, its classification, the points it cost, and the honest caveat
function renderCancer(cx) {
  let out = `<section class="card cancer" id="cancerPanel"><h2>🎗 ${h(t('cxHead'))}</h2><p class="cx-caveat">${h(t('cxCaveat'))}</p>`;
  if (!cx) return out + `<p class="ec-msg unknown">${h(t('cxUnknown'))}</p></section>`;
  if (!cx.items.length) out += `<p class="ec-msg ok">✓ ${h(t('cxNone'))}</p>`;
  else out += `<ul class="chips">${cx.items.map((it) => `<li class="chip cx-${it.level}"><div class="chip-top"><b>${h(L(it.name))}</b>
      <span class="sev">${h(t('cxLvl_' + it.level))}</span><span class="points">−${fmtN(it.penalty)} ${h(t('ecPoints'))}</span></div>
      <div class="chip-why">${h(L(it.why))}</div>${it.via ? `<div class="muted small">${h(t('cxFoundIn'))}: ${h(it.via)}</div>` : ''}</li>`).join('')}</ul>`;
  out += `<details class="breakdown" id="cxBreakdown"><summary>${h(t('howScored'))}</summary>
    <table>${cx.items.map((it) => `<tr><td>${h(L(it.name))} <span class="tag cx-${it.level}">${h(t('cxLvl_' + it.level))}</span></td><td>−${fmtN(it.penalty)}</td></tr>`).join('')}
    <tr><td><b>${h(t('ecScoreTotal'))}</b></td><td><b>${cx.score}</b></td></tr>
    ${cx.capped ? `<tr><td colspan="2" class="r-bad">${h(t('cxCap'))}</td></tr>` : ''}</table>
    <p class="muted small">${h(t('cxRule'))}</p></details></section>`;
  return out;
}

function renderAnalysis(a, { product, code, photo, db }) {
  if ((a.type || 'food') !== 'food') return renderNonFood(a, { product, code, photo, db });
  const parts = a.parts;
  const name = product ? productName(product) : t('photoName');
  const img = (product && E.productPhoto(product)) || (current && current.fallbackImg) || '';
  let out = `<section class="card score-card">`;
  out += `<div class="prod">${img ? `<img src="${h(img)}" alt="" class="prod-img" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="prod-text"><div class="prod-name" id="prodName">${h(name || code)}</div>${product && product.brands ? `<div class="prod-brand">${h(product.brands)}</div>` : ''}
    ${product && product.quantity ? `<div class="muted small">${h(product.quantity)}</div>` : ''}
    ${code ? `<div class="muted small">${h(t('barcode'))} ${h(code)}</div>` : ''}</div></div>`;
  if (photo) {
    out += `<div class="banner warn">${h(t('photoWarn'))}</div>`;
    if (photo.barcode && photo.barcodeState === 'notfound') out += `<div class="banner info">${h(t('bcNotInDb', { code: photo.barcode }))}</div>`;
    if (photo.barcode && photo.barcodeState === 'failed') out += `<div class="banner info">${h(t('bcLookupFailed', { code: photo.barcode }))}</div>`;
    if (photo.outcome === 'ingredients_only') out += `<div class="banner info" id="noFactsMsg">${h(t('photoNoFacts'))}</div>`;
  }
  out += sourceNotes(product);
  out += `<div class="score-row">${scoreCircles(a)}</div>`;
  if (a.score == null && photo && photo.outcome !== 'ingredients_only') out += `<p class="explain">${h(t('photoNoScore'))}</p>`;
  if (a.score != null && a.partial) out += `<div class="banner warn">${h(t('partialWarn'))}${a.missing.map((m) => h(t('miss_' + m))).join(', ')}</div>`;
  out += `<ul class="reasons">${a.reasons.map((r) => `<li class="r-${r.kind}">${h(L(r))}</li>`).join('')}</ul>`;
  const ns = parts.nutrition.nutriscore;
  out += `<details class="breakdown"><summary>${h(t('breakdown'))}</summary><table>
    <tr><td>${h(t('nutrition'))}</td><td>${parts.nutrition.points == null ? h(t('unknown')) : `${Math.round(parts.nutrition.points)}/60`}${ns && ns.grade ? ` · Nutri-Score ${ns.grade.toUpperCase()}${ns.score != null ? ` (${ns.score})` : ''}` : ''}</td></tr>
    <tr><td>${h(t('additives'))}</td><td>${parts.additives.points == null ? h(t('unknown')) : `${parts.additives.points}/30`}</td></tr>
    <tr><td>${h(t('processing'))}</td><td>${parts.processing.points == null ? h(t('unknown')) : `${parts.processing.points}/10 · NOVA ${parts.processing.nova}${parts.processing.estimated ? ` (${h(t('estimate'))})` : ''}`}</td></tr>
    ${a.capped ? `<tr><td colspan="2" class="r-bad">${h(t('capped'))}</td></tr>` : ''}</table></details>`;
  out += `</section>`;
  out += TR.ateCard({ key: current, name: name || (photo ? t('photoName') : code), code: code || (photo && photo.barcode) || '', product, photo });
  out += renderPrices(product ? { name, brand: product.brands, code } : { code: photo && photo.barcode });
  out += livePricesSlot(code || (photo && photo.barcode), product ? name : '', product && product.brands);

  out += renderEczema(a.eczema, a.eczemaScore, 'food');
  out += renderCancer(a.cancer);
  out += renderIngredients(a.ingredients, product);
  out += renderAdditives(parts.additives);
  out += photo ? renderPhotoRead(photo) : '';
  if (!photo || photo.per100) out += renderNutrients(a);
  return out;
}
// cosmetics / personal care / household: harmful-ingredients score instead of the nutrition score
function renderNonFood(a, { product, code, photo, db }) {
  const name = product ? productName(product) : t('photoName');
  const img = (product && E.productPhoto(product)) || (current && current.fallbackImg) || '';
  const dbName = product && product.worker_only ? t('srcWorkerOnly') : db ? ([...E.DATABASES, E.FDA_SOURCE].find((d) => d.id === db) || {}).name : '';
  let out = `<section class="card score-card">`;
  out += `<div class="prod">${img ? `<img src="${h(img)}" alt="" class="prod-img" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="prod-text"><div class="prod-name" id="prodName">${h(name || code)}</div>${product && product.brands ? `<div class="prod-brand">${h(product.brands)}</div>` : ''}
    <div class="type-chip" id="typeChip">${TYPE_ICON[a.type]} ${h(t('type_' + a.type))}${dbName ? ` · ${h(dbName)}` : ''}</div>
    ${code ? `<div class="muted small">${h(t('barcode'))} ${h(code)}</div>` : ''}</div></div>`;
  if (photo) out += `<div class="banner warn">${h(t('photoWarn'))}</div>`;
  out += sourceNotes(product);
  out += `<div class="score-row">${scoreCircles(a)}</div>`;
  if (a.score == null) {
    out += `<div class="banner info" id="noIngMsg">${h(t('nfNoIngredients'))}</div>${photoActions()}`;
  }
  out += `<ul class="reasons">${a.reasons.map((r) => `<li class="r-${r.kind}">${h(L(r))}</li>`).join('')}</ul>`;
  out += `<details class="breakdown"><summary>${h(t('breakdown'))}</summary><p class="small">${h(t('harmRule'))}</p></details></section>`;
  out += renderPrices(product ? { name, brand: product.brands, code } : { code: photo && photo.barcode });
  out += livePricesSlot(code || (photo && photo.barcode), product ? name : '', product && product.brands);
  out += renderEczema(a.eczema, a.eczemaScore, a.type);
  out += renderCancer(a.cancer);
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
    ${photoActions('photoRetry', 'tryAgainPhoto')}
    <p class="muted small">${h(t('ocrRawRead'))}</p><pre class="ocr">${c.text && c.text.trim() ? h(c.text) : h(t('ocrRawNone'))}</pre></section>`;
}

function renderEczema(ec, es, type = 'food') {
  let out = `<section class="card eczema" id="eczemaPanel"><h2>🩹 ${h(t(type === 'food' ? 'ecHead' : 'ecHeadContact'))}</h2>`;
  const ptsById = new Map(es ? es.items.map((it) => [it.id, it.penalty]) : []);
  if (es) {
    out += `<details class="breakdown" id="ecScoreBreakdown"><summary>${h(t('howScored'))}</summary>
      <table>${es.items.map((it) => `<tr><td>${h(L(it.name))} <span class="tag sev-${it.sev}">${h(t('sev_' + it.sev))}</span>${it.traces ? ` <span class="traces">${h(t('ecTraces'))}</span>` : ''}</td><td>−${fmtN(it.penalty)}</td></tr>`).join('')}
      <tr><td><b>${h(t('ecScoreTotal'))}</b></td><td><b>${Math.max(0, Math.round(100 - es.total))}</b></td></tr>
      ${es.capped ? `<tr><td colspan="2" class="r-bad">${h(t('ecScoreCap'))}</td></tr>` : ''}</table>
      <p class="muted small">${h(t('ecScoreRule'))}</p></details>`;
  }
  if (ec.status === 'unknown') out += `<p class="ec-msg unknown">${h(t('ecUnknown'))}</p>`;
  else if (ec.status === 'none') out += `<p class="ec-msg ok">✓ ${h(t('ecNone'))}</p>`;
  else {
    const high = ec.triggers.filter((tr) => tr.sev === 'high').length;
    const medium = ec.triggers.filter((tr) => tr.sev === 'medium').length;
    const low = ec.triggers.filter((tr) => tr.sev === 'low').length;
    out += `<div class="ec-overall sev-${ec.overall}">${h(t('ecSummary', { n: ec.count, high, medium, low }))}</div>
      <p class="ec-legend muted small">${h(t('ecLegend'))}</p>`;
    if (ec.status === 'found_partial') out += `<p class="ec-msg unknown">${h(t('ecPartial'))}</p>`;
    out += `<ul class="chips">${ec.triggers.map((tr) => `<li class="chip sev-${tr.sev}"><div class="chip-top"><b>${h(L(tr.name))}</b>
      <span class="sev">${h(t('sev_' + tr.sev))}</span>${tr.traces ? `<span class="traces">${h(t('ecTraces'))}</span>` : ''}
      ${ptsById.has(tr.id) ? `<span class="points">−${fmtN(ptsById.get(tr.id))} ${h(t('ecPoints'))}</span>` : ''}</div>
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
    histAdd(histEntry(analysis, { code: res.code, name: productName(res.product), brand: res.product.brands || '', img: E.productThumb(res.product) }));
    window.__lastResult = current;
    busy(false);
    enhanceFromWorker(res);
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
    // a barcode seen in the photo (even one no database knows) is kept so the row can get that product's picture
    histAdd(histEntry(analysis, { code: '', bcode: meta.barcode || '', name: `📷 ${label.ingredients.slice(0, 60) || t('photoName')}`, ocr: text.slice(0, 4000) }));
  }
  if (meta.barcode) fillImage(meta.barcode);
  renderCurrent();
  navTo('result', meta.push);
  showResultView();
}
$('photoInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); };

// ------------------------------------------------------------------ live barcode scanner
const scan = { stream: null, track: null, running: false, paused: false, torch: false, detector: null, session: 0, photoMode: false, hintTimer: 0, snap: null, snapUrl: '' };
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
// ONE camera screen. Barcode mode (default): auto-detects UPC/EAN continuously, with a big "Photo of ingredients"
// button that pulses after NO_BARCODE_MS. Photo mode (from a result screen): no auto-scan, just the photo button.
// The photo is taken IN the app from the live stream (ImageCapture.takePhoto = full sensor resolution where the
// browser has it, i.e. Android Chrome; else the current video frame), shown for "Use photo" / "Retake", then the
// normal photo pipeline (barcode-in-photo + orientation search + OCR) runs on it.
const NO_BARCODE_MS = 4000;
async function startScanner(opts = {}) {
  if (!window.isSecureContext || !navigator.mediaDevices) { alert(t('camHttps')); return; }
  const session = ++scan.session;           // Back pressed while the camera is still starting -> this start is stale
  const stale = () => session !== scan.session || $('scanner').hidden;
  scan.photoMode = !!opts.photo;
  $('scanner').classList.toggle('photo-mode', scan.photoMode);
  $('scanner').classList.remove('nobc');
  $('snapPreview').hidden = true; $('snapBtn').disabled = false;
  $('scanner').hidden = false; $('scanEngine').textContent = t('camStarting');
  navTo('camera', !!opts.push);
  let stream;
  try {
    // high-res stream: the in-app photo needs it for OCR where takePhoto() is not available (iPhone)
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } } });
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
  if (scan.photoMode) { $('scanEngine').textContent = ''; window.__scanEngine = 'photo'; return; }
  try { scan.detector = await getDetector(); } catch (err) { console.warn('detector', err); if (!stale()) { closeCamera(); alert(t('camError')); } return; }
  if (stale()) return;
  $('scanEngine').textContent = scan.detector.name;
  window.__scanEngine = scan.detector.name;
  scan.running = true;
  clearTimeout(scan.hintTimer);
  scan.hintTimer = setTimeout(() => { if (scan.running && session === scan.session) $('scanner').classList.add('nobc'); }, NO_BARCODE_MS);
  loop();
}
async function loop() {
  if (!scan.running) return;
  const video = $('video');
  try {
    if (video.readyState >= 2 && !scan.paused) {
      const found = await scan.detector.detect(video);
      const hit = found.find((b) => validScan(b.text, b.format));
      if (hit && scan.running && !scan.paused) {
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
  scan.running = false; scan.paused = false;
  clearTimeout(scan.hintTimer);
  if (scan.stream) scan.stream.getTracks().forEach((tr) => tr.stop());
  scan.stream = null; scan.track = null; scan.torch = false;
  $('torchBtn').classList.remove('on');
  $('video').srcObject = null;
  $('scanner').hidden = true;
  $('snapPreview').hidden = true;
  if (scan.snapUrl) { URL.revokeObjectURL(scan.snapUrl); scan.snapUrl = ''; }
  scan.snap = null;
}
// close the camera the same way the phone's Back button does (stops every camera track, back to home)
function closeCamera() {
  if (navState() === 'camera') history.back();   // popstate stops the scanner
  else stopScanner();
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
// Take a still from the live camera. Returns { blob, how, w, h }.
async function captureStill() {
  const track = scan.track, video = $('video');
  if ('ImageCapture' in window && track && track.readyState === 'live') {
    try {
      const ic = new window.ImageCapture(track);
      const settings = {};
      try {
        const pc = await withTimeout(ic.getPhotoCapabilities(), 2000);
        if (pc.imageWidth && pc.imageWidth.max) settings.imageWidth = pc.imageWidth.max;
        if (pc.imageHeight && pc.imageHeight.max) settings.imageHeight = pc.imageHeight.max;
      } catch { /* take the default size */ }
      const blob = await withTimeout(ic.takePhoto(settings), 6000);
      if (blob && blob.size > 0) {
        const bmp = await createImageBitmap(blob);
        const out = { blob, how: 'takePhoto', w: bmp.width, h: bmp.height };
        if (bmp.close) bmp.close();
        // some phones drop the torch after a photo: put it back
        if (scan.torch && scan.track) scan.track.applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
        return out;
      }
    } catch (err) { console.warn('takePhoto failed, using the video frame', err); }
  }
  const w = video.videoWidth, hgt = video.videoHeight;
  if (!w || !hgt) throw new Error('no video frame');
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = hgt;
  cv.getContext('2d').drawImage(video, 0, 0, w, hgt);
  const blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.95));
  return { blob, how: 'videoFrame', w, h: hgt };
}
async function snapPhoto() {
  if (!scan.track || $('snapBtn').disabled) return;
  const session = scan.session;
  scan.paused = true;                             // no barcode auto-jump while the photo is being looked at
  $('snapBtn').disabled = true;
  $('scanEngine').textContent = t('snapTaking');
  let shot;
  try { shot = await captureStill(); } catch (err) {
    console.warn('capture', err);
    $('snapBtn').disabled = false; scan.paused = false;
    if (session === scan.session) alert(t('snapFail'));
    return;
  }
  if (session !== scan.session) return;          // camera closed meanwhile
  window.__lastCapture = { how: shot.how, w: shot.w, h: shot.h, bytes: shot.blob.size };
  scan.snap = shot.blob;
  if (scan.snapUrl) URL.revokeObjectURL(scan.snapUrl);
  scan.snapUrl = URL.createObjectURL(shot.blob);
  $('snapImg').src = scan.snapUrl;
  $('snapInfo').textContent = `${shot.w}×${shot.h}`;
  $('scanEngine').textContent = scan.detector && !scan.photoMode ? scan.detector.name : '';
  $('snapPreview').hidden = false;
}
function snapRetake() {
  $('snapPreview').hidden = true; $('snapBtn').disabled = false;
  if (scan.snapUrl) { URL.revokeObjectURL(scan.snapUrl); scan.snapUrl = ''; }
  scan.snap = null; scan.paused = false;
}
function snapUse() {
  const blob = scan.snap;
  if (!blob) return;
  scan.snap = null;
  stopScanner();                                  // stops every track; the result screen replaces the camera history entry
  onPhoto(blob);
}
$('scanBtn').onclick = () => startScanner();
$('scanNext').onclick = () => { showHome(); startScanner(); };
$('closeScan').onclick = closeCamera;
$('scanBack').onclick = closeCamera;
$('snapBtn').onclick = snapPhoto;
$('snapRetake').onclick = snapRetake;
$('snapUse').onclick = snapUse;
$('scanGallery').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { stopScanner(); onPhoto(f); } };
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

// ------------------------------------------------------------------ calorie tracker + weight goal (screens in tracker.js, science in diet.js)
const TR = initTracker({
  $, t, L, h, seg, lang: () => lang, units: unitsGet, setUnits: unitsSet, showOnly, navTo, goHome, SCREENS, SETTINGS_ROWS, histGet, algGet,
  productFor: (code) => { for (const d of E.DATABASES) { const p = cacheGet(code, d.id, true); if (p) return p; } return null; },
  startScanner: () => startScanner({ push: true }),
});

applyLang();
