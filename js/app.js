// Food Score — page logic (camera, lookups, rendering). All scoring lives in engine.js.
import * as E from './engine.js';
import { STR } from './i18n.js';

const $ = (id) => document.getElementById(id);
const VERSION = self.APP_VERSION || 'dev';
const abs = (p) => new URL(p, location.href).href;
let lang = localStorage.getItem('fs_lang') || 'vi';
let current = null;        // what the result screen is showing: {kind, ...}
let sortWorst = false;

const t = (k) => (STR[k] ? STR[k][lang] : k);
const L = (o) => (o == null ? '' : typeof o === 'string' ? o : (o[lang] || o.en || ''));
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ language
function applyLang() {
  document.documentElement.lang = lang;
  $('langBtn').textContent = lang === 'vi' ? 'EN' : 'VI';
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  document.querySelectorAll('[data-ph]').forEach((el) => { el.placeholder = t(el.dataset.ph); });
  $('scanNext').textContent = t('scanNext');
  $('updateBtn').textContent = t('update');
  $('iosTip').textContent = t('iosTip');
  $('buildStamp').textContent = `v${VERSION}`;
  renderHistory();
  if (current) renderCurrent();
}
$('langBtn').onclick = () => { lang = lang === 'vi' ? 'en' : 'vi'; localStorage.setItem('fs_lang', lang); applyLang(); };

// ------------------------------------------------------------------ views
function showHome() {
  current = null;
  $('result').hidden = true; $('home').hidden = false; $('scanNext').hidden = true;
  renderHistory();
  window.scrollTo(0, 0);
}
function showResultView() {
  $('home').hidden = true; $('result').hidden = false; $('scanNext').hidden = false;
  window.scrollTo(0, 0);
}
function busy(on, text = '') { $('busy').hidden = !on; $('busyText').textContent = text; }

// ------------------------------------------------------------------ product cache (raw OFF JSON = inputs; failures never cached)
const CACHE_PREFIX = 'fs_p_';
const CACHE_DAYS = 30;
function cacheGet(code) {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_PREFIX + code) || 'null');
    if (v && Date.now() - v.t < CACHE_DAYS * 864e5) return v.p;
  } catch { /* ignore */ }
  return null;
}
function cachePut(code, product) {
  const write = () => localStorage.setItem(CACHE_PREFIX + code, JSON.stringify({ t: Date.now(), p: product }));
  try { write(); } catch {
    // storage full: drop the oldest half of cached products, then retry once
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_PREFIX))
      .map((k) => [k, (JSON.parse(localStorage.getItem(k) || '{}').t || 0)]).sort((a, b) => a[1] - b[1]);
    keys.slice(0, Math.ceil(keys.length / 2)).forEach(([k]) => localStorage.removeItem(k));
    try { write(); } catch { /* give up quietly: caching is optional */ }
  }
}

async function lookup(code, format = '') {
  const cands = E.lookupCandidates(code, format);
  for (const c of cands) { const p = cacheGet(c); if (p) return { state: 'found', product: p, code: c, cached: true, tried: cands }; }
  let failed = false;
  for (const c of cands) {
    let state = 'failed', body = null, status = 0;
    try {
      const res = await fetch(E.offUrl(c));
      status = res.status;
      body = await res.json().catch(() => null);
      state = E.classifyOffResponse(status, body);
    } catch { state = 'failed'; }
    if (state === 'found') { cachePut(c, body.product); return { state, product: body.product, code: c, tried: cands }; }
    if (state === 'failed') failed = true;
  }
  return { state: failed ? 'failed' : 'notfound', code, tried: cands };
}

