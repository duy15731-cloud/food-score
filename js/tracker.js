// Food Score — calorie tracker + weight-goal planner SCREENS (profile & goal, "I ate this", Today, weigh-ins,
// Plan my day). Every nutrition / weight number comes from diet.js (the science, tested in tests/diet.test.mjs);
// this file only keeps the user's own entries on THIS phone (localStorage) and draws them. Nothing is sent anywhere.
// Internally everything is metric (kg, cm, g, ml, kcal); US units exist only on screen.
import * as D from './diet.js';

const K = { profile: 'fs_profile', log: 'fs_log', weights: 'fs_weights', override: 'fs_target_override' };
const read = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch { return def; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
// the phone's own calendar day (not UTC: a late-evening snack must land on today)
export const localIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// the Open Food Facts fields diet.js reads — a log entry keeps just these, so it can be edited later offline
const NUT_KEYS = ['energy-kcal', 'energy-kj', 'energy', 'proteins', 'carbohydrates', 'sugars', 'added-sugars', 'fat', 'saturated-fat', 'fiber', 'sodium', 'salt'];
const SNAP_FIELDS = ['serving_size', 'serving_quantity', 'serving_quantity_unit', 'product_quantity', 'product_quantity_unit', 'quantity'];
export function snapshot(product) {
  const nm = (product && product.nutriments) || {}, out = { nutriments: {} };
  for (const k of NUT_KEYS) for (const s of ['_100g', '_serving']) if (nm[k + s] != null && nm[k + s] !== '') out.nutriments[k + s] = nm[k + s];
  for (const f of SNAP_FIELDS) if (product && product[f] != null && product[f] !== '') out[f] = product[f];
  return out;
}
// a label photo -> the same shape: per-100 g from the facts table (when the engine could work it out) + per-serving as read
export function productFromPhoto(photo) {
  const per = photo.per100 || {}, f = photo.facts || {}, nm = {};
  const put = (k, v) => { if (v != null) nm[k] = v; };
  put('energy-kj_100g', per.energy_kj); put('fat_100g', per.fat); put('saturated-fat_100g', per.satfat); put('sugars_100g', per.sugars);
  put('salt_100g', per.salt); put('fiber_100g', per.fiber); put('proteins_100g', per.protein);
  put('energy-kcal_serving', f.kcal); put('fat_serving', f.fat); put('saturated-fat_serving', f.satfat); put('sugars_serving', f.sugars);
  put('added-sugars_serving', f.addedSugars); put('fiber_serving', f.fiber); put('proteins_serving', f.protein);
  if (f.sodium_mg != null) nm.sodium_serving = f.sodium_mg / 1000;   // label mg -> OFF grams
  const out = { nutriments: nm };
  if (f.serving) { out.serving_quantity = f.serving; out.serving_quantity_unit = f.servingUnit || 'g'; }
  return out;
}

export function initTracker(ctx) {
  const { $, t, L, h } = ctx;
  const us = () => ctx.units() === 'us';
  const loc = () => (ctx.lang() === 'vi' ? 'vi-VN' : 'en-US');
  // ---------------------------------------------------------------- formatting (every number carries its unit; unknown = "—", never 0)
  const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString(loc(), { maximumFractionDigits: d }));
  const kcal = (v) => (v == null ? '—' : `${fmt(v)} kcal`);
  const wUnit = () => (us() ? 'lb' : 'kg');
  const wtVal = (kg) => (kg == null ? null : us() ? D.kgToLb(kg) : kg);
  const wt = (kg, d = 1) => (kg == null ? '—' : `${fmt(wtVal(kg), d)} ${wUnit()}`);
  const wtIn = (v) => { const n = num(v); return n == null ? null : us() ? D.lbToKg(n) : n; };
  const ht = (cm) => { if (cm == null) return '—'; if (!us()) return `${fmt(cm)} cm`; const f = D.cmToFtIn(cm); return `${f.ft} ft ${f.in} in`; };
  const qty = (q, unit) => (q == null ? '—' : unit === 'ml' ? (us() ? `${fmt(D.mlToFlOz(q), 1)} fl oz` : `${fmt(q)} ml`) : (us() ? `${fmt(D.gToOz(q), 1)} oz` : `${fmt(q)} g`));
  const gr = (v, unit = 'g') => (v == null ? '—' : `${fmt(v, unit === 'g' && Math.abs(v) < 10 ? 1 : 0)} ${unit}`);
  const dateLabel = (iso, o = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) => new Date(`${iso}T12:00:00`).toLocaleDateString(loc(), o);
  const inputVal = (v, d = 1) => (v == null ? '' : String(Math.round(v * 10 ** d) / 10 ** d));
  const segL = (group, opts, active, cls = '') => `<div class="seg ${cls}" role="group" data-group="${group}">${opts.map(([v, label]) => `<button type="button" class="seg-opt${v === active ? ' active' : ''}" data-v="${v}" aria-pressed="${v === active}">${h(label)}</button>`).join('')}</div>`;
  const msgList = (list, id = '') => (list && list.length ? `<ul class="tr-msgs"${id ? ` id="${id}"` : ''}>${list.map((m) => `<li class="tr-msg ${m.kind || 'info'}">${h(L(m))}</li>`).join('')}</ul>` : '');
  const disclaimer = () => `<p class="tr-disclaimer">ⓘ ${h(t('trDisclaimer'))}</p>`;

  // ---------------------------------------------------------------- stored data
  const profGet = () => read(K.profile, null);
  const weights = () => read(K.weights, []).filter((w) => w && w.date && w.kg > 0).sort((a, b) => a.date.localeCompare(b.date));
  const currentKg = () => { const w = weights(); const p = profGet(); return w.length ? w[w.length - 1].kg : p ? p.weightKg : null; };
  function saveWeight(date, kg) {
    const list = weights().filter((w) => w.date !== date);
    list.push({ date, kg });
    return write(K.weights, list.sort((a, b) => a.date.localeCompare(b.date)));
  }
  const logAll = () => read(K.log, {});
  const dayEntries = (date) => logAll()[date] || [];
  function saveDay(date, entries) { const all = logAll(); if (entries.length) all[date] = entries; else delete all[date]; return write(K.log, all); }
  const addEntries = (date, list) => saveDay(date, [...dayEntries(date), ...list]);
  const saveFail = () => alert(t('trSaveFail'));

  // Everything the screens show, worked out by diet.js from the stored profile and the CURRENT weight
  // (the latest weigh-in). Re-run on every render, so a new weigh-in re-plans automatically — and the
  // planner's 1,000-kcal cap is measured from today's burn, so big losses stay reachable over time.
  function compute() {
    const p = profGet();
    if (!p) return null;
    const today = localIso();
    const input = { age: p.age, sex: p.sex, heightCm: p.heightCm, weightKg: currentKg(), activity: p.activity, bodyFatPct: p.bodyFatPct, bmiScale: p.bmiScale, pregnant: !!p.pregnant };
    const { profile, errors } = D.normalizeProfile(input);
    if (errors.length) return { p, profile, errors, today };
    const elig = D.planningEligibility(profile);
    const energy = D.energyNeeds(profile);
    const bmi = D.bmiCategory(D.bmi(profile.weightKg, profile.heightCm), profile.bmiScale);
    const g = p.goal || { mode: 'maintain' };
    let plan;
    if (!elig.ok) plan = { ok: false, reasons: elig.reasons, warnings: [] };
    else if (g.mode === 'target' && g.targetKg) plan = D.planToTarget({ profile: input, targetWeightKg: g.targetKg, targetDate: g.targetDate || null, startDate: today });
    else if (g.mode === 'rate' && g.rateKgPerWeek) plan = D.planByRate({ profile: input, ratePerWeekKg: g.rateKgPerWeek, startDate: today });
    else plan = D.planToTarget({ profile: input, targetWeightKg: profile.weightKg, startDate: today });
    const ov = read(K.override, null);
    const planKcal = plan.ok ? plan.dailyKcal : null;
    const override = planKcal != null && ov && ov.kcal ? ov.kcal : null;
    const dailyKcal = override != null ? override : planKcal;
    const targets = dailyKcal == null ? null : D.nutritionTargets({ profile, dailyKcal, phase: plan.mode || 'maintain' });
    const goalRate = !plan.ok ? null : plan.mode === 'maintain' ? 0 : g.mode === 'rate' ? g.rateKgPerWeek
      : plan.avgKgPerWeek != null ? (plan.mode === 'lose' ? -plan.avgKgPerWeek : plan.avgKgPerWeek) : null;
    return { p, g, profile, energy, bmi, plan, planKcal, override, dailyKcal, targets, goalRate, elig, today };
  }
  window.__trCompute = compute;   // for automated checks

  // ---------------------------------------------------------------- screens + navigation
  const open = (name, show) => () => { ctx.navTo(name, true); show(); };
  const showProfile = () => { ctx.showOnly('profile'); pd = null; renderProfile(); };
  const showToday = () => { ctx.showOnly('today'); if (!day) day = localIso(); renderToday(); };
  const showWeight = () => { ctx.showOnly('weight'); renderWeight(); };
  const showPlan = () => { ctx.showOnly('plan'); renderPlan(); };
  Object.assign(ctx.SCREENS, { profile: showProfile, today: showToday, weight: showWeight, plan: showPlan });
  const openProfile = open('profile', showProfile);
  const openToday = () => { day = localIso(); todayUi = { mode: null, id: null, st: null }; open('today', showToday)(); };
  const openWeight = open('weight', showWeight);
  const openPlan = open('plan', showPlan);
  ctx.SETTINGS_ROWS.push({ id: 'setProfile', icon: '🎯', key: 'profTitle', open: openProfile,
    sub: () => { const c = compute(); return c && c.dailyKcal ? t('profSubSet', { kcal: fmt(c.dailyKcal) }) : t('profSubNone'); } });
  const backBtn = (id) => `<button type="button" class="link back" id="${id}">${h(t('camBack'))}</button>`;

  // ---------------------------------------------------------------- weight-projection / trend chart (inline SVG)
  const niceStep = (raw) => { const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
  function lineChart({ id, lines = [], dots = [], hline = null, startDate, days, title }) {
    const W = 360, H = 230, L0 = 54, R0 = 14, T0 = 26, B0 = 34;
    const ys = [...lines.flatMap((l) => l.pts.map((p) => p[1])), ...dots.map((p) => p[1]), ...(hline ? [hline.y] : [])].filter(Number.isFinite);
    if (!ys.length) return '';
    let lo = Math.min(...ys), hi = Math.max(...ys);
    if (hi - lo < 2) { lo -= 1; hi += 1; }
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const xMax = Math.max(1, days);
    const X = (x) => L0 + (x / xMax) * (W - L0 - R0), Y = (y) => T0 + (1 - (y - lo) / (hi - lo)) * (H - T0 - B0);
    let s = `<svg class="chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(title)}">`;
    for (let y = lo; y <= hi + step / 2; y += step) {
      s += `<line class="grid" x1="${L0}" x2="${W - R0}" y1="${Y(y)}" y2="${Y(y)}"/><text class="ax" x="${L0 - 6}" y="${Y(y) + 4}" text-anchor="end">${fmt(y, step < 1 ? 1 : 0)}</text>`;
    }
    s += `<text class="ax unit" x="${L0 - 6}" y="14" text-anchor="end">${wUnit()}</text>`;
    const long = days > 300;
    const xl = (x) => dateLabel(D.addDays(startDate, Math.round(x)), long ? { month: 'short', year: 'numeric' } : { month: 'short', day: 'numeric' });
    [[0, 'start'], [xMax / 2, 'middle'], [xMax, 'end']].forEach(([x, a]) => { s += `<line class="tick" x1="${X(x)}" x2="${X(x)}" y1="${H - B0}" y2="${H - B0 + 5}"/><text class="ax" x="${X(x)}" y="${H - B0 + 20}" text-anchor="${a}">${h(xl(x))}</text>`; });
    s += `<line class="axis" x1="${L0}" x2="${W - R0}" y1="${H - B0}" y2="${H - B0}"/>`;
    if (hline) s += `<line class="goal" x1="${L0}" x2="${W - R0}" y1="${Y(hline.y)}" y2="${Y(hline.y)}"/><text class="ax goal-t" x="${W - R0}" y="${Y(hline.y) - 6}" text-anchor="end">${h(hline.label)}</text>`;
    for (const l of lines) if (l.pts.length) s += `<path class="${l.cls}" d="${l.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')}"/>`;
    for (const p of dots) s += `<circle class="dot" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="4.5"/>`;
    return s + '</svg>';
  }

  // ================================================================= 1. PROFILE & GOAL
  let pd = null;            // the form being edited (metric), so switching units never rounds what was typed
  let profMsg = '';
  function draftFromStore() {
    const p = profGet() || {};
    const g = p.goal || { mode: 'target' };
    return { age: p.age ?? null, sex: p.sex || 'female', heightCm: p.heightCm ?? null, weightKg: currentKg(), activity: p.activity || 'light', bodyFatPct: p.bodyFatPct ?? null,
      bmiScale: p.bmiScale || (ctx.lang() === 'vi' ? 'asian' : 'who'), pregnant: !!p.pregnant,
      goal: { mode: g.mode || 'target', targetKg: g.targetKg ?? null, targetDate: g.targetDate || '', dir: g.rateKgPerWeek > 0 ? 'gain' : 'lose', rateAbsKg: Math.abs(g.rateKgPerWeek || 0) || D.KG_PER_LB } };
  }
  const RATE_OPTS = () => (us() ? [0.5, 1, 1.5, 2].map((lb) => [D.lbToKg(lb), `${fmt(lb, 1)} lb`]) : [0.25, 0.5, 0.75, 1].map((kg) => [kg, `${fmt(kg, 2)} kg`]));
  function renderProfile() {
    if (!pd) pd = draftFromStore();
    const fld = (label, inner, id = '') => `<div class="fld"${id ? ` id="${id}"` : ''}><span class="fld-l">${h(label)}</span>${inner}</div>`;
    const numIn = (id, v, unit, ph = '') => `<span class="num-in"><input id="${id}" type="number" inputmode="decimal" step="any" min="0" value="${h(v)}" placeholder="${h(ph)}"><span class="unit">${h(unit)}</span></span>`;
    const f = pd.heightCm != null ? D.cmToFtIn(pd.heightCm) : null;
    const height = us() ? `<span class="num-pair">${numIn('pFt', f ? f.ft : '', 'ft')}${numIn('pIn', f ? f.in : '', 'in')}</span>` : numIn('pCm', inputVal(pd.heightCm, 0), 'cm');
    const ratesel = RATE_OPTS();
    const nearest = ratesel.reduce((b, o) => (Math.abs(o[0] - pd.goal.rateAbsKg) < Math.abs(b[0] - pd.goal.rateAbsKg) ? o : b), ratesel[0]);
    const g = pd.goal;
    const c = compute();
    $('profile').innerHTML = `${backBtn('profBack')}
      <h2 class="rk-title">🎯 ${h(t('profTitle'))}</h2>
      <p class="muted small">🔒 ${h(t('trPrivate'))}</p>
      ${segL('units', [['us', t('unitsUs')], ['metric', t('unitsMetric')]], ctx.units(), 'units-seg')}
      <section class="card form" id="profForm">
        ${fld(t('pAge'), numIn('pAge', inputVal(pd.age, 0), t('pYears')))}
        ${fld(t('pSex'), segL('sex', [['female', t('pFemale')], ['male', t('pMale')], ['unspecified', t('pUnspecified')]], pd.sex))}
        ${pd.sex !== 'male' ? `<label class="check"><input type="checkbox" id="pPreg"${pd.pregnant ? ' checked' : ''}> ${h(t('pPregnant'))}</label>` : ''}
        ${fld(t('pHeight'), height)}
        ${fld(t('pWeight'), numIn('pWt', inputVal(wtVal(pd.weightKg)), wUnit()))}
        ${fld(t('pActivity'), `<div class="radios" role="radiogroup">${Object.entries(D.ACTIVITY).map(([k, a]) => `<label class="radio${pd.activity === k ? ' on' : ''}"><input type="radio" name="pAct" value="${k}"${pd.activity === k ? ' checked' : ''}><span>${h(L(a))}</span></label>`).join('')}</div>`)}
        ${fld(t('pBodyFat'), numIn('pBf', inputVal(pd.bodyFatPct), '%'))}
        ${fld(t('pBmiScale'), segL('bmi', [['who', t('pBmiWho')], ['asian', t('pBmiAsian')]], pd.bmiScale))}
        <h3 class="set-h">${h(t('pGoal'))}</h3>
        ${segL('goal', [['target', t('gTarget')], ['rate', t('gRate')], ['maintain', t('gMaintain')]], g.mode)}
        ${g.mode === 'target' ? fld(t('gTargetKg'), numIn('gWt', inputVal(wtVal(g.targetKg)), wUnit())) + fld(t('gTargetDate'), `<input id="gDate" type="date" min="${localIso()}" value="${h(g.targetDate || '')}">`) : ''}
        ${g.mode === 'rate' ? segL('dir', [['lose', t('gLose')], ['gain', t('gGain')]], g.dir) + fld(t('gPerWeek'), `<select id="gRate">${ratesel.map(([kg, lab]) => `<option value="${kg}"${kg === nearest[0] ? ' selected' : ''}>${h(lab)} ${h(t('gPerWeek'))}</option>`).join('')}</select>`) : ''}
        <p class="err" id="profErr" hidden></p>
        <button type="button" class="big primary" id="profSave">${h(t('pSave'))}</button>
        ${profMsg ? `<div class="banner ok" id="profMsg">${h(profMsg)}</div>` : ''}
      </section>
      ${c ? profileResults(c) : ''}
      ${disclaimer()}`;
    profMsg = '';
    $('profBack').onclick = ctx.goHome;
    const form = $('profile');
    form.querySelectorAll('.seg').forEach((sg) => sg.querySelectorAll('.seg-opt').forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.v, grp = sg.dataset.group;
        if (grp === 'units') { ctx.setUnits(v); ate.st = null; }
        else if (grp === 'sex') { pd.sex = v; if (v === 'male') pd.pregnant = false; }
        else if (grp === 'bmi') pd.bmiScale = v;
        else if (grp === 'goal') pd.goal.mode = v;
        else if (grp === 'dir') pd.goal.dir = v;
        renderProfile();
      };
    }));
    // read ONLY the field that changed, so switching units never re-rounds the others
    form.addEventListener('input', (e) => {
      const el = e.target, v = el.value;
      if (el.id === 'pAge') pd.age = num(v);
      else if (el.id === 'pCm') pd.heightCm = num(v);
      else if (el.id === 'pFt' || el.id === 'pIn') { const ft = num($('pFt').value), inch = num($('pIn').value); pd.heightCm = ft == null ? null : D.ftInToCm(ft, inch || 0); }
      else if (el.id === 'pWt') pd.weightKg = wtIn(v);
      else if (el.id === 'pBf') pd.bodyFatPct = num(v);
      else if (el.id === 'gWt') pd.goal.targetKg = wtIn(v);
      else if (el.id === 'gDate') pd.goal.targetDate = v;
      else if (el.id === 'gRate') pd.goal.rateAbsKg = num(v);
      else if (el.id === 'pPreg') pd.pregnant = el.checked;
      else if (el.name === 'pAct') { pd.activity = v; form.querySelectorAll('.radio').forEach((r) => r.classList.toggle('on', r.querySelector('input').checked)); }
    });
    form.addEventListener('change', (e) => { if (e.target.id === 'gRate') pd.goal.rateAbsKg = num(e.target.value); if (e.target.id === 'pPreg') pd.pregnant = e.target.checked; if (e.target.id === 'gDate') pd.goal.targetDate = e.target.value; });
    $('profSave').onclick = saveProfile;
    const up = $('useplanner'); if (up) up.onclick = () => { localStorage.removeItem(K.override); renderProfile(); };
  }
  function saveProfile() {
    const { errors } = D.normalizeProfile(pd);
    const err = $('profErr');
    const g = pd.goal;
    let msg = errors.length ? L(errors[0]) : '';
    if (!msg && g.mode === 'target' && !(g.targetKg > 0)) msg = t('gTargetKg') + ' ?';
    if (msg) { err.textContent = msg; err.hidden = false; err.scrollIntoView({ block: 'center' }); return; }
    const goal = g.mode === 'target' ? { mode: 'target', targetKg: g.targetKg, targetDate: g.targetDate || null }
      : g.mode === 'rate' ? { mode: 'rate', rateKgPerWeek: (g.dir === 'gain' ? 1 : -1) * (g.rateAbsKg || D.KG_PER_LB) } : { mode: 'maintain' };
    const ok = write(K.profile, { age: pd.age, sex: pd.sex, heightCm: pd.heightCm, weightKg: pd.weightKg, activity: pd.activity, bodyFatPct: pd.bodyFatPct,
      bmiScale: pd.bmiScale, pregnant: pd.sex !== 'male' && !!pd.pregnant, goal, updated: Date.now() });
    if (!ok) { saveFail(); return; }
    const cur = currentKg();
    if (weights().length === 0 || Math.abs((cur || 0) - pd.weightKg) > 0.04) saveWeight(localIso(), pd.weightKg);   // the weight typed here IS today's weigh-in
    localStorage.removeItem(K.override);   // a new goal = a new plan
    profMsg = t('pSaved');
    pd = null;
    renderProfile();
    const r = $('profResults'); if (r) r.scrollIntoView({ block: 'start' });
    renderHomeBar();
  }
  function targetsTable(T) {
    const row = (label, val) => `<tr><td>${h(label)}</td><td>${val}</td></tr>`;
    return `<table class="tr-targets" id="profTargets">
      ${row(t('tProtein'), `${gr(T.proteinG[0])}–${gr(T.proteinG[1])}`)}
      ${row(t('tFiber'), `${h(t('tAtLeast'))} ${gr(T.fiberMinG)}`)}
      ${row(t('tSugar'), `${h(t('tAtMost'))} ${gr(T.addedSugarMaxG)}`)}
      ${row(t('tSodium'), `${h(t('tAtMost'))} ${gr(T.sodiumMaxMg, 'mg')}`)}
      ${row(t('tSatFat'), `${h(t('tAtMost'))} ${gr(T.satFatMaxG)}`)}
      ${row(t('tCarbs'), `${gr(T.carbsG[0])}–${gr(T.carbsG[1])}`)}
      ${row(t('tFat'), `${gr(T.fatG[0])}–${gr(T.fatG[1])}`)}</table>`;
  }
  function profileResults(c) {
    let out = `<section class="card tr-results" id="profResults"><h2>${h(t('pResults'))}</h2>`;
    if (c.errors) return out + msgList(c.errors, 'profWarnings') + '</section>';
    const plan = c.plan;
    // warnings first and loud: under 18, pregnancy, safety floor, pace cap, too long ...
    out += msgList([...(plan.reasons || []), ...(plan.warnings || []).filter((w) => w.kind !== 'info'), ...(plan.warnings || []).filter((w) => w.kind === 'info')], 'profWarnings');
    if (!c.elig.ok) return out + '</section>';
    out += `<div class="tr-big"><span class="tr-big-l">${h(t('rBmi'))}</span><span class="tr-big-n" id="profBmi">${fmt(c.bmi.bmi, 1)}</span><span class="tr-big-s">${h(L(c.bmi.label))}</span></div>
      <details class="small"><summary>ⓘ BMI</summary>${c.bmi.notes.map((n) => `<p>${h(L(n))}</p>`).join('')}<p class="muted">${h(t('pHeight'))}: ${h(ht(c.profile.heightCm))} · ${h(t('pWeight'))}: ${h(wt(c.profile.weightKg))}</p></details>`;
    if (c.dailyKcal != null) {
      out += `<div class="tr-big main"><span class="tr-big-l">${h(t('rEat'))}</span><span class="tr-big-n" id="profKcal">${kcal(c.dailyKcal)}</span></div>`;
      if (c.override != null) out += `<div class="banner info">${h(t('rOverride', { kcal: fmt(c.override), plan: fmt(c.planKcal) }))} <button type="button" class="link" id="usePlanner">${h(t('rUsePlanner'))}</button></div>`;
    } else out += `<p class="muted">${h(t('rNoTarget'))}</p>`;
    out += `<table class="tr-kv"><tr><td>${h(t('rMaint'))}</td><td id="profTdee">${kcal(c.energy.tdee)}</td></tr>
      ${plan.ok && plan.mode !== 'maintain' ? `<tr><td>${h(t('rMaintAfter'))}</td><td>${kcal(plan.maintenanceKcal)}</td></tr>` : ''}
      ${c.energy.tdeeKatch != null ? `<tr><td>${h(t('rKatch'))}</td><td>${kcal(c.energy.tdeeKatch)}</td></tr>` : ''}
      ${plan.ok && plan.mode !== 'maintain' ? `<tr><td>${h(t('rReach'))}</td><td id="profReach">${plan.reached ? `<b>${h(dateLabel(plan.reachDate))}</b><br><span class="muted small">${h(t('rReachWeeks', { n: fmt(plan.weeks) }))}</span>`
        : h(plan.plateauKg != null && (plan.warnings || []).some((w) => w === D.MSG.notReachable) ? t('rNotReached', { w: wt(plan.plateauKg) }) : t('rTooLong'))}</td></tr>` : ''}</table>`;
    if (c.targets) out += `<h3 class="set-h">${h(t('rTargets'))}</h3>${targetsTable(c.targets)}`;
    if (plan.ok && plan.weekly && plan.weekly.length > 1) {
      const pts = plan.weekly.map((w) => [w.day, wtVal(w.weightKg)]);
      const goalKg = c.g.mode === 'target' ? c.g.targetKg : plan.mode !== 'maintain' ? null : null;
      out += `<h3 class="set-h">${h(t('rChart'))}</h3>${lineChart({ id: 'profChart', title: t('rChart'), lines: [{ pts, cls: 'proj' }], startDate: plan.startDate, days: pts[pts.length - 1][0],
        hline: goalKg ? { y: wtVal(goalKg), label: `${t('gTargetKg')} ${wt(goalKg)}` } : null })}`;
    }
    return out + '</section>';
  }

  // ================================================================= 2. AMOUNT PICKER ("I ate this" + editing a logged food)
  const mealNow = () => { const hr = new Date().getHours(); return hr >= 4 && hr < 11 ? 'breakfast' : hr >= 11 && hr < 15 ? 'lunch' : hr >= 17 && hr < 22 ? 'dinner' : 'snacks'; };
  const defVal = (mode) => ({ servings: 1, package: 1, weight: us() ? 3.5 : 100, volume: us() ? 8 : 250 }[mode]);
  const stepOf = (mode) => ({ servings: 0.5, package: 0.25, weight: us() ? 0.5 : 10, volume: us() ? 1 : 25 }[mode]);
  function pickerModes(prod) {
    const m = [];
    if (D.nutrientsEaten(prod, { servings: 1 }).ok) m.push('servings');
    m.push('weight');
    if (D.isLiquid(prod)) m.push('volume');
    if (D.packageOf(prod)) m.push('package');
    return m;
  }
  function newPicker(prod, init = {}) {
    const modes = pickerModes(prod);
    const mode = init.mode && modes.includes(init.mode) ? init.mode : modes[0];
    return { prod, modes, mode, value: init.value ?? defVal(mode), meal: init.meal || mealNow(), units: ctx.units() };
  }
  // an entry already in the log -> a picker showing the same amount (in the current units)
  function pickerFromEntry(e) {
    const a = e.amount || {};
    if (a.servings != null) return newPicker(e.prod, { mode: 'servings', value: a.servings, meal: e.meal });
    if (a.packages != null) return newPicker(e.prod, { mode: 'package', value: a.packages, meal: e.meal });
    const mode = e.unit === 'ml' ? 'volume' : 'weight';
    const v = e.qty == null ? null : mode === 'volume' ? (us() ? D.mlToFlOz(e.qty) : e.qty) : (us() ? D.gToOz(e.qty) : e.qty);
    return newPicker(e.prod, { mode, value: v == null ? null : Math.round(v * 10) / 10, meal: e.meal });
  }
  function amountOf(st) {
    const v = num(st.value);
    if (v == null || v <= 0) return null;
    if (st.mode === 'servings') return { servings: v };
    if (st.mode === 'package') return { packages: v };
    if (st.mode === 'weight') return us() ? { oz: v } : { grams: v };
    return us() ? { flOz: v } : { ml: v };
  }
  const eaten = (st) => { const a = amountOf(st); return a ? D.nutrientsEaten(st.prod, a) : { ok: false, error: 'noAmount' }; };
  function amountLabel(e) {
    const a = e.amount || {};
    if (e.manual) return '';
    const inner = e.qty != null ? ` (${qty(e.qty, e.unit)})` : '';
    if (a.servings != null) return `${fmt(a.servings, 2)} ${t('amtServingWord')}${inner}`;
    if (a.packages != null) return `${fmt(a.packages, 2)} ${t('amtPackageWord')}${inner}`;
    return qty(e.qty, e.unit);
  }
  function previewHtml(st) {
    const r = eaten(st);
    if (!r.ok) return `<p class="err">${h(t('err_' + r.error))}</p>`;
    const n = r.nutrients;
    const cell = (k, v) => `<div><span>${h(t(k))}</span><b>${v}</b></div>`;
    return `<div class="amt-kcal"><span>${h(t('ateThisAmount'))}</span><b class="amt-kcal-n">${kcal(n.kcal)}</b></div>
      <div class="amt-grid">${cell('tProtein', gr(n.protein))}${cell('tCarbs', gr(n.carbs))}${cell('tFat', gr(n.fat))}${cell('n_sugars', gr(n.sugars))}${cell('tSatFat', gr(n.satFat))}${cell('tFiber', gr(n.fiber))}${cell('tSodium', gr(n.sodiumMg, 'mg'))}</div>
      ${r.notes && r.notes.length ? `<p class="muted small">${r.notes.map((x) => h(L(x))).join(' ')}</p>` : ''}`;
  }
  function pickerInner(st, saveKey) {
    const unitLabel = { servings: t('amtServingWord'), package: t('amtPackageWord'), weight: us() ? 'oz' : 'g', volume: us() ? 'fl oz' : 'ml' }[st.mode];
    const sv = D.servingOf(st.prod), pk = D.packageOf(st.prod);
    const hint = st.mode === 'servings' && sv ? t('amtServingOf', { q: qty(sv.qty, sv.unit) }) : st.mode === 'package' && pk ? t('amtPackageOf', { q: qty(pk.qty, pk.unit) }) : '';
    const modeLabel = { servings: t('amtServings'), weight: `${t('amtWeight')} (${us() ? 'oz' : 'g'})`, volume: `${t('amtVolume')} (${us() ? 'fl oz' : 'ml'})`, package: t('amtPackage') };
    return `${segL('amtmode', st.modes.map((m) => [m, modeLabel[m]]), st.mode, 'amt-modes')}
      <div class="amt-row"><button type="button" class="amt-step" data-d="-1" aria-label="−">−</button>
        <span class="num-in"><input class="amt-val" type="number" inputmode="decimal" step="any" min="0" value="${h(st.value ?? '')}"><span class="unit">${h(unitLabel)}</span></span>
        <button type="button" class="amt-step" data-d="1" aria-label="+">+</button></div>
      ${hint ? `<p class="muted small amt-hint">${h(hint)}</p>` : ''}
      <div class="fld"><span class="fld-l">${h(t('ateMeal'))}</span>${segL('meal', D.MEALS.map((m) => [m, L(D.MEAL_NAMES[m])]), st.meal, 'meal-seg')}</div>
      <div class="amt-preview" aria-live="polite">${previewHtml(st)}</div>
      <div class="amt-actions"><button type="button" class="link amt-cancel">${h(t('ateCancel'))}</button><button type="button" class="big primary amt-save">${h(t(saveKey))}</button></div>`;
  }
  function wirePicker(box, st, saveKey, onSave, onCancel) {
    const redraw = () => { box.innerHTML = pickerInner(st, saveKey); wirePicker(box, st, saveKey, onSave, onCancel); };
    const prev = () => { box.querySelector('.amt-preview').innerHTML = previewHtml(st); };
    box.querySelectorAll('.seg[data-group=amtmode] .seg-opt').forEach((b) => { b.onclick = () => { st.mode = b.dataset.v; st.value = defVal(st.mode); redraw(); }; });
    box.querySelectorAll('.seg[data-group=meal] .seg-opt').forEach((b) => {
      b.onclick = () => { st.meal = b.dataset.v; box.querySelectorAll('.seg[data-group=meal] .seg-opt').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); }); };
    });
    const inp = box.querySelector('.amt-val');
    inp.oninput = () => { st.value = inp.value; prev(); };
    box.querySelectorAll('.amt-step').forEach((b) => {
      b.onclick = () => { const v = Math.max(0, Math.round(((num(st.value) || 0) + Number(b.dataset.d) * stepOf(st.mode)) * 100) / 100); st.value = v; inp.value = v; prev(); };
    });
    box.querySelector('.amt-save').onclick = () => {
      const r = eaten(st);
      if (!r.ok) { prev(); return; }
      onSave(r, amountOf(st));
    };
    box.querySelector('.amt-cancel').onclick = onCancel;
  }

  // "I ate this" card on a food result. src = {key (the result object), name, code, product | photo}
  let ate = { key: null };
  function ateCard(src) {
    if (ate.key !== src.key) ate = { key: src.key, src, prod: src.product ? snapshot(src.product) : productFromPhoto(src.photo), open: false, st: null, added: null };
    if (ate.st && ate.st.units !== ctx.units()) ate.st = null;   // units switched: start the amount again in the new units
    return `<section class="card ate" id="ateCard">${ateInner()}</section>`;
  }
  function ateInner() {
    const known = D.nutrientsEaten(ate.prod, { grams: 100 }).nutrients;
    const hasNumbers = (known && known.kcal != null) || D.nutrientsEaten(ate.prod, { servings: 1 }).ok;
    let out = ate.added ? `<div class="banner ok" id="ateAdded">✓ ${h(ate.added)} <button type="button" class="link" id="ateSeeToday">${h(t('ateSeeToday'))}</button></div>` : '';
    if (!hasNumbers) return out + `<p class="muted" id="ateNoNumbers">${h(t('ateNoNumbers'))}</p>`;
    if (!ate.open || !ate.st) return out + `<button type="button" class="big primary" id="ateBtn">${h(t('ateBtn'))}</button>`;
    return out + `<h2>🍽 ${h(t('ateHead'))}</h2><div class="amt" id="atePick">${pickerInner(ate.st, 'ateSave')}</div>`;
  }
  function wireAte() {
    const card = $('ateCard');
    if (!card) return;
    const redraw = () => { card.innerHTML = ateInner(); wireAte(); };
    const b = $('ateBtn'); if (b) b.onclick = () => { ate.open = true; ate.added = null; ate.st = newPicker(ate.prod); redraw(); };
    const see = $('ateSeeToday'); if (see) see.onclick = openToday;
    const pick = $('atePick');
    if (pick) {
      wirePicker(pick, ate.st, 'ateSave', (r, amount) => {
        const e = { id: newId(), meal: ate.st.meal, name: ate.src.name || '', code: ate.src.code || '', amount, qty: r.qty, unit: r.unit, nutrients: r.nutrients, prod: ate.prod, t: Date.now() };
        if (!addEntries(localIso(), [e])) { saveFail(); return; }
        ate.open = false; ate.st = null;
        ate.added = t('ateAdded', { day: t('todayTitle'), what: `${amountLabel(e)} · ${kcal(e.nutrients.kcal)}` });
        window.__lastAte = e;
        redraw(); renderHomeBar();
      }, () => { ate.open = false; ate.st = null; redraw(); });
    }
  }

  // ================================================================= 3. TODAY
  let day = null;
  let todayUi = { mode: null, id: null, st: null };   // mode: 'manual' (add/edit a hand entry) | 'edit' (amount of a logged food)
  let undo = null;
  function homeBarText() {
    const c = compute();
    if (!c) return { text: t('todayBarNoProfile'), pct: null };
    const tot = D.dayTotals(dayEntries(localIso())).day.total.kcal || 0;
    if (!c.dailyKcal) return { text: t('todayBarNoTarget', { eaten: fmt(tot) }), pct: null };
    const left = c.dailyKcal - tot;
    return { text: left >= 0 ? t('todayBarSet', { eaten: fmt(tot), target: fmt(c.dailyKcal), left: fmt(left) }) : t('todayBarOver', { eaten: fmt(tot), target: fmt(c.dailyKcal), over: fmt(-left) }),
      pct: Math.min(100, (tot / c.dailyKcal) * 100), over: left < 0 };
  }
  function renderHomeBar() {
    const el = $('todayBar');
    if (!el) return;
    const b = homeBarText();
    el.innerHTML = `<span class="tb-text">${h(b.text)}</span>${b.pct != null ? `<span class="tb-track"><span class="tb-fill${b.over ? ' over' : ''}" style="width:${b.pct}%"></span></span>` : ''}`;
    el.onclick = profGet() ? openToday : openProfile;
  }
  function ring(eatenK, target) {
    const r = 66, C = 2 * Math.PI * r;
    const frac = target ? Math.min(1, (eatenK || 0) / target) : 0;
    const over = target && eatenK > target;
    return `<svg class="ring" viewBox="0 0 170 170" role="img" aria-label="${h(`${fmt(eatenK || 0)} / ${target ? fmt(target) : '—'} kcal`)}">
      <circle cx="85" cy="85" r="${r}" class="ring-bg"/>
      <circle cx="85" cy="85" r="${r}" class="ring-fg${over ? ' over' : ''}" stroke-dasharray="${(frac * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 85 85)"/>
      <text x="85" y="84" text-anchor="middle" class="ring-n" id="ringEaten">${fmt(eatenK || 0)}</text>
      <text x="85" y="110" text-anchor="middle" class="ring-s">${h(target ? t('kcalOf', { n: fmt(target) }) : 'kcal')}</text></svg>`;
  }
  function nutBars(dayT, targets) {
    const tot = dayT.total, miss = dayT.missing || {};
    const bar = (id, label, eatenV, goalText, pct, status, unit, partial) => `<div class="nb" id="${id}"><div class="nb-top"><span>${h(label)}</span>
        <span><b>${gr(eatenV, unit)}</b> ${goalText}${partial ? ` <span class="muted small">${h(t('nutPartial', { n: partial }))}</span>` : ''}</span></div>
        <div class="nb-track"><span class="nb-fill ${status}" style="width:${pct == null ? 0 : Math.min(100, pct)}%"></span></div></div>`;
    if (!targets) {
      return ['protein', 'carbs', 'fat', 'fiber', 'sugars', 'sodiumMg'].map((k) => bar(`nb_${k}`, t({ protein: 'tProtein', carbs: 'tCarbs', fat: 'tFat', fiber: 'tFiber', sugars: 'n_sugars', sodiumMg: 'tSodium' }[k]), tot[k], '', null, 'none', k === 'sodiumMg' ? 'mg' : 'g', miss[k])).join('');
    }
    const rv = D.remainingVsTargets(dayT, targets);
    const st = (r) => (r.status === 'over' ? 'over' : r.status === 'ok' ? 'ok' : r.status === 'unknown' ? 'none' : 'under');
    const lim = (id, key, r, unit, kind) => bar(id, t(key), r.eaten, `/ ${h(t(kind === 'min' ? 'tAtLeast' : 'tAtMost'))} ${gr(r.goal, unit)}`, r.eaten == null ? null : (r.eaten / r.goal) * 100, st(r), unit, r.partial ? miss[id.slice(3)] || '' : 0);
    const range = (id, key, k, rg) => bar(id, t(key), tot[k], `/ ${h(t('tAim'))} ${gr(rg[0])}–${gr(rg[1])}`, tot[k] == null ? null : (tot[k] / rg[1]) * 100, tot[k] == null ? 'none' : tot[k] > rg[1] ? 'over' : tot[k] >= rg[0] ? 'ok' : 'under', 'g', miss[k]);
    return lim('nb_protein', 'tProtein', rv.protein, 'g', 'min') + range('nb_carbs', 'tCarbs', 'carbs', targets.carbsG) + range('nb_fat', 'tFat', 'fat', targets.fatG)
      + lim('nb_fiber', 'tFiber', rv.fiber, 'g', 'min') + lim('nb_sugars', rv.sugar.usedTotalSugars ? 'tSugarTotal' : 'tSugar', rv.sugar, 'g', 'max')
      + lim('nb_satFat', 'tSatFat', rv.satFat, 'g', 'max') + lim('nb_sodiumMg', 'tSodium', rv.sodiumMg, 'mg', 'max');
  }
  function manualForm(e) {
    const n = (e && e.nutrients) || {};
    const v = (x) => (x == null ? '' : inputVal(x));
    return `<section class="card form" id="manualCard"><h2>${h(t('addManual'))}</h2>
      <label class="fld"><span class="fld-l">${h(t('manualName'))}</span><input id="mName" type="text" autocomplete="off" value="${h(e ? e.name : '')}"></label>
      <label class="fld"><span class="fld-l">${h(t('manualKcal'))}</span><span class="num-in"><input id="mKcal" type="number" inputmode="decimal" min="0" step="any" value="${v(n.kcal)}"><span class="unit">kcal</span></span></label>
      <p class="muted small">${h(t('manualOptional'))}:</p>
      <div class="num-trio">${[['mProt', 'tProtein', n.protein], ['mCarb', 'tCarbs', n.carbs], ['mFat', 'tFat', n.fat]].map(([id, k, x]) => `<label class="fld"><span class="fld-l">${h(t(k))}</span><span class="num-in"><input id="${id}" type="number" inputmode="decimal" min="0" step="any" value="${v(x)}"><span class="unit">g</span></span></label>`).join('')}</div>
      <div class="fld"><span class="fld-l">${h(t('ateMeal'))}</span>${segL('mmeal', D.MEALS.map((m) => [m, L(D.MEAL_NAMES[m])]), e ? e.meal : mealNow(), 'meal-seg')}</div>
      <p class="err" id="mErr" hidden>${h(t('manualNeed'))}</p>
      <div class="amt-actions"><button type="button" class="link" id="mCancel">${h(t('ateCancel'))}</button><button type="button" class="big primary" id="mSave">${h(t(e ? 'ateSaveEdit' : 'ateSave'))}</button></div></section>`;
  }
  function renderToday() {
    const c = compute();
    const today = localIso();
    if (!day) day = today;
    const entries = dayEntries(day);
    const tot = D.dayTotals(entries);
    const target = c ? c.dailyKcal : null;
    const eatenK = tot.day.total.kcal;
    const left = target != null ? target - (eatenK || 0) : null;
    const dayName = day === today ? `${t('todayTitle')}, ${dateLabel(day, { day: 'numeric', month: 'short' })}` : dateLabel(day);
    const meals = D.MEALS.map((m) => {
      const list = entries.filter((e) => (D.MEALS.includes(e.meal) ? e.meal : 'snacks') === m);
      const items = list.map((e) => {
        let li = `<li class="entry" data-id="${h(e.id)}"><div class="entry-main"><b class="entry-name">${h(e.name || '—')}</b>${amountLabel(e) ? `<small>${h(amountLabel(e))}</small>` : ''}</div>
          <span class="entry-kcal">${kcal(e.nutrients && e.nutrients.kcal)}</span>
          <button type="button" class="icon-btn entry-edit" aria-label="${h(t('entryEdit'))}" title="${h(t('entryEdit'))}">✎</button>
          <button type="button" class="icon-btn entry-del" aria-label="${h(t('entryDelete'))}" title="${h(t('entryDelete'))}">🗑</button></li>`;
        if (todayUi.mode === 'edit' && todayUi.id === e.id) li += `<li class="entry-editbox"><div class="amt" id="editPick">${pickerInner(todayUi.st, 'ateSaveEdit')}</div></li>`;
        if (todayUi.mode === 'manual' && todayUi.id === e.id) li += `<li class="entry-editbox">${manualForm(e)}</li>`;
        return li;
      }).join('');
      return `<section class="card meal" id="meal_${m}"><div class="meal-head"><h3>${h(L(D.MEAL_NAMES[m]))}</h3><span>${list.length ? kcal(tot.byMeal[m].total.kcal) : ''}</span></div>
        <ul class="entries">${items || `<li class="empty">${h(t('mealEmpty'))}</li>`}</ul></section>`;
    }).join('');
    $('today').innerHTML = `${backBtn('todayBack')}
      <div class="day-nav"><button type="button" class="icon-btn" id="dayPrev" aria-label="${h(t('dayPrev'))}">‹</button><h2 id="dayName">${h(dayName)}</h2>
        <button type="button" class="icon-btn" id="dayNext" aria-label="${h(t('dayNext'))}"${day >= today ? ' disabled' : ''}>›</button></div>
      ${undo ? `<div class="banner info" id="undoBar">🗑 ${h(undo.e.name || '')} <button type="button" class="link" id="undoBtn">${h(t('undo'))}</button></div>` : ''}
      <section class="card today-top">${ring(eatenK, target)}
        <div class="today-left" id="todayLeft">${left == null ? `<button type="button" class="link" id="needProf">${h(t('needProfile'))}</button>` : `<b class="${left < 0 ? 'over' : ''}">${h(left >= 0 ? t('kcalLeft', { n: fmt(left) }) : t('kcalOver', { n: fmt(-left) }))}</b>`}</div>
        ${tot.day.missing.kcal ? `<p class="muted small" id="kcalMissing">${h(t('kcalMissing', { n: tot.day.missing.kcal }))}</p>` : ''}
        <div class="nbars" id="nutBars">${nutBars(tot.day, c && c.targets)}</div></section>
      <button type="button" class="big secondary" id="todayScan">${h(t('todayScan'))}</button>
      ${todayUi.mode === 'manual' && !todayUi.id ? manualForm(null) : `<button type="button" class="big secondary" id="addManual">${h(t('addManual'))}</button>`}
      ${meals}
      <div class="tr-links"><button type="button" class="set-row" id="goPlan">${h(t('goPlan'))}</button><button type="button" class="set-row" id="goWeight">${h(t('goWeight'))}</button><button type="button" class="set-row" id="goProfile">${h(t('goProfile'))}</button></div>`;
    $('todayBack').onclick = ctx.goHome;
    $('dayPrev').onclick = () => { day = D.addDays(day, -1); todayUi = { mode: null }; undo = null; renderToday(); };
    $('dayNext').onclick = () => { if (day < today) { day = D.addDays(day, 1); todayUi = { mode: null }; undo = null; renderToday(); } };
    $('todayScan').onclick = () => ctx.startScanner();
    const am = $('addManual'); if (am) am.onclick = () => { todayUi = { mode: 'manual', id: null }; renderToday(); $('mName').focus(); };
    const np = $('needProf'); if (np) np.onclick = openProfile;
    $('goPlan').onclick = openPlan; $('goWeight').onclick = openWeight; $('goProfile').onclick = openProfile;
    const ub = $('undoBtn'); if (ub) ub.onclick = () => { const list = dayEntries(undo.date); list.splice(Math.min(undo.i, list.length), 0, undo.e); saveDay(undo.date, list); undo = null; renderToday(); renderHomeBar(); };
    $('today').querySelectorAll('.entry').forEach((li) => {
      const e = entries.find((x) => x.id === li.dataset.id);
      li.querySelector('.entry-del').onclick = () => {
        const list = dayEntries(day); const i = list.findIndex((x) => x.id === e.id);
        if (i < 0) return;
        list.splice(i, 1); saveDay(day, list); undo = { date: day, e, i }; todayUi = { mode: null }; renderToday(); renderHomeBar();
      };
      li.querySelector('.entry-edit').onclick = () => {
        todayUi = e.manual || !e.prod ? { mode: 'manual', id: e.id } : { mode: 'edit', id: e.id, st: pickerFromEntry(e) };
        renderToday();
      };
    });
    const ep = $('editPick');
    if (ep) {
      wirePicker(ep, todayUi.st, 'ateSaveEdit', (r, amount) => {
        const list = dayEntries(day); const i = list.findIndex((x) => x.id === todayUi.id);
        if (i >= 0) { list[i] = { ...list[i], meal: todayUi.st.meal, amount, qty: r.qty, unit: r.unit, nutrients: r.nutrients }; if (!saveDay(day, list)) saveFail(); }
        todayUi = { mode: null }; renderToday(); renderHomeBar();
      }, () => { todayUi = { mode: null }; renderToday(); });
    }
    if ($('manualCard')) {
      let meal = todayUi.id ? (entries.find((x) => x.id === todayUi.id) || {}).meal || mealNow() : mealNow();
      $('manualCard').querySelectorAll('.seg[data-group=mmeal] .seg-opt').forEach((b) => {
        b.onclick = () => { meal = b.dataset.v; $('manualCard').querySelectorAll('.seg[data-group=mmeal] .seg-opt').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); }); };
      });
      $('mCancel').onclick = () => { todayUi = { mode: null }; renderToday(); };
      $('mSave').onclick = () => {
        const name = $('mName').value.trim(), k = num($('mKcal').value);
        if (!name || k == null || k < 0) { $('mErr').hidden = false; return; }
        const nutrients = Object.fromEntries(D.NUTRIENTS.map((x) => [x, null]));
        Object.assign(nutrients, { kcal: k, protein: num($('mProt').value), carbs: num($('mCarb').value), fat: num($('mFat').value) });
        const list = dayEntries(day);
        const i = todayUi.id ? list.findIndex((x) => x.id === todayUi.id) : -1;
        const e = { ...(i >= 0 ? list[i] : { id: newId(), t: Date.now() }), manual: true, name, meal, amount: null, qty: null, unit: null, nutrients };
        if (i >= 0) list[i] = e; else list.push(e);
        if (!saveDay(day, list)) { saveFail(); return; }
        todayUi = { mode: null }; renderToday(); renderHomeBar();
      };
    }
  }

  // ================================================================= 4. WEIGH-INS + adaptive target
  let wMsg = '';
  function adaptiveEstimate(c) {
    const all = logAll(), today = localIso();
    const wmap = Object.fromEntries(weights().map((w) => [w.date, w.kg]));
    const dates = new Set([...Object.keys(all), ...Object.keys(wmap)]);
    // today's food is still being logged, so it never counts as a full day of intake
    const log = [...dates].map((d) => ({ date: d, kcal: d !== today && all[d] && all[d].length ? D.dayTotals(all[d]).day.total.kcal : null, weightKg: wmap[d] ?? null }));
    return D.estimateTdee(log, { profile: c && c.profile && !c.errors ? c.profile : null, currentTargetKcal: c ? c.dailyKcal : null, goalRateKgPerWeek: c ? c.goalRate : null });
  }
  function renderWeight() {
    const ws = weights(), c = compute(), today = localIso();
    let chart = `<p class="muted">${h(t('wChartNeed2'))}</p>`;
    if (ws.length >= 2) {
      const start = ws[0].date, x = (d) => D.daysBetween(start, d);
      const trend = D.ewmaTrend(ws.map((w) => ({ date: w.date, weightKg: w.kg })));
      chart = lineChart({ id: 'wChart', title: t('wChart'), startDate: start, days: x(ws[ws.length - 1].date), lines: [{ pts: trend.map((p) => [x(p.date), wtVal(p.trendKg)]), cls: 'trend' }],
        dots: ws.map((w) => [x(w.date), wtVal(w.kg)]), hline: c && c.g && c.g.mode === 'target' && c.g.targetKg ? { y: wtVal(c.g.targetKg), label: `${t('gTargetKg')} ${wt(c.g.targetKg)}` } : null })
        + `<p class="muted small">${h(t('wChart'))}</p>`;
    }
    const est = adaptiveEstimate(c);
    let ad = `<section class="card" id="adaptive"><h2>🔥 ${h(t('adHead'))}</h2>`;
    if (!est.ok) ad += `<p>${h(t('adProgress', { food: est.intakeDays || 0, w: est.weighIns || 0, span: est.spanDays || 0 }))}</p>`;
    else {
      ad += `<p class="tr-big-p" id="adResult">${h(t('adResult', { kcal: fmt(est.tdeeKcal), lo: fmt(est.rangeKcal[0]), hi: fmt(est.rangeKcal[1]) }))}</p>
        <p class="muted small">${h(t('adDetail', { intake: fmt(est.meanIntakeKcal), rate: `${est.kgPerWeek > 0 ? '+' : ''}${fmt(wtVal(est.kgPerWeek), 2)} ${wUnit()}`, conf: t('adConf_' + est.confidence) }))}</p>`;
      if (est.suggestedKcal != null && c && c.dailyKcal != null && est.suggestedKcal !== c.dailyKcal) ad += `<div class="tr-big main"><span class="tr-big-l">${h(t('adSuggest', { kcal: fmt(est.suggestedKcal) }))}</span></div><button type="button" class="big primary" id="adApply">${h(t('adApply'))}</button>`;
    }
    ad += msgList(est.messages) + '</section>';
    window.__adaptive = est;
    $('weight').innerHTML = `${backBtn('wBack')}<h2 class="rk-title">⚖ ${h(t('wTitle'))}</h2>
      <section class="card form" id="wForm"><h2>${h(t('wLog'))}</h2>
        <label class="fld"><span class="fld-l">${h(t('pWeight'))}</span><span class="num-in"><input id="wVal" type="number" inputmode="decimal" min="0" step="any" value="${h(inputVal(wtVal(currentKg())))}"><span class="unit">${wUnit()}</span></span></label>
        <label class="fld"><span class="fld-l">${h(t('wDate'))}</span><input id="wDate" type="date" max="${today}" value="${today}"></label>
        <p class="err" id="wErr" hidden>${h(t('wBad'))}</p>
        <button type="button" class="big primary" id="wSave">${h(t('wSave'))}</button>
        ${wMsg ? `<div class="banner ok" id="wMsg">${h(wMsg)}</div>` : ''}</section>
      <section class="card" id="wChartCard"><h2>📈 ${h(t('wChart'))}</h2>${chart}</section>
      ${ad}
      <section class="card"><h2>${h(t('wHistory'))}</h2>${ws.length ? `<ul class="entries" id="wList">${[...ws].reverse().map((w, i, arr) => {
        const prev = arr[i + 1]; const d = prev ? w.kg - prev.kg : null;
        return `<li class="entry" data-date="${w.date}"><div class="entry-main"><b>${h(wt(w.kg))}</b><small>${h(dateLabel(w.date))}</small></div>
          <span class="entry-kcal muted">${d == null ? '' : `${d > 0 ? '+' : ''}${fmt(wtVal(d), 1)} ${wUnit()}`}</span>
          <button type="button" class="icon-btn w-del" aria-label="${h(t('entryDelete'))}">🗑</button></li>`;
      }).join('')}</ul>` : `<p class="muted">${h(t('wNone'))}</p>`}</section>
      ${disclaimer()}`;
    wMsg = '';
    $('wBack').onclick = ctx.goHome;
    $('wSave').onclick = () => {
      const kg = wtIn($('wVal').value), date = $('wDate').value || today;
      if (kg == null || kg < 25 || kg > 350 || date > today) { $('wErr').hidden = false; return; }
      if (!saveWeight(date, kg)) { saveFail(); return; }
      const c2 = compute();   // re-plan from the (new) current weight
      wMsg = c2 && c2.dailyKcal != null ? t('wSaved', { kcal: fmt(c2.dailyKcal) }) : t('wSavedNoPlan');
      renderWeight(); renderHomeBar();
    };
    const ap = $('adApply'); if (ap) ap.onclick = () => { if (write(K.override, { kcal: est.suggestedKcal, date: today })) { wMsg = t('adApplied'); renderWeight(); renderHomeBar(); } };
    $('weight').querySelectorAll('.w-del').forEach((b) => {
      b.onclick = () => { const d = b.closest('li').dataset.date; write(K.weights, weights().filter((w) => w.date !== d)); renderWeight(); renderHomeBar(); };
    });
  }

  // ================================================================= 5. PLAN MY DAY
  let planMsg = '';
  function planInputs() {
    const products = [], missing = [];
    for (const x of ctx.histGet()) {
      if ((x.type || 'food') !== 'food' || !x.code) continue;
      const pr = ctx.productFor(x.code);
      if (!pr) { missing.push(x); continue; }
      products.push({ ...snapshot(pr), code: x.code, name: x.name || pr.product_name || x.code, categories_tags: pr.categories_tags || [], score: x.score, ecs: x.ecs, type: 'food', ...(x.alg ? { alg: x.alg } : {}) });
    }
    return { products, missing };
  }
  function renderPlan() {
    const c = compute();
    let body = '';
    let res = null, products = [];
    if (!c || !c.targets) body = `<section class="card"><p>${h(t('needProfile'))}</p><button type="button" class="big primary" id="planProf">${h(t('goProfile'))}</button></section>`;
    else {
      const inp = planInputs(); products = inp.products;
      res = D.buildMealPlan({ products, targets: c.targets, allergens: ctx.algGet() });
      window.__plan = res;
      const T = c.targets;
      body += `<p class="muted small">${h(t('planIntro'))} ${h(t('planFoods', { n: products.length }))}${inp.missing.length ? ` ${h(t('planNoData', { n: inp.missing.length }))}` : ''}</p>`;
      if (res.ok) {
        body += D.MEALS.filter((m) => res.meals[m].length).map((m) => `<section class="card meal"><div class="meal-head"><h3>${h(L(D.MEAL_NAMES[m]))}</h3><span>${kcal(res.meals[m].reduce((s, x) => s + x.kcal, 0))}</span></div>
          <ul class="entries">${res.meals[m].map((it) => `<li class="entry"><div class="entry-main"><b>${h(it.name || it.id)}</b><small>${h(it.amount.servings != null ? `${fmt(it.amount.servings, 1)} ${t('amtServingWord')} (${qty(it.qty, it.unit)})` : qty(it.qty, it.unit))} · ${h(t('tProtein'))} ${gr(it.protein)}</small></div><span class="entry-kcal">${kcal(it.kcal)}</span></li>`).join('')}</ul></section>`).join('');
        const s = res.summary;
        const row = (label, v, goal) => `<tr><td>${h(label)}</td><td><b>${v}</b> <span class="muted">${goal}</span></td></tr>`;
        body += `<section class="card" id="planTotals"><h2>${h(t('planTotals'))}</h2><table class="tr-kv">
          ${row('kcal', kcal(s.kcal), `/ ${kcal(T.kcal)}`)}${row(t('tProtein'), gr(s.protein), `/ ${gr(T.proteinG[0])}–${gr(T.proteinG[1])}`)}
          ${row(t('tFiber'), gr(s.fiber), `/ ${h(t('tAtLeast'))} ${gr(T.fiberMinG)}`)}${row(t('tSugar'), gr(s.sugarForLimit), `/ ${h(t('tAtMost'))} ${gr(T.addedSugarMaxG)}`)}
          ${row(t('tSatFat'), gr(s.satFat), `/ ${h(t('tAtMost'))} ${gr(T.satFatMaxG)}`)}${row(t('tSodium'), gr(s.sodiumMg, 'mg'), `/ ${h(t('tAtMost'))} ${gr(T.sodiumMaxMg, 'mg')}`)}</table>
          ${msgList((res.softWarnings || []).map((w) => ({ ...w, kind: 'warn' })))}
          <button type="button" class="big primary" id="planAdd">${h(t('planAddAll'))}</button>${planMsg ? `<div class="banner ok" id="planMsg">${h(planMsg)} <button type="button" class="link" id="planSeeToday">${h(t('ateSeeToday'))}</button></div>` : ''}</section>`;
      } else {
        body += `<section class="card msg warn" id="planFail"><h2>${h(t('planCant'))}</h2><p><b>${h(L(res.message))}</b></p>
          ${res.summary ? `<p class="muted">${h(t('planClosest', { kcal: fmt(res.summary.kcal), protein: fmt(res.summary.protein), score: fmt(res.summary.avgScore) }))}</p>` : ''}
          <p class="plate">🍽 ${h(L(res.guidance))}</p></section>`;
      }
      if (res.excluded && res.excluded.length) body += `<details class="card" id="planExcluded"><summary>${h(t('planLeftOut'))} (${res.excluded.length})</summary><ul>${res.excluded.map((x) => `<li>${h(x.name || x.id)} — ${h(L(x.why))}</li>`).join('')}</ul></details>`;
    }
    $('plan').innerHTML = `${backBtn('planBack')}<h2 class="rk-title">📋 ${h(t('planTitle'))}</h2><div id="planResult">${body}</div>${disclaimer()}`;
    planMsg = '';
    $('planBack').onclick = ctx.goHome;
    const pp = $('planProf'); if (pp) pp.onclick = openProfile;
    const st = $('planSeeToday'); if (st) st.onclick = openToday;
    const pa = $('planAdd');
    if (pa) pa.onclick = () => {
      const byId = Object.fromEntries(products.map((p) => [String(p.code), p]));
      const list = [];
      for (const m of D.MEALS) for (const it of res.meals[m]) {
        const prod = byId[it.id];
        const r = prod && D.nutrientsEaten(prod, it.amount);
        if (r && r.ok) list.push({ id: newId(), meal: m, name: it.name || '', code: it.id, amount: it.amount, qty: r.qty, unit: r.unit, nutrients: r.nutrients, prod: snapshot(prod), t: Date.now() });
      }
      if (!addEntries(localIso(), list)) { saveFail(); return; }
      planMsg = t('planAdded', { n: list.length });
      renderPlan(); renderHomeBar();
    };
  }

  return {
    ateCard, wireAte, renderHomeBar, compute, openProfile,
    resetAte: () => { ate = { key: null }; },
    onRender() {   // language or units changed: redraw whatever tracker screen is showing
      renderHomeBar();
      if (!$('profile').hidden) renderProfile();
      if (!$('today').hidden) renderToday();
      if (!$('weight').hidden) renderWeight();
      if (!$('plan').hidden) renderPlan();
    },
  };
}
