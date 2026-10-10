// Food Score - "Live prices near <ZIP>" card.
// Drop-in ES module, no dependencies, no build step.
//
//   import { mountLivePrices, PRICE_STRINGS } from './prices.js';
//   mountLivePrices(document.getElementById('prices'),
//     { upc, name, brand },
//     { workerUrl: 'https://food-score-prices.<you>.workers.dev', strings: PRICE_STRINGS.vi, lang: 'vi' });
//
// Privacy: only the ZIP the user typed is sent (plus the product barcode/name).
// No GPS, no account. The ZIP is remembered in localStorage on this device.
//
// All API text is inserted with textContent (never innerHTML) and only
// http(s) links are rendered.

export const ZIP_KEY = 'foodscore.zip';

export const PRICE_STRINGS = {
  en: {
    title: 'Live prices near {zip}',
    loading: 'Checking stores near {zip}…',
    empty: 'No live price found — use the store buttons',
    error: "Couldn't reach the price service — use the store buttons",
    partial: 'Some sources did not answer.',
    asOf: 'as of {time}',
    zipLabel: 'Your ZIP code',
    zipPlaceholder: '5-digit ZIP',
    zipSave: 'Show prices',
    zipInvalid: 'Enter a 5-digit US ZIP code',
    zipHint: 'Only your ZIP code is sent — never your exact location.',
    changeZip: 'Change ZIP',
    online: 'Online',
    miles: '{n} mi',
    was: 'was {price}',
    outOfStock: 'Out of stock',
    similar: 'Similar item',
    view: 'View',
    sources: { kroger: 'Kroger (live)', google_shopping: 'Google Shopping', open_prices: 'Open Prices (shopper-reported)', upcitemdb: 'UPCitemdb (online listing, may be outdated)' },
  },
  vi: {
    title: 'Giá trực tiếp gần {zip}',
    loading: 'Đang kiểm tra các cửa hàng gần {zip}…',
    empty: 'Không tìm thấy giá trực tiếp — hãy dùng các nút cửa hàng',
    error: 'Không kết nối được dịch vụ giá — hãy dùng các nút cửa hàng',
    partial: 'Một vài nguồn không phản hồi.',
    asOf: 'cập nhật {time}',
    zipLabel: 'Mã ZIP của bạn',
    zipPlaceholder: 'ZIP 5 số',
    zipSave: 'Xem giá',
    zipInvalid: 'Hãy nhập mã ZIP Mỹ gồm 5 số',
    zipHint: 'Chỉ gửi mã ZIP — không bao giờ gửi vị trí chính xác của bạn.',
    changeZip: 'Đổi ZIP',
    online: 'Trực tuyến',
    miles: '{n} dặm',
    was: 'giá gốc {price}',
    outOfStock: 'Hết hàng',
    similar: 'Sản phẩm tương tự',
    view: 'Xem',
    sources: { kroger: 'Kroger (trực tiếp)', google_shopping: 'Google Shopping', open_prices: 'Open Prices (người mua báo giá)', upcitemdb: 'UPCitemdb (tin bán trực tuyến, có thể đã cũ)' },
  },
};

export const PRICES_CSS = `
.fs-prices{border:1px solid #d7dde3;border-radius:12px;padding:12px;margin:12px 0;font:14px/1.4 system-ui,sans-serif}
.fs-prices h3{margin:0 0 8px;font-size:16px}
.fs-prices ul{list-style:none;margin:0;padding:0}
.fs-prices li{display:flex;gap:8px;align-items:baseline;padding:8px 0;border-top:1px solid #eef1f4}
.fs-prices li:first-child{border-top:0}
.fs-prices .fs-main{flex:1;min-width:0}
.fs-prices .fs-store{font-weight:600}
.fs-prices .fs-sub{color:#5b6670;font-size:12px}
.fs-prices .fs-price{font-weight:700;font-size:16px;white-space:nowrap}
.fs-prices .fs-right{text-align:right;white-space:nowrap}
.fs-prices .fs-was{display:block;color:#5b6670;text-decoration:line-through;font-size:12px}
.fs-prices .fs-link{display:block;font-size:13px}
.fs-prices .fs-oos{color:#b3261e;font-size:12px}
.fs-prices .fs-note{color:#5b6670;font-size:12px;margin:8px 0 0}
.fs-prices a{color:#0b57d0}
.fs-prices form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.fs-prices input{font:inherit;padding:6px 8px;width:7em}
.fs-prices button{font:inherit;padding:6px 12px;cursor:pointer}
`;

// ---- small helpers ----------------------------------------------------------

export function fmt(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
}

export function cleanZip(raw) {
  const m = /^\s*(\d{5})(?:-?\d{4})?\s*$/.exec(String(raw == null ? '' : raw));
  return m ? m[1] : null;
}

function store(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // private mode / blocked storage
  }
}