// ------------------------------------------------------------------ history (last 30)
function histGet() { try { return JSON.parse(localStorage.getItem('fs_hist') || '[]'); } catch { return []; } }
function histAdd(item) {
  const list = histGet().filter((x) => !(item.code && x.code === item.code));
  list.unshift({ ...item, t: Date.now() });
  localStorage.setItem('fs_hist', JSON.stringify(list.slice(0, 30)));
}
function renderHistory() {
  const list = histGet();
  $('histList').innerHTML = list.length ? list.map((x, i) => {
    const color = x.score == null ? '#9aa0a6' : E.bandFor(x.score).color;
    return `<li><button type="button" class="hist-item" data-i="${i}">
      <span class="mini" style="background:${color}">${x.score == null ? '?' : x.score}</span>
      <span class="hist-name">${h(x.name || x.code)}</span>
      ${x.ecz && x.ecz !== 'none' && x.ecz !== 'unknown' ? `<span class="chip sev-${x.ecz} small">${h(t('sev_' + x.ecz))}</span>` : ''}
    </button></li>`;
  }).join('') : `<li class="empty">${h(t('noHistory'))}</li>`;
  $('histList').querySelectorAll('.hist-item').forEach((b) => {
    b.onclick = () => {
      const x = histGet()[Number(b.dataset.i)];
      if (x.ocr) showPhotoResult(x.ocr); else openBarcode(x.code);
    };
  });
}
$('clearHist').onclick = () => { localStorage.removeItem('fs_hist'); renderHistory(); };

// ------------------------------------------------------------------ barcode flow
async function openBarcode(raw, format = '') {
  const code = String(raw || '').replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) { alert(t('badCode')); return; }
  busy(true, t('looking'));
  const res = await lookup(code, format);
  busy(false);
  if (res.state === 'found') {
    const analysis = E.analyze(E.inputFromOff(res.product));
    current = { kind: 'off', product: res.product, code: res.code, analysis, cached: res.cached };
    histAdd({ code: res.code, name: productName(res.product), score: analysis.score, ecz: analysis.eczema.overall });
  } else {
    current = { kind: res.state, code, tried: res.tried, format };
  }
  window.__lastResult = current;   // for automated checks
  renderCurrent();
  showResultView();
}
$('typeForm').onsubmit = (e) => { e.preventDefault(); const v = $('codeInput').value; $('codeInput').blur(); openBarcode(v); };
const productName = (p) => p.product_name_vi && lang === 'vi' ? p.product_name_vi : (p.product_name || p.product_name_en || p.product_name_vi || '');

// ------------------------------------------------------------------ rendering
function renderCurrent() {
  const c = current;
  const back = `<button type="button" class="link back" id="backBtn">${h(t('back'))}</button>`;
  let html = '';
  if (c.kind === 'off') html = back + renderAnalysis(c.analysis, { product: c.product, code: c.code });
  else if (c.kind === 'photo') html = back + renderAnalysis(c.analysis, { photo: c });
  else if (c.kind === 'notfound') {
    html = back + `<section class="card msg"><h2>${h(t('notFound'))}</h2><p>${h(t('notFoundHelp'))}</p>
      <p class="muted">${h(t('barcode'))}: ${h(c.code)} · ${h(t('tried'))}: ${h(c.tried.join(', '))}</p>
      <label class="big secondary">📷 ${h(t('photo'))}<input type="file" accept="image/*" capture="environment" hidden class="photo-again"></label></section>`;
  } else if (c.kind === 'failed') {
    html = back + `<section class="card msg warn"><h2>${h(t('failed'))}</h2>
      <p class="muted">${h(t('barcode'))}: ${h(c.code)}</p><button type="button" class="big primary" id="retryBtn">${h(t('retry'))}</button></section>`;
  }
  $('result').innerHTML = html;
  $('backBtn').onclick = showHome;
  const rb = $('retryBtn'); if (rb) rb.onclick = () => openBarcode(c.code, c.format);
  $('result').querySelectorAll('.photo-again').forEach((inp) => { inp.onchange = () => inp.files[0] && onPhoto(inp.files[0]); });
  const sb = $('sortBtn'); if (sb) sb.onclick = () => { sortWorst = !sortWorst; renderCurrent(); };
}

function scoreCircle(a) {
  if (a.score == null) {
    return `<div class="circle unknown" id="scoreCircle"><span class="num">?</span></div><div class="band" style="color:#5f6368">${h(t('notEnough'))}</div>`;
  }
  return `<div class="circle${a.partial ? ' partial' : ''}" id="scoreCircle" style="--c:${a.band.color}"><span class="num">${a.score}</span><span class="of">/100</span></div>
    <div class="band" style="color:${a.band.color}">${h(L(a.band.label))}</div>`;
}

