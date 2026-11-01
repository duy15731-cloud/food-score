// Food Score — CHEAPEST PRICE screen ("Tìm giá rẻ nhất"). The searching happens on the family's own computer
// (the Deal Finder program, reached over the private Tailscale network); this screen only sends the request and
// shows the answer. The computer works out every total (price - coupon + shipping + tax), not this screen.
// The computer's address is NOT in this public code: the phone is paired once by opening the "Add to Food Score"
// link on the Deal Finder page, which lands here as  #deals=<https address>. It is saved only after it answered.
// When the computer can't be reached (off, or Tailscale off on the phone) ONLY this screen says so; the rest of the
// app never depends on it.
// Stored on THIS phone only (localStorage):
//   fs_deals_url    the paired computer's address
//   fs_deals_prefs  how many, used/refurbished OK, memberships
//   fs_deals_last   the last search {id, query}, so leaving the screen never loses it
import { getSavedZip } from './prices.js';

const K = { url: 'fs_deals_url', prefs: 'fs_deals_prefs', last: 'fs_deals_last' };
const read = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch { return def; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const MEMS = [
  ['prime', 'Amazon Prime'], ['walmart_plus', 'Walmart+'], ['target_circle', { vi: 'Target Circle (miễn phí)', en: 'Target Circle (free)' }],
  ['target_circle_card', 'Target Circle Card'], ['costco', 'Costco'], ['sams_club', "Sam's Club"], ['bestbuy_plus', 'My Best Buy Plus/Total'],
];
const MEM_NAME = Object.fromEntries(MEMS);
const isWeb = (u) => /^https?:\/\//i.test(u || '');

// the paired address: https only (http just for this PC's own test server)
export function cleanDealsUrl(raw) {
  let txt = String(raw || '').trim();
  const inLink = /[#&]deals=([^&\s]+)/.exec(txt);          // the whole "Add to Food Score" link was pasted
  if (inLink) { try { txt = decodeURIComponent(inLink[1]); } catch { return null; } }
  try {
    const u = new URL(txt);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin;
  } catch { /* not an address */ }
  return null;
}

export function initDeals(ctx) {
  const { $, t, L, h } = ctx;
  let ui = { phase: 'idle', job: null, err: '', retry: 'search', pairMsg: '' };
  let defaults = { zip: null, tax: 0 };
  let timer = null;
  let inflight = false;                  // a poll is on its way; another must not start (nor be skipped forever)
  const base = () => read(K.url, null);
  const prefs = () => ({ qty: 1, used: false, mems: [], ...read(K.prefs, {}) });
  const money = (n) => (n == null ? '?' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const zip = () => getSavedZip(localStorage) || defaults.zip;

  // ------------------------------------------------------------------ talking to the computer
  async function api(path, body, ms = 12000, root = base()) {
    const ac = new AbortController();
    const kill = setTimeout(() => ac.abort(), ms);
    let r;
    try {
      r = await fetch(root + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal }
        : { signal: ac.signal, cache: 'no-store' });
    } catch { throw { kind: 'offline' }; } finally { clearTimeout(kill); }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (!r.ok || !j) throw { kind: r.status === 404 ? 'gone' : 'http', msg: (j && j.error) || String(r.status) };
    return j;
  }
  async function health(root) {
    const j = await api('/health', null, 8000, root);
    if (!j.ok || j.app !== 'deal-finder') throw { kind: 'http', msg: 'not Deal Finder' };
    if (j.defaults) defaults = { zip: j.defaults.zip || null, tax: Number(j.defaults.tax) || 0 };
    return j;
  }

  // ------------------------------------------------------------------ navigation
  const visible = () => !$('deals').hidden;
  const show = () => { ctx.showOnly('deals'); render(); resume(); };
  ctx.SCREENS.deals = show;
  const open = () => { ctx.navTo('deals', true); show(); };
  ctx.SETTINGS_ROWS.push({ id: 'setDeals', icon: '🏷', key: 'dfSetRow', open, sub: () => t(base() ? 'dfSetRowSub' : 'dfSetRowSubOff') });

  // ------------------------------------------------------------------ pairing:  …/food-score/#deals=https://…
  function tryPair() {
    const m = /[#&]deals=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    let raw = '';
    try { raw = decodeURIComponent(m[1]); } catch { raw = ''; }
    history.replaceState(history.state, '', location.pathname + location.search);   // never leave the address in the bar
    open();
    connect(raw);
  }
  // saved ONLY after the computer answered - a wrong or empty address is never stored
  function connect(raw) {
    const root = cleanDealsUrl(raw);
    ui.pairMsg = 'dfPairing';
    if (visible()) render();
    return (root ? health(root).then(() => { ui.pairMsg = write(K.url, root) ? 'dfPaired' : 'dfPairFail'; })
      : Promise.reject({ kind: 'bad' }))
      .catch(() => { ui.pairMsg = 'dfPairFail'; })
      .then(() => { if (visible()) render(); });
  }
  setTimeout(tryPair, 0);                                   // after the app has finished starting (language, home screen)
  window.addEventListener('hashchange', tryPair);           // the link opened while the app was already open

  // ------------------------------------------------------------------ search + polling
  function settingsQuery() {
    const p = prefs();
    return `qty=${p.qty}&used=${p.used ? 1 : 0}&tax=${encodeURIComponent(defaults.tax || 0)}&memberships=${p.mems.join(',')}`;
  }
  async function poll() {
    clearTimeout(timer);
    const last = read(K.last, null);
    if (!last || !base()) return;
    inflight = true;
    try {
      const j = await api(`/api/job?id=${encodeURIComponent(last.id)}&${settingsQuery()}`);
      ui.job = j;
      ui.phase = j.status === 'running' ? 'running' : j.status === 'done' ? 'done' : 'error';
      ui.err = j.status === 'error' ? j.error || '' : '';
      if (j.status === 'running' && visible()) timer = setTimeout(poll, 2000);
    } catch (e) {
      if (e.kind === 'gone') { localStorage.removeItem(K.last); ui = { ...ui, phase: 'error', job: null, err: t('dfExpired'), retry: 'search' }; }
      else { ui.phase = 'error'; ui.retry = 'poll'; ui.err = t(e.kind === 'offline' ? 'dfOffline' : 'dfFailed', { msg: e.msg || '' }); }
    }
    inflight = false;
    if (!visible()) return;
    // still searching: refresh only the progress card, so a box being typed in or a list being opened is not reset
    if (ui.phase === 'running' && $('dfProgress')) $('dfProgress').innerHTML = progressInner();
    else render();
  }
  async function resume() {
    if (!base()) return;
    if (!defaults.zip) { try { await health(); } catch { /* shown when a search is tried */ } }
    if (read(K.last, null) && !inflight) poll();     // also restarts a search left running while away
  }
  async function search(fresh) {
    const q = ($('dfQ') && $('dfQ').value.trim()) || '';
    if (q.length < 2) { $('dfQ').focus(); return; }
    ui = { ...ui, phase: 'starting', err: '', job: null };
    render();
    try {
      if (!defaults.zip) await health();
      const z = zip();
      if (!z) { ui.phase = 'error'; ui.retry = 'search'; ui.err = t('dfNoZip'); render(); return; }
      const j = await api('/api/search', { query: q, zip: z, qty: prefs().qty, fresh: !!fresh, lang: ctx.lang() });
      write(K.last, { id: j.id, query: q });
      ui.phase = 'running';
      poll();
    } catch (e) {
      ui.phase = 'error'; ui.retry = 'search';
      ui.err = t(e.kind === 'offline' ? 'dfOffline' : 'dfFailed', { msg: e.msg || '' });
      render();
    }
  }

  // ------------------------------------------------------------------ pieces
  const CH = (c) => t(c === 'online' ? 'dfShips' : c === 'local_pickup' ? 'dfPickup' : 'dfInStore');
  const codeText = (c) => {
    const [k, v] = String(c).split(':');
    if (k === 'needs') return t('dfNeeds', { name: L(MEM_NAME[v]) || v });
    if (k === 'cond') return t('dfCond', { cond: t('dfCond_' + v) || v });
    return t('dfCode_' + k);
  };
  function mathLine(o) {
    let s = `${money(o.unit_price)} × ${o.qty}`;
    if (o.discount) s += ` − ${money(o.discount)} ${o.coupon_used && o.coupon_used.code ? t('dfCode', { code: o.coupon_used.code }) : t('dfPromo')}`;
    s += o.channel === 'online' ? ` + ${o.shipping_known ? money(o.shipping) : '$?'} ${t('dfShip')}` : ` + $0 ${t('dfShipLocal')}`;
    if (o.tax) s += ` + ${money(o.tax)} ${t('dfTax')}`;
    return `${s} = ${money(o.total)}`;
  }
  const check = (o) => (o.price_seen_on && o.price_seen_on !== 'store_page') || (o.flag_codes || []).length;
  function winCard(key, o, big) {
    if (!o) return `<div class="df-win${big ? ' df-main' : ''}"><div class="df-lbl">${h(t(key))}</div><p class="muted small">${h(t('dfNone'))}</p></div>`;
    return `<div class="df-win${big ? ' df-main' : ''}"><div class="df-lbl">${h(t(key))}</div><div class="df-amt">${h(money(o.total))}</div>
      <div class="df-store">${h(o.store)}</div><div class="muted small">${h(CH(o.channel))}</div>
      ${check(o) ? `<div class="df-warn-line">⚠ ${h(t('dfDoubleCheck'))}</div>` : ''}
      ${isWeb(o.url) ? `<a class="df-open" href="${h(o.url)}" target="_blank" rel="noopener">${h(t('dfOpen'))} ↗</a>` : ''}</div>`;
  }
  function offerRow(o, i) {
    const b = [];
    const add = (txt, cls = '') => b.push(`<span class="df-b ${cls}">${h(txt)}</span>`);
    add(CH(o.channel));
    if (o.store_location) add(o.store_location);
    if (o.delivery_estimate) add(t('dfArrives', { when: o.delivery_estimate }));
    if (o.used_member_price) add(t('dfMemberPrice'), 'good');
    if (o.list_price && o.unit_price && o.list_price > o.unit_price) add(t('dfWas', { was: money(o.list_price) }), 'good');
    if (o.coupon_used && o.coupon_used.description) add(o.coupon_used.description, 'good');
    if (o.price_seen_on && o.price_seen_on !== 'store_page') add(t('dfFromListing'), 'warn');
    if (o.in_stock === 'unknown') add(t('dfStockUnknown'), 'warn');
    (o.flag_codes || []).forEach((c) => add(codeText(c), 'warn'));
    (o.blocker_codes || []).forEach((c) => add(codeText(c), 'bad'));
    return `<div class="df-offer"><div class="df-offer-head"><div>${i != null ? `<span class="df-rank">${i + 1}.</span>` : ''}<b>${h(o.store)}</b>
        <div class="muted small">${h(o.product_name || '')}</div></div><div class="df-tot">${h(money(o.total))}</div></div>
      ${o.total != null ? `<div class="df-math">${h(mathLine(o))}</div>` : ''}
      <div class="df-badges">${b.join('')}</div>
      ${o.maybe ? `<div class="df-maybe">${h(t('dfMaybe', { total: money(o.maybe.total), code: o.maybe.code || '?' }))}</div>` : ''}
      ${o.notes ? `<div class="df-math">${h(o.notes)}</div>` : ''}
      ${isWeb(o.url) ? `<a class="df-open" href="${h(o.url)}" target="_blank" rel="noopener">${h(t('dfOpenAt', { store: o.store }))} ↗</a>` : ''}</div>`;
  }
  function results(j) {
    const r = j.result;
    let s = `<section class="card"><p><b>${h(t('dfSearchedFor'))}</b> ${h(j.item_understood || j.query)}</p>
      ${j.clarify_question ? `<p class="df-maybe">${h(t('dfClarify'))} ${h(j.clarify_question)}</p>` : ''}</section>
      <div class="df-wins" id="dfWins">${winCard('dfBestAll', r.best.overall, true)}${winCard('dfBestLocal', r.best.local)}${winCard('dfBestOnline', r.best.online)}</div>`;
    if (r.ranked.length) s += `<section class="card" id="dfRanked"><h3 class="set-h">${h(t('dfAll', { n: r.ranked.length }))}</h3>${r.ranked.map(offerRow).join('')}</section>`;
    if (r.set_aside.length) s += `<details class="card df-aside"><summary>${h(t('dfAside', { n: r.set_aside.length }))}</summary>${r.set_aside.map((o) => offerRow(o, null)).join('')}</details>`;
    if (j.tips && j.tips.length) s += `<section class="card"><h3 class="set-h">${h(t('dfTips'))}</h3><ul class="df-tips">${j.tips.map((x) => `<li>${h(x)}</li>`).join('')}</ul></section>`;
    s += `<section class="card"><p class="muted small">${h(t('dfFoot', { time: j.checked_at, zip: j.zip, secs: (j.info && j.info.seconds) || '?' }))}</p>
      <button type="button" class="big secondary" id="dfAgain">${h(t('dfAgain'))}</button></section>`;
    return s;
  }

  // ------------------------------------------------------------------ the screen
  function progressInner() {
    const lines = (ui.job && ui.job.progress) || [];
    return `<p><span class="df-spin"></span>${h(t('dfRunning', { secs: (ui.job && ui.job.elapsed) || 0 }))}</p>
        <ul class="df-log">${lines.slice(-8).map((l) => `<li>${h(l)}</li>`).join('')}</ul>`;
  }
  function render() {
    const top = `<button type="button" class="link back" id="dfBack">${h(t('camBack'))}</button><h2 class="df-title">${h(t('dfTitle'))}</h2>`;
    const pair = ui.pairMsg ? `<p class="df-pair ${ui.pairMsg === 'dfPairFail' ? 'bad' : ''}" id="dfPairMsg">${h(t(ui.pairMsg))}</p>` : '';
    if (!base()) {
      $('deals').innerHTML = `${top}${pair}<section class="card" id="dfNotPaired"><p>${h(t('dfNotPaired'))}</p><ol class="df-steps"><li>${h(t('dfStep1'))}</li><li>${h(t('dfStep2'))}</li><li>${h(t('dfStep3'))}</li></ol>
        <p class="muted small">${h(t('dfPasteHint'))}</p>
        <form id="dfPairForm" class="df-form" autocomplete="off"><input id="dfPairIn" type="text" inputmode="url" placeholder="${h(t('dfPastePh'))}"><button type="submit" class="go">${h(t('dfConnect'))}</button></form></section>`;
      $('dfBack').onclick = ctx.goHome;
      $('dfPairForm').onsubmit = (e) => { e.preventDefault(); connect($('dfPairIn').value); };
      return;
    }
    const p = prefs();
    const last = read(K.last, null);
    const typed = $('dfQ') ? $('dfQ').value : null;          // keep what is being typed across a redraw
    const running = ui.phase === 'running' || ui.phase === 'starting';
    const memBoxes = MEMS.map(([id, name]) => `<label class="df-mem"><input type="checkbox" value="${id}"${p.mems.includes(id) ? ' checked' : ''}> ${h(L(name))}</label>`).join('');
    let body = `${top}${pair}
      <section class="card form"><p class="muted small">${h(t('dfIntro'))}</p>
        <form id="dfForm" class="df-form" autocomplete="off"><input id="dfQ" type="text" placeholder="${h(t('dfPh'))}" value="${h(typed != null ? typed : (last && last.query) || '')}">
          <button type="submit" class="go" id="dfGo"${running ? ' disabled' : ''}>${h(t('dfGo'))}</button></form>
        <div class="df-opts"><label>${h(t('dfQty'))} <input id="dfQty" type="number" inputmode="numeric" min="1" max="99" value="${p.qty}"></label>
          <label><input id="dfUsed" type="checkbox"${p.used ? ' checked' : ''}> ${h(t('dfUsed'))}</label>
          <span class="muted small" id="dfZip">${h(zip() ? t('dfZipLine', { zip: zip() }) : t('dfNoZip'))}</span></div>
        <details class="df-mems"${p.mems.length ? ' open' : ''}><summary>${h(t('dfMems'))}</summary><div class="df-mem-list">${memBoxes}</div></details>
      </section>`;
    if (running) {
      body += `<section class="card" id="dfProgress">${progressInner()}</section>`;
    } else if (ui.phase === 'error') {
      body += `<section class="card df-err" id="dfErr"><p>${h(ui.err)}</p><button type="button" class="big secondary" id="dfRetry">${h(t('dfRetry'))}</button></section>`;
    } else if (ui.phase === 'done' && ui.job && ui.job.result) {
      body += results(ui.job);
    }
    $('deals').innerHTML = body;
    $('dfBack').onclick = ctx.goHome;
    $('dfForm').onsubmit = (e) => { e.preventDefault(); search(false); };
    const save = () => {
      write(K.prefs, { qty: Math.max(1, Math.min(99, parseInt($('dfQty').value, 10) || 1)), used: $('dfUsed').checked,
        mems: [...$('deals').querySelectorAll('.df-mem input:checked')].map((c) => c.value) });
      if (ui.phase === 'done') poll();          // re-priced on the computer from the SAME search - instant, no new search
    };
    $('dfQty').onchange = save; $('dfUsed').onchange = save;
    $('deals').querySelectorAll('.df-mem input').forEach((c) => { c.onchange = save; });
    if ($('dfAgain')) $('dfAgain').onclick = () => search(true);
    if ($('dfRetry')) $('dfRetry').onclick = () => (ui.retry === 'poll' ? poll() : search(false));
  }

  return { open, onRender: () => { if (visible()) render(); } };   // language switch
}
