// Food Score — WEEKLY MEAL PLAN screen. The planning (foods, portions, budget, exercise, checkbox store) is
// mealplan.js; the calorie target comes from the user's saved goal via tracker.js compute() -> diet.js.
// Stored on THIS phone only (localStorage):
//   fs_mealplan       the current plan: its id, start date, the choices AND the goal numbers it was made from
//                     (so it stays the same plan all week; "Make a new plan" picks up a changed goal)
//   fs_mealplan_prefs the last choices (budget, foods, styles), to pre-fill the form
//   fs_mp_checks      every tick, per plan id and per date — a new plan never wipes old ticks
// Allergies are always read LIVE from "My allergies": adding one later removes that food from this plan too.
import * as M from './mealplan.js';
import * as D from './diet.js';

const K = { plan: 'fs_mealplan', prefs: 'fs_mealplan_prefs' };
const read = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch { return def; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const localIso = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const MEAL_KEY = { breakfast: 'mpBreakfast', lunch: 'mpLunch', dinner: 'mpDinner', snack: 'mpSnack' };
const MEAL_ICON = { breakfast: '🍳', lunch: '🥪', dinner: '🍽', snack: '🍎' };

export function initMealPlan(ctx) {
  const { $, t, L, h } = ctx;
  const checks = M.checkStore(localStorage);
  const loc = () => (ctx.lang() === 'vi' ? 'vi-VN' : 'en-US');
  const n0 = (v) => Math.round(v).toLocaleString(loc());
  const money = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateLabel = (iso, o) => new Date(`${iso}T12:00:00`).toLocaleDateString(loc(), o);
  let ui = { mode: null, day: null, form: null, err: '' };

  // ------------------------------------------------------------------ the goal numbers (diet.js, through tracker.js)
  function goalNow() {
    const c = ctx.compute();
    if (!c || c.errors) return { c, ok: false };
    if (!c.elig.ok) return { c, ok: false, stop: c.plan.reasons };
    if (!c.dailyKcal || !c.targets) return { c, ok: false };
    return { c, ok: true, snap: { profile: c.profile, dailyKcal: c.dailyKcal, proteinG: c.targets.proteinG, mode: c.plan.mode || 'maintain', tdeeKcal: c.plan.tdeeKcal || null, rate: c.goalRate } };
  }
  const prefs = () => ({ budget: 70, likes: M.CAT_IDS.slice(), styles: [], ...read(K.prefs, {}) });
  function build(saved) {
    const s = saved.snap;
    return M.makeWeekPlan({ profile: s.profile, dailyKcal: s.dailyKcal, proteinG: s.proteinG, mode: s.mode, tdeeKcal: s.tdeeKcal, rateKgPerWeek: s.rate,
      budget: saved.inputs.budget, likes: saved.inputs.likes, styles: saved.inputs.styles, allergens: ctx.algGet(), startDate: saved.start });
  }
  function makeNew(inputs) {
    const g = goalNow();
    if (!g.ok) return false;
    const saved = { id: `mp${Date.now().toString(36)}`, created: Date.now(), start: localIso(), inputs, snap: g.snap };
    if (!write(K.plan, saved) || !write(K.prefs, inputs)) { alert(t('mpSaveFail')); return false; }
    return true;
  }

  // ------------------------------------------------------------------ navigation
  const show = () => { ctx.showOnly('mealplan'); render(); };
  ctx.SCREENS.mealplan = show;
  const open = () => { ui = { mode: null, day: null, form: null, err: '' }; ctx.navTo('mealplan', true); show(); };
  ctx.SETTINGS_ROWS.push({ id: 'setMealPlan', icon: '🛒', key: 'mpSetRow', open, sub: () => t('mpSetRowSub') });

  // ------------------------------------------------------------------ pieces
  const msgs = (list, id = '') => (list && list.length ? `<ul class="tr-msgs"${id ? ` id="${id}"` : ''}>${list.map((m) => `<li class="tr-msg ${m.kind || 'info'}">${h(L(m))}</li>`).join('')}</ul>` : '');
  const goalLine = (snap) => t(snap.mode === 'lose' ? 'mpGoalLose' : snap.mode === 'gain' ? 'mpGoalGain' : 'mpGoalKeep', { kcal: n0(snap.dailyKcal) });
  const algLine = () => {
    const a = ctx.algGet().map((id) => ctx.allergenName(id)).filter(Boolean);
    return `<p class="mp-alg" id="mpAlg">${h(a.length ? t('mpAlgSome', { list: a.join(', ') }) : t('mpAlgNone'))}</p><button type="button" class="link mp-link" id="mpAlgEdit">${h(t('mpAlgEdit'))} ›</button>`;
  };
  // the tick box + title is ONE big tap target; the details under it are not (no accidental ticks while reading)
  const tick = (key, on, label, extra = '', id = '') => `<div class="mp-task${on ? ' done' : ''}"${id ? ` id="${id}"` : ''}><label class="mp-task-head"><input type="checkbox" class="mp-cb" data-k="${h(key)}"${on ? ' checked' : ''}><span class="mp-task-title">${label}</span></label>${extra ? `<div class="mp-task-detail">${extra}</div>` : ''}</div>`;

  // ------------------------------------------------------------------ FORM (budget, foods, styles)
  function renderForm(g) {
    const saved = read(K.plan, null);
    const f = ui.form || (ui.form = { ...(saved ? saved.inputs : prefs()), other: '' });
    if (!M.BUDGETS.some((b) => b.usd === f.budget) && !f.other) f.other = String(f.budget);
    const budgetBtns = M.BUDGETS.map((b) => `<button type="button" class="mp-bud${!f.other && f.budget === b.usd ? ' active' : ''}" data-usd="${b.usd}" aria-pressed="${!f.other && f.budget === b.usd}"><b>${h(L(b.name))}</b><span>~$${b.usd}</span></button>`).join('');
    const box = (group, id, icon, name, on) => `<label class="mp-opt${on ? ' on' : ''}"><input type="checkbox" data-group="${group}" value="${id}"${on ? ' checked' : ''}><span class="mp-ico">${icon}</span><span>${h(L(name))}</span></label>`;
    return `<section class="card mp-goal" id="mpGoal"><p class="mp-goal-line"><b>${h(goalLine(g.snap))}</b></p><p class="muted small">${h(t('mpGoalFrom'))}</p>
        <button type="button" class="big secondary mp-mid" id="mpGoalBtn">${h(t('mpChangeGoal'))}</button></section>
      <section class="card form" id="mpForm">
        <h3 class="set-h">${h(t('mpBudget'))}</h3>
        <div class="mp-buds" role="group">${budgetBtns}</div>
        <label class="mp-other"><span>${h(t('mpBudgetOther'))}</span><input id="mpOther" type="number" inputmode="decimal" min="10" max="1000" step="1" value="${h(f.other)}"></label>
        <h3 class="set-h">${h(t('mpLikes'))}</h3>
        <div class="mp-allnone"><button type="button" class="link" id="mpAllBtn">${h(t('mpAll'))}</button><button type="button" class="link" id="mpNoneBtn">${h(t('mpNone'))}</button></div>
        <div class="mp-grid" id="mpLikes">${M.CATS.map((c) => box('likes', c.id, c.icon, c.name, f.likes.includes(c.id))).join('')}</div>
        <h3 class="set-h">${h(t('mpStyles'))}</h3>
        <div class="mp-grid one" id="mpStyles">${M.STYLES.map((s) => box('styles', s.id, s.icon, s.name, f.styles.includes(s.id))).join('')}</div>
        ${algLine()}
        <p class="err" id="mpErr"${ui.err ? '' : ' hidden'}>${h(ui.err)}</p>
        <button type="button" class="big primary" id="mpMake">${h(t('mpMake'))}</button>
      </section>`;
  }
  function wireForm() {
    const f = ui.form;
    $('mpGoalBtn').onclick = ctx.openProfile;
    $('mealplan').querySelectorAll('.mp-bud').forEach((b) => { b.onclick = () => { f.budget = Number(b.dataset.usd); f.other = ''; ui.err = ''; render(); }; });
    $('mpOther').oninput = (e) => { f.other = e.target.value; $('mealplan').querySelectorAll('.mp-bud').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); }); };
    $('mealplan').querySelectorAll('.mp-opt input').forEach((cb) => {
      cb.onchange = () => {
        const list = f[cb.dataset.group];
        f[cb.dataset.group] = cb.checked ? [...new Set([...list, cb.value])] : list.filter((x) => x !== cb.value);
        cb.closest('.mp-opt').classList.toggle('on', cb.checked);
      };
    });
    $('mpAllBtn').onclick = () => { f.likes = M.CAT_IDS.slice(); render(); };
    $('mpNoneBtn').onclick = () => { f.likes = []; render(); };
    $('mpAlgEdit').onclick = ctx.openAllergies;
    $('mpMake').onclick = () => {
      let budget = f.budget;
      if (String(f.other).trim() !== '') { budget = Number(String(f.other).replace(',', '.')); if (!(budget >= 10 && budget <= 1000)) { ui.err = t('mpNeedBudget'); render(); $('mpErr').scrollIntoView({ block: 'center' }); return; } }
      if (!f.likes.length) { ui.err = t('mpNeedLikes'); render(); $('mpErr').scrollIntoView({ block: 'center' }); return; }
      ui.err = '';
      if (makeNew({ budget: Math.round(budget * 100) / 100, likes: f.likes, styles: f.styles })) { ui = { mode: 'plan', day: null, form: null, err: '' }; render(); window.scrollTo(0, 0); }
    };
  }

  // ------------------------------------------------------------------ PLAN (summary, day checklist, shopping list)
  function exerciseText(plan, i) {
    const ex = plan.exercise, kcal = n0(plan.kcal);
    let s = `<b>${h(t('mpWalk', { min: ex.walkMin, steps: n0(ex.steps) }))}</b><small>${h(t('mpWalkPace'))}</small>`;
    if (ex.startLow) s += `<small>${h(t('mpBuildUp', { min: ex.goalMin }))}</small>`;
    if (ex.strengthDays.includes(i)) s += `<span class="mp-moves"><b>💪 ${h(t('mpStrength', { min: ex.strengthMin }))}</b><ul>${ex.moves.map((m) => `<li>${h(L(M.MOVES[m]))}</li>`).join('')}</ul></span>`;
    if (ex.balanceDays.includes(i)) s += `<span class="mp-moves"><b>🧍 ${h(t('mpBalance'))}</b><ul><li>${h(L(M.MOVES.balance))}</li></ul></span>`;
    const burn = ex.walkKcal + (ex.strengthDays.includes(i) ? ex.strengthKcal : 0);
    const why = plan.mode === 'gain' ? t('mpExGain', { kcal }) : ex.bonus ? t('mpExBonus', { kcal }) : t('mpExCounted', { kcal });
    return `${s}<small class="mp-why" id="mpExWhy">${h(t('mpExKcal', { kcal: n0(burn) }))} ${h(why)}</small>`;
  }
  function renderPlanView(saved, g) {
    const plan = build(saved);
    window.__mealPlan = plan;   // for automated checks
    if (!plan.ok) return `${msgs(plan.stop, 'mpStop')}<button type="button" class="big secondary" id="mpEditBtn">${h(t('mpEdit'))}</button>`;
    const ticks = checks.all(saved.id);
    const today = localIso();
    const dayIdx = Math.max(0, Math.min(6, D.daysBetween(saved.start, today)));
    const i = ui.day != null ? ui.day : dayIdx;
    const day = plan.days[i];
    let out = '';
    if (D.daysBetween(saved.start, today) > 6) out += `<div class="banner warn" id="mpWeekOver">${h(t('mpWeekOver'))}</div>`;
    if (g.ok && Math.abs(g.snap.dailyKcal - saved.snap.dailyKcal) >= 10) out += `<div class="banner warn" id="mpStaleBar">${h(t('mpStale', { kcal: n0(g.snap.dailyKcal) }))} <button type="button" class="link" id="mpStaleNew">${h(t('mpNewPlan'))}</button></div>`;
    // summary
    out += `<section class="card mp-sum" id="mpSummary">
      <p class="mp-goal-line"><b>${h(goalLine({ ...saved.snap, dailyKcal: plan.kcal }))}</b></p>
      <p>${h(t('mpProtein', { g: plan.protein.min }))}</p>
      <p class="mp-cost ${plan.overBudget ? 'over' : 'ok'}" id="mpCost"><b>${h(t('mpCost', { cost: money(plan.weekCost) }))}</b> · ${h(t('mpOfBudget', { budget: money(plan.budget) }))}<br><b>${h(t(plan.overBudget ? 'mpOver' : 'mpUnder'))}</b></p>
      <p class="muted small">${h(t('mpCheckout', { cost: money(plan.checkoutCost) }))} ${h(t('mpPrices'))}</p></section>`;
    out += msgs([...plan.notes.filter((n) => n.kind !== 'info'), ...plan.notes.filter((n) => n.kind === 'info')], 'mpNotes');
    if (plan.suggestions.length) {
      out += `<section class="card" id="mpSuggest"><h3>${h(t('mpTryAdd'))}</h3>${plan.suggestions.map((s) => {
        const c = M.CATS.find((x) => x.id === s.cat);
        const why = s.fixesCalories ? t('mpSugCal') : s.fixesProtein ? t('mpSugProt') : t('mpSugCost', { cost: money(s.weekCost) });
        return `<button type="button" class="set-row mp-sug" data-cat="${s.cat}"><span class="set-ico">${c.icon}</span><span class="set-text"><b>＋ ${h(L(c.name))}</b><small>${h(why)}</small></span><span class="set-go">›</span></button>`;
      }).join('')}</section>`;
    }
    // day picker
    out += `<div class="mp-days" role="tablist" id="mpDays">${plan.days.map((d, k) => {
      const p = M.dayProgress(ticks, d.date);
      return `<button type="button" class="mp-day${k === i ? ' active' : ''}${d.date === today ? ' today' : ''}" data-i="${k}" aria-pressed="${k === i}"><b>${h(dateLabel(d.date, { weekday: 'short' }))}</b><span>${h(dateLabel(d.date, { day: 'numeric' }))}</span><small>${p.done}/${p.total}</small></button>`;
    }).join('')}</div>`;
    // the day's checklist
    const prog = M.dayProgress(ticks, day.date);
    const tasks = M.PLAN_MEALS.map((m) => {
      const items = day.meals[m];
      const kc = items.reduce((s, x) => s + x.kcal, 0), pr = items.reduce((s, x) => s + x.protein, 0);
      const head = `<b>${MEAL_ICON[m]} ${h(t(MEAL_KEY[m]))}</b><small>${h(items.length ? t('mpMealSum', { kcal: n0(kc), p: n0(pr) }) : '')}</small>`;
      const list = items.length ? `<ul class="mp-items">${items.map((x) => `<li><span class="mp-food">${h(L(x.name))}</span><span class="mp-amt">${h(L(x.portion))} · ${n0(x.kcal)} kcal</span></li>`).join('')}</ul>` : `<p class="muted small">${h(t('mpEmptyMeal'))}</p>`;
      return tick(M.dayKey(day.date, m), !!ticks[M.dayKey(day.date, m)], head, list, `mpTask_${m}`);
    }).join('');
    const ex = tick(M.dayKey(day.date, 'exercise'), !!ticks[M.dayKey(day.date, 'exercise')], `<b>🚶 ${h(t('mpExercise'))}</b>`, `<span class="mp-ex">${exerciseText(plan, i)}</span>`, 'mpTask_exercise');
    const liters = Math.round(plan.water * 0.2366 * 10) / 10;
    const water = tick(M.dayKey(day.date, 'water'), !!ticks[M.dayKey(day.date, 'water')], `<b>💧 ${h(t('mpWater'))}</b>`, `<small>${h(t('mpWaterText', { cups: plan.water, l: liters.toLocaleString(loc()) }))}</small>`, 'mpTask_water');
    out += `<section class="card mp-daycard" id="mpDay"><h2 id="mpDayName">${h(dateLabel(day.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</h2>
      <div class="mp-prog"><span id="mpProgText">${h(t('mpDayDone', { done: prog.done, total: prog.total }))}</span><span class="tb-track"><span class="tb-fill" style="width:${(prog.done / prog.total) * 100}%"></span></span></div>
      <p class="muted small" id="mpDayTotal">${h(t('mpMealSum', { kcal: n0(day.kcal), p: n0(day.protein) }))}</p>
      ${tasks}${ex}${water}<p class="muted small">${h(t('mpExSource'))}</p></section>`;
    // shopping list
    const shopDone = plan.shopping.filter((s) => ticks[M.shopKey(s.id)]).length;
    out += `<section class="card mp-shop" id="mpShop"><h2>${h(t('mpShopTitle'))}</h2>
      <div class="mp-prog"><span id="mpShopProg">${h(t('mpShopDone', { done: shopDone, total: plan.shopping.length }))}</span><span class="tb-track"><span class="tb-fill" style="width:${plan.shopping.length ? (shopDone / plan.shopping.length) * 100 : 0}%"></span></span></div>
      ${plan.shopping.map((s) => tick(M.shopKey(s.id), !!ticks[M.shopKey(s.id)], `<b>${h(L(s.buy))} — ${h(L(s.name))}</b>`,
        `<small>$${money(s.checkout)}${s.keeps ? ` · ${h(t('mpShopKeeps', { cost: money(s.week) }))}` : ''}</small>`, `mpShop_${s.id}`)).join('')}
      <p class="mp-total" id="mpShopTotal"><b>${h(t('mpShopTotal', { cost: money(plan.checkoutCost) }))}</b><br>${h(t('mpCost', { cost: money(plan.weekCost) }))} · ${h(t('mpOfBudget', { budget: money(plan.budget) }))}</p>
      <p class="muted small">${h(t('mpPrices'))}</p></section>`;
    out += `<button type="button" class="big primary" id="mpNewBtn">${h(t('mpNewPlan'))}</button>
      <button type="button" class="big secondary" id="mpEditBtn">${h(t('mpEdit'))}</button>
      <p class="muted small">${h(t('mpOldKept'))}</p>
      <details class="card" id="mpHow"><summary>${h(t('mpHowTitle'))}</summary><p>${h(t('mpHow'))}</p></details>`;
    return out;
  }
  function wirePlan(saved) {
    const root = $('mealplan');
    root.querySelectorAll('.mp-cb').forEach((cb) => {
      cb.onchange = () => {
        if (!checks.set(saved.id, cb.dataset.k, cb.checked)) { alert(t('mpSaveFail')); cb.checked = !cb.checked; return; }
        const y = window.scrollY; render(); window.scrollTo(0, y);
      };
    });
    root.querySelectorAll('.mp-day').forEach((b) => { b.onclick = () => { ui.day = Number(b.dataset.i); render(); const d = $('mpDay'); if (d) d.scrollIntoView({ block: 'start' }); }; });
    root.querySelectorAll('.mp-sug').forEach((b) => {
      b.onclick = () => { const inp = { ...saved.inputs, likes: [...new Set([...saved.inputs.likes, b.dataset.cat])] }; if (makeNew(inp)) { ui.day = null; render(); window.scrollTo(0, 0); } };
    });
    const remake = () => { if (makeNew(saved.inputs)) { ui.day = null; render(); window.scrollTo(0, 0); } };
    const nb = $('mpNewBtn'); if (nb) nb.onclick = remake;
    const sn = $('mpStaleNew'); if (sn) sn.onclick = remake;
    const eb = $('mpEditBtn'); if (eb) eb.onclick = () => { ui.mode = 'form'; ui.form = null; render(); window.scrollTo(0, 0); };
  }

  // ------------------------------------------------------------------ the screen
  function render() {
    const g = goalNow();
    const saved = read(K.plan, null);
    let body;
    if (!g.ok && !(saved && saved.snap)) {
      body = g.stop ? `${msgs(g.stop, 'mpStop')}<button type="button" class="big secondary" id="mpSetGoal">${h(t('mpChangeGoal'))}</button>`
        : `<section class="card" id="mpNeedGoal"><p>${h(t('mpNeedGoal'))}</p><button type="button" class="big primary" id="mpSetGoal">${h(t('mpSetGoal'))}</button></section>`;
    } else if (g.stop) {
      body = `${msgs(g.stop, 'mpStop')}<button type="button" class="big secondary" id="mpSetGoal">${h(t('mpChangeGoal'))}</button>`;   // under 18 / pregnant now: no plan is shown
    } else if (ui.mode === 'form' || !saved) {
      body = g.ok ? renderForm(g) : `<section class="card" id="mpNeedGoal"><p>${h(t('mpNeedGoal'))}</p><button type="button" class="big primary" id="mpSetGoal">${h(t('mpSetGoal'))}</button></section>`;
    } else body = renderPlanView(saved, g);
    $('mealplan').innerHTML = `<button type="button" class="link back" id="mpBack">${h(t('camBack'))}</button>
      <h2 class="rk-title">🛒 ${h(t('mpTitle'))}</h2>${body}<p class="tr-disclaimer">ⓘ ${h(t('trDisclaimer'))}</p>`;
    $('mpBack').onclick = ctx.goHome;
    const sg = $('mpSetGoal'); if (sg) sg.onclick = ctx.openProfile;
    if ($('mpForm')) wireForm();
    else if (saved && $('mpDays')) wirePlan(saved);
    else { const eb = $('mpEditBtn'); if (eb) eb.onclick = () => { ui.mode = 'form'; ui.form = null; render(); }; }
  }

  return {
    open,
    onRender() { if (!$('mealplan').hidden) render(); },
  };
}