function renderAnalysis(a, { product, code, photo }) {
  const parts = a.parts;
  const name = product ? productName(product) : t('photoName');
  const img = product && (product.image_front_small_url || product.image_front_url);
  let out = `<section class="card score-card">`;
  out += `<div class="prod">${img ? `<img src="${h(img)}" alt="" class="prod-img" referrerpolicy="no-referrer">` : ''}
    <div><div class="prod-name">${h(name || code)}</div>${product && product.brands ? `<div class="muted">${h(product.brands)}</div>` : ''}
    ${code ? `<div class="muted small">${h(t('barcode'))} ${h(code)}</div>` : ''}</div></div>`;
  if (photo) out += `<div class="banner warn">${h(t('photoWarn'))}</div>`;
  out += `<div class="score-row">${scoreCircle(a)}</div>`;
  if (a.score == null) out += `<p class="explain">${h(photo ? t('photoNoScore') : t('notEnoughWhy'))}</p>`;
  if (a.score != null && a.partial) out += `<div class="banner warn">${h(t('partialWarn'))}${a.missing.map((m) => h(t('miss_' + m))).join(', ')}</div>`;
  out += `<ul class="reasons">${a.reasons.map((r) => `<li class="r-${r.kind}">${h(L(r))}</li>`).join('')}</ul>`;
  const ns = parts.nutrition.nutriscore;
  out += `<details class="breakdown"><summary>${h(t('breakdown'))}</summary><table>
    <tr><td>${h(t('nutrition'))}</td><td>${parts.nutrition.points == null ? h(t('unknown')) : `${Math.round(parts.nutrition.points)}/60`}${ns && ns.grade ? ` · Nutri-Score ${ns.grade.toUpperCase()}${ns.score != null ? ` (${ns.score})` : ''}` : ''}</td></tr>
    <tr><td>${h(t('additives'))}</td><td>${parts.additives.points == null ? h(t('unknown')) : `${parts.additives.points}/30`}</td></tr>
    <tr><td>${h(t('processing'))}</td><td>${parts.processing.points == null ? h(t('unknown')) : `${parts.processing.points}/10 · NOVA ${parts.processing.nova}${parts.processing.estimated ? ` (${h(t('estimate'))})` : ''}`}</td></tr>
    ${a.capped ? `<tr><td colspan="2" class="r-bad">${h(t('capped'))}</td></tr>` : ''}</table></details>`;
  out += `</section>`;

  out += renderEczema(a.eczema);
  out += renderIngredients(a.ingredients, product);
  out += renderAdditives(parts.additives);
  out += photo ? renderPhotoRead(photo) : '';
  out += renderNutrients(a);
  return out;
}

function renderEczema(ec) {
  let out = `<section class="card eczema" id="eczemaPanel"><h2>🩹 ${h(t('ecHead'))}</h2>`;
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
  return `<section class="card photo-read" id="photoRead"><h2>${h(t('whatRead'))}</h2>
    <table><tr><th></th><th>${h(t('perServing'))}</th><th>${h(t('per100'))}</th></tr>
    ${r(t('serving'), f.serving, f.servingUnit || 'g', null)}
    ${r(t('n_energy'), f.kcal, 'kcal', per.energy_kj == null ? null : per.energy_kj / 4.184)}
    ${r(t('n_fat'), f.fat, 'g', per.fat)}${r(t('n_satfat'), f.satfat, 'g', per.satfat)}
    ${r(t('n_sugars'), f.sugars, 'g', per.sugars)}
    <tr><td>${h(t('n_salt'))} (sodium)</td><td>${f.sodium_mg == null ? '<span class="muted">—</span>' : `${h(f.sodium_mg)} mg`}</td><td>${per.salt == null ? '' : `${fmtN(per.salt, 2)} g`}</td></tr>
    ${r(t('n_fiber'), f.fiber, 'g', per.fiber)}${r(t('n_protein'), f.protein, 'g', per.protein)}</table>
    ${f.repairs && f.repairs.length ? `<p class="muted small">${h(t('ocrRepairs'))}: ${f.repairs.map(h).join(' · ')}</p>` : ''}
    ${f.dvMismatch && f.dvMismatch.length ? `<div class="banner warn">${h(t('dvMismatch'))}: ${f.dvMismatch.map((k) => h(t('n_' + (k === 'sodium_mg' ? 'salt' : k === 'addedSugars' ? 'sugars' : k)))).join(', ')}</div>` : ''}
    ${p.label.contains ? `<p><b>CONTAINS:</b> ${h(p.label.contains)}</p>` : ''}${p.label.mayContain ? `<p><b>MAY CONTAIN:</b> ${h(p.label.mayContain)}</p>` : ''}
    <details><summary>${h(t('ocrText'))}</summary><pre class="ocr">${h(p.text)}</pre></details></section>`;
}