export function getSavedZip(storage) {
  const s = store(storage);
  try {
    return s ? cleanZip(s.getItem(ZIP_KEY)) : null;
  } catch {
    return null;
  }
}

export function saveZip(zip, storage) {
  const z = cleanZip(zip);
  const s = store(storage);
  if (z && s) {
    try {
      s.setItem(ZIP_KEY, z);
    } catch {
      /* storage full or blocked - the ZIP still works for this session */
    }
  }
  return z;
}

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}

function locale(lang) {
  return lang === 'vi' ? 'vi-VN' : 'en-US';
}

export function formatPrice(n, lang, currency = 'USD') {
  try {
    return new Intl.NumberFormat(locale(lang), { style: 'currency', currency }).format(n);
  } catch {
    return `$${Number(n).toFixed(2)}`;
  }
}

/** "5 minutes ago" / "3 days ago" / a date, in the app language. */
export function formatAsOf(asOf, lang, now = Date.now()) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(asOf || '');
  const t = Date.parse(dateOnly ? `${asOf}T12:00:00` : asOf);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: 'auto' });
  const min = Math.floor(diff / 60000);
  if (!dateOnly && min < 1) return rtf.format(0, 'second'); // "now"
  if (!dateOnly && min < 60) return rtf.format(-min, 'minute');
  const hrs = Math.floor(diff / 3600000);
  if (!dateOnly && hrs < 24) return rtf.format(-hrs, 'hour');
  const days = Math.round(diff / 86400000);
  if (days <= 31) return rtf.format(-days, 'day');
  return new Date(t).toLocaleDateString(locale(lang), { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Valid rows only, cheapest first. */
export function sortedRows(result) {
  const rows = (result && Array.isArray(result.sources) ? result.sources : []).filter(
    (r) => r && typeof r.price === 'number' && Number.isFinite(r.price) && r.price > 0,
  );
  return rows.slice().sort((a, b) => a.price - b.price);
}

// ---- network ----------------------------------------------------------------

/**
 * Ask the Worker for prices. Never throws: on failure returns
 * { sources: [], errors: [...], failed: true } so the card can show its error state.
 */
export async function fetchPrices({ upc, name, brand, zip }, workerUrl, { timeoutMs = 8000, fetchImpl } = {}) {
  const z = cleanZip(zip);
  if (!z) return { sources: [], errors: [{ source: 'app', error: 'invalid zip' }], failed: true };
  const url = new URL('/prices', workerUrl);
  if (upc) url.searchParams.set('upc', String(upc));
  if (name) url.searchParams.set('name', String(name).slice(0, 100));
  if (brand) url.searchParams.set('brand', String(brand).slice(0, 60));
  url.searchParams.set('zip', z);
  const f = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url.toString(), { signal: ctrl.signal, credentials: 'omit', headers: { Accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      return { sources: [], errors: [{ source: 'worker', error: (body && body.error) || `HTTP ${res.status}` }], failed: true };
    }
    return body;
  } catch (e) {
    return { sources: [], errors: [{ source: 'network', error: e && e.name === 'AbortError' ? 'timeout' : 'network error' }], failed: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---- rendering --------------------------------------------------------------

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function card(doc, title) {
  const root = el(doc, 'section', 'fs-prices');
  root.setAttribute('aria-live', 'polite');
  root.appendChild(el(doc, 'h3', null, title));
  return root;
}

function changeZipLink(doc, S, onChangeZip) {
  const b = el(doc, 'button', 'fs-change', S.changeZip);
  b.setAttribute('type', 'button');
  if (onChangeZip) b.addEventListener('click', onChangeZip);
  return b;
}

/** ZIP entry form. onSaveZip(zip) is called with a cleaned 5-digit ZIP. */
export function renderZipForm({ strings, doc = globalThis.document, onSaveZip, zip = '' } = {}) {
  const S = strings || PRICE_STRINGS.en;
  const root = card(doc, fmt(S.title, { zip: '…' }));
  const form = el(doc, 'form');
  const label = el(doc, 'label', null, S.zipLabel);
  const input = el(doc, 'input');
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('autocomplete', 'postal-code');
  input.setAttribute('maxlength', '10');
  input.setAttribute('placeholder', S.zipPlaceholder);
  input.setAttribute('aria-label', S.zipLabel);
  input.value = zip;
  const btn = el(doc, 'button', null, S.zipSave);
  btn.setAttribute('type', 'submit');
  const msg = el(doc, 'p', 'fs-note', S.zipHint);
  form.appendChild(label);
  form.appendChild(input);
  form.appendChild(btn);
  form.addEventListener('submit', (ev) => {
    if (ev && ev.preventDefault) ev.preventDefault();
    const z = cleanZip(input.value);
    if (!z) {
      msg.textContent = S.zipInvalid;
      return;
    }
    if (onSaveZip) onSaveZip(z);
  });
  root.appendChild(form);
  root.appendChild(msg);
  return root;
}

export function renderLoading({ zip, strings, doc = globalThis.document } = {}) {
  const S = strings || PRICE_STRINGS.en;
  const root = card(doc, fmt(S.title, { zip }));
  root.setAttribute('aria-busy', 'true');
  root.appendChild(el(doc, 'p', 'fs-note', fmt(S.loading, { zip })));
  return root;
}

/** The "Live prices near <ZIP>" card for a Worker result. Returns an element. */
export function renderPricesCard(result, { zip, strings, lang = 'en', doc = globalThis.document, onChangeZip, now = Date.now() } = {}) {
  const S = strings || PRICE_STRINGS.en;
  const root = card(doc, fmt(S.title, { zip }));
  const rows = sortedRows(result);

  if (!rows.length) {
    root.appendChild(el(doc, 'p', 'fs-empty', result && result.failed ? S.error : S.empty));
  } else {
    const ul = el(doc, 'ul');
    for (const r of rows) {
      const li = el(doc, 'li');
      const main = el(doc, 'div', 'fs-main');
      main.appendChild(el(doc, 'div', 'fs-store', r.store || ''));

      const loc = r.location || {};
      const where = [];
      if (loc.online) where.push(S.online);
      else {
        if (loc.name && loc.name !== r.store) where.push(loc.name);
        if (loc.city) where.push(loc.state ? `${loc.city}, ${loc.state}` : loc.city);
      }
      if (typeof loc.distance_mi === 'number') where.push(fmt(S.miles, { n: loc.distance_mi }));
      if (where.length) main.appendChild(el(doc, 'div', 'fs-sub', where.join(' · ')));

      const detail = [];
      if (r.match === 'name' && r.title) detail.push(`${S.similar}: ${r.title}`);
      else if (r.size) detail.push(r.size);
      const asOf = formatAsOf(r.as_of, lang, now);
      if (asOf) detail.push(fmt(S.asOf, { time: asOf }));
      if (S.sources && S.sources[r.source]) detail.push(S.sources[r.source]);
      main.appendChild(el(doc, 'div', 'fs-sub', detail.join(' · ')));
      if (r.in_stock === false) main.appendChild(el(doc, 'div', 'fs-oos', S.outOfStock));

      const right = el(doc, 'div', 'fs-right');
      const price = el(doc, 'span', 'fs-price', formatPrice(r.price, lang, r.currency || 'USD'));
      right.appendChild(price);
      if (typeof r.regular_price === 'number' && r.regular_price > r.price) {
        right.appendChild(el(doc, 'span', 'fs-was', fmt(S.was, { price: formatPrice(r.regular_price, lang, r.currency || 'USD') })));
      }
      const href = safeUrl(r.url);
      if (href) {
        const a = el(doc, 'a', 'fs-link', S.view);
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer nofollow');
        right.appendChild(a);
      }
      li.appendChild(main);
      li.appendChild(right);
      ul.appendChild(li);
    }
    root.appendChild(ul);
    if (result && Array.isArray(result.errors) && result.errors.length) {
      root.appendChild(el(doc, 'p', 'fs-note', S.partial));
    }
  }
  root.appendChild(changeZipLink(doc, S, onChangeZip));
  return root;
}

/**
 * One-call wiring: asks for the ZIP once (remembered), then shows the card.
 * Returns a refresh() function.
 */
export function mountLivePrices(container, product, { workerUrl, strings, lang = 'en', storage, doc = globalThis.document, fetchImpl } = {}) {
  const S = strings || PRICE_STRINGS[lang] || PRICE_STRINGS.en;
  let injected = false;
  const injectCss = () => {
    if (injected || !doc.head || doc.getElementById?.('fs-prices-css')) return;
    const st = doc.createElement('style');
    st.id = 'fs-prices-css';
    st.textContent = PRICES_CSS;
    doc.head.appendChild(st);
    injected = true;
  };
  const show = (node) => {
    container.replaceChildren(node);
  };
  const askZip = (current) =>
    show(
      renderZipForm({
        strings: S,
        doc,
        zip: current || '',
        onSaveZip: (z) => {
          saveZip(z, storage);
          load(z);
        },
      }),
    );
  async function load(zip) {
    show(renderLoading({ zip, strings: S, doc }));
    const result = await fetchPrices({ ...product, zip }, workerUrl, { fetchImpl });
    show(renderPricesCard(result, { zip, strings: S, lang, doc, onChangeZip: () => askZip(zip) }));
    return result;
  }
  injectCss();
  const zip = getSavedZip(storage);
  if (zip) load(zip);
  else askZip('');
  return () => {
    const z = getSavedZip(storage);
    return z ? load(z) : askZip('');
  };
}