// ------------------------------------------------------------------ photo of label (on-device OCR, lazy-loaded)
let ocrWorker = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); });
}
async function downscale(file, max = 2000) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(file); }
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
}
async function getOcr() {
  if (ocrWorker) return ocrWorker;
  if (!window.Tesseract) await loadScript('./vendor/tesseract/tesseract.min.js');
  ocrWorker = await window.Tesseract.createWorker('eng', 1, {
    workerPath: abs('./vendor/tesseract/worker.min.js'), corePath: abs('./vendor/tesseract/core/'),
    langPath: abs('./vendor/tesseract/lang'), gzip: true, cacheMethod: 'write',
  });
  return ocrWorker;
}
async function onPhoto(file) {
  busy(true, t('ocrLoading'));
  try {
    const img = await downscale(file);
    const w = await getOcr();
    const { data } = await w.recognize(img);
    busy(false);
    showPhotoResult(data.text || '');
  } catch (err) {
    console.warn('OCR failed', err);
    busy(false);
    alert(t('ocrFail'));
  }
}
function showPhotoResult(text) {
  const { input, facts, label, per100 } = E.inputFromOcr(text);
  const analysis = E.analyze(input);
  current = { kind: 'photo', text, facts, label, per100, analysis };
  window.__lastResult = current;
  histAdd({ code: '', name: `📷 ${label.ingredients.slice(0, 40) || t('photoName')}`, score: analysis.score, ecz: analysis.eczema.overall, ocr: text.slice(0, 6000) });
  renderCurrent();
  showResultView();
}
$('photoInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) onPhoto(f); };

// ------------------------------------------------------------------ live barcode scanner
const scan = { stream: null, track: null, running: false, torch: false, detector: null, zx: null };
const ZX_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'];
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
  if (!window.ZXingWASM) await loadScript('./vendor/zxing/zxing-reader.js');
  const ZX = window.ZXingWASM;
  ZX.prepareZXingModule({ overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? abs('./vendor/zxing/' + p) : prefix + p) }, fireImmediately: true });
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
  $('scanner').hidden = false; $('scanEngine').textContent = t('camStarting');
  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (err) {
    console.warn('camera', err);
    stopScanner(); alert(t('camError')); return;
  }
  const video = $('video');
  video.srcObject = scan.stream;
  try { await video.play(); } catch { /* autoplay attrs cover iOS */ }
  scan.track = scan.stream.getVideoTracks()[0];
  const caps = scan.track.getCapabilities ? scan.track.getCapabilities() : {};
  $('torchBtn').hidden = !caps.torch;
  if (caps.focusMode && caps.focusMode.includes('continuous')) scan.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  try { scan.detector = await getDetector(); } catch (err) { console.warn('detector', err); stopScanner(); alert(t('camError')); return; }
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
  scan.running = false;
  if (scan.stream) scan.stream.getTracks().forEach((tr) => tr.stop());
  scan.stream = null; scan.track = null; scan.torch = false;
  $('video').srcObject = null;
  $('scanner').hidden = true;
}
$('scanBtn').onclick = startScanner;
$('scanNext').onclick = () => { showHome(); startScanner(); };
$('closeScan').onclick = stopScanner;
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
