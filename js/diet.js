// Food Score — DIET engine: calorie tracker + weight-goal planner. The science half only (no UI).
// Pure functions: no DOM, no network, no storage. All user data stays on the phone; this file never
// sends anything anywhere. Same style as web/js/engine.js: plain ES module, no dependencies, and every
// user-facing sentence is a {en, vi} pair the page picks from.
//
// Internally EVERYTHING is metric: kg, cm, g, ml, kcal. Convert at the edges with the unit helpers.
// Every formula carries its source in a comment; SCIENCE.md explains each one in plain English.

// ---------------------------------------------------------------------------------------------
// 1. Units — exact defined factors
// ---------------------------------------------------------------------------------------------
// International Yard and Pound Agreement (1959): 1 lb = 0.45359237 kg exactly, 1 in = 2.54 cm exactly.
// 1 avoirdupois oz = 1/16 lb = 28.349523125 g exactly. 1 US fl oz = 1/128 US gal = 29.5735295625 mL exactly
// (NIST Handbook 44, Appendix C). 1 kcal (thermochemical) = 4.184 kJ exactly — the factor food labels use
// (EU Reg. 1169/2011 Annex XIV; FAO Food and Nutrition Paper 77, 2003).
export const KG_PER_LB = 0.45359237;
export const CM_PER_IN = 2.54;
export const G_PER_OZ = 28.349523125;
export const ML_PER_FLOZ = 29.5735295625;
export const KJ_PER_KCAL = 4.184;

export const lbToKg = (lb) => lb * KG_PER_LB;
export const kgToLb = (kg) => kg / KG_PER_LB;
export const inToCm = (inch) => inch * CM_PER_IN;
export const cmToIn = (cm) => cm / CM_PER_IN;
export const ftInToCm = (ft, inch = 0) => (Number(ft) * 12 + Number(inch)) * CM_PER_IN;
// cm -> {ft, in} with inches rounded to `inDecimals` and carried so 5 ft 12 in never appears
export function cmToFtIn(cm, inDecimals = 0) {
  const k = 10 ** inDecimals;
  let total = Math.round(cmToIn(cm) * k) / k;
  let ft = Math.floor(total / 12);
  let inch = Math.round((total - ft * 12) * k) / k;
  if (inch >= 12) { ft += 1; inch -= 12; }
  return { ft, in: inch };
}
export const ozToG = (oz) => oz * G_PER_OZ;
export const gToOz = (g) => g / G_PER_OZ;
export const flOzToMl = (floz) => floz * ML_PER_FLOZ;
export const mlToFlOz = (ml) => ml / ML_PER_FLOZ;
export const kcalToKj = (kcal) => kcal * KJ_PER_KCAL;
export const kjToKcal = (kj) => kj / KJ_PER_KCAL;

const round = (x, d = 0) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 10 ** d) / 10 ** d);
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------------------------
// Messages (every warning the planner can return). kind: stop | warn | info
// ---------------------------------------------------------------------------------------------
export const MSG = {
  under18: { kind: 'stop', en: 'Weight plans here are for adults (18+). For anyone under 18, please talk to a pediatrician — growing bodies need a different approach.', vi: 'Kế hoạch cân nặng ở đây chỉ dành cho người lớn (từ 18 tuổi). Với người dưới 18 tuổi, hãy hỏi bác sĩ nhi khoa — cơ thể đang lớn cần cách làm khác.' },
  pregnant: { kind: 'stop', en: 'No calorie-cutting plan during pregnancy or breastfeeding. Your doctor or midwife will tell you how much to eat and gain.', vi: 'Không lập kế hoạch giảm calo khi đang mang thai hoặc cho con bú. Bác sĩ hoặc nữ hộ sinh sẽ hướng dẫn bạn nên ăn và tăng cân bao nhiêu.' },
  targetUnderweight: { kind: 'stop', en: 'That goal weight is underweight (BMI below 18.5). The planner will not aim below a healthy weight.', vi: 'Cân nặng mục tiêu đó là thiếu cân (BMI dưới 18,5). Ứng dụng sẽ không đặt mục tiêu thấp hơn cân nặng khỏe mạnh.' },
  missingProfile: { kind: 'stop', en: 'Please fill in age, height, weight and activity level first.', vi: 'Vui lòng nhập tuổi, chiều cao, cân nặng và mức vận động trước.' },
  outOfRange: { kind: 'stop', en: 'One of the numbers looks out of range — please check age, height and weight.', vi: 'Có một con số có vẻ không hợp lý — vui lòng kiểm tra lại tuổi, chiều cao và cân nặng.' },
  sexUnspecified: { kind: 'info', en: 'You chose not to say your sex, so the numbers use the average of the male and female equations. They may be off by about 80 kcal a day either way.', vi: 'Bạn chọn không nêu giới tính, nên các con số dùng trung bình của công thức nam và nữ. Có thể lệch khoảng 80 kcal mỗi ngày.' },
  rateCapped: { kind: 'warn', en: 'That date would mean losing more than 1% of your body weight a week, which costs muscle and is hard to keep. The plan uses a safer pace, so the date moved later.', vi: 'Ngày đó đòi hỏi giảm hơn 1% cân nặng mỗi tuần — dễ mất cơ và khó duy trì. Kế hoạch dùng tốc độ an toàn hơn nên ngày đạt mục tiêu lùi lại.' },
  gainRateCapped: { kind: 'warn', en: 'Gaining faster than about 0.5 kg (1 lb) a week mostly adds fat. The plan uses a slower pace, so the date moved later.', vi: 'Tăng nhanh hơn khoảng 0,5 kg (1 lb) mỗi tuần chủ yếu là tăng mỡ. Kế hoạch dùng tốc độ chậm hơn nên ngày đạt mục tiêu lùi lại.' },
  floorApplied: { kind: 'warn', en: 'Reaching the goal by that date would need fewer calories than is safe without a doctor. The plan keeps you at the safe minimum, so it takes longer.', vi: 'Để đạt mục tiêu đúng ngày đó cần ăn ít calo hơn mức an toàn khi không có bác sĩ theo dõi. Kế hoạch giữ ở mức tối thiểu an toàn nên sẽ lâu hơn.' },
  deficitCapped: { kind: 'warn', en: 'Reaching the goal by that date would mean eating more than 1,000 calories a day below what you burn. The plan keeps the gap at 1,000, so it takes longer.', vi: 'Để đạt mục tiêu đúng ngày đó phải ăn ít hơn mức đốt hơn 1.000 calo mỗi ngày. Kế hoạch giữ mức chênh ở 1.000 calo nên sẽ lâu hơn.' },
  nearFloor: { kind: 'warn', en: 'This is close to the minimum safe calories. Consider a slower pace — it is easier to keep up and protects muscle.', vi: 'Mức này gần với lượng calo tối thiểu an toàn. Hãy cân nhắc giảm chậm hơn — dễ duy trì hơn và giữ được cơ.' },
  surplusCapped: { kind: 'warn', en: 'The plan keeps the extra calories to about 500 a day so the weight you gain is not mostly fat. It takes a bit longer.', vi: 'Kế hoạch giới hạn lượng calo dư khoảng 500 mỗi ngày để phần cân tăng thêm không chủ yếu là mỡ. Sẽ lâu hơn một chút.' },
  notReachable: { kind: 'warn', en: 'At the safe minimum calories your weight levels off before the goal. Adding activity, or a doctor-supervised plan, can take you further.', vi: 'Ở mức calo tối thiểu an toàn, cân nặng của bạn sẽ chững lại trước khi tới mục tiêu. Tăng vận động, hoặc theo kế hoạch có bác sĩ giám sát, sẽ giúp đi xa hơn.' },
  tooLong: { kind: 'warn', en: 'At a safe pace this goal takes more than 5 years. Try a nearer goal first — even 5–10% of your weight brings real health benefits.', vi: 'Với tốc độ an toàn, mục tiêu này cần hơn 5 năm. Hãy thử một mục tiêu gần hơn trước — chỉ cần giảm 5–10% cân nặng đã có lợi rõ rệt cho sức khỏe.' },
  waterWeight: { kind: 'info', en: 'The first week or two usually drops faster — that is mostly water and stored carbs, not fat. Do not let it surprise you when it slows down.', vi: 'Một hai tuần đầu cân thường giảm nhanh hơn — chủ yếu là nước và đường dự trữ, không phải mỡ. Đừng ngạc nhiên khi sau đó chậm lại.' },
  plateau: { kind: 'info', en: 'Weight loss naturally slows over time because a lighter body burns less. The plan already includes that, so the date is realistic.', vi: 'Giảm cân tự nhiên chậm dần vì cơ thể nhẹ hơn thì đốt ít năng lượng hơn. Kế hoạch đã tính điều đó nên ngày dự kiến là thực tế.' },
  older: { kind: 'info', en: 'After 65, losing weight can also cost muscle and bone. Keep protein up, stay active, and check the plan with your doctor.', vi: 'Sau 65 tuổi, giảm cân có thể làm mất cơ và xương. Hãy ăn đủ đạm, vận động đều, và hỏi ý kiến bác sĩ về kế hoạch.' },
  bmiHigh: { kind: 'info', en: 'With a BMI of 40 or more, a doctor-supported plan works best and may include options this app cannot offer.', vi: 'Với BMI từ 40 trở lên, kế hoạch có bác sĩ hỗ trợ là tốt nhất và có thể có những lựa chọn mà ứng dụng này không có.' },
  gainAboveHealthy: { kind: 'warn', en: 'That goal is above the healthy BMI range. Check it with your doctor.', vi: 'Mục tiêu đó vượt khoảng BMI khỏe mạnh. Hãy hỏi ý kiến bác sĩ.' },
  lowLogging: { kind: 'warn', en: 'Some days have no food logged, so this estimate may be off. Logging every day makes it accurate.', vi: 'Có vài ngày chưa ghi món ăn nên ước tính này có thể lệch. Ghi đủ mỗi ngày sẽ giúp chính xác hơn.' },
  needMoreData: { kind: 'info', en: 'Keep logging food and weighing in for at least 2 weeks — then the app can learn how much you really burn.', vi: 'Hãy tiếp tục ghi món ăn và cân ít nhất 2 tuần — sau đó ứng dụng sẽ biết bạn thực sự đốt bao nhiêu năng lượng.' },
  lowConfidence: { kind: 'info', en: 'Not enough data yet to change your target safely. Keep logging.', vi: 'Chưa đủ dữ liệu để thay đổi mục tiêu một cách an toàn. Hãy tiếp tục ghi.' },
  assumedDensity: { kind: 'info', en: 'This label gives values per 100 ml; we treated 1 g as 1 ml.', vi: 'Nhãn ghi giá trị trên 100 ml; ứng dụng coi 1 g bằng 1 ml.' },
};

// ---------------------------------------------------------------------------------------------
// 2. Profile
// ---------------------------------------------------------------------------------------------
// Physical activity level = total daily energy ÷ resting energy. Ranges from FAO/WHO/UNU (2004) Human
// Energy Requirements, Table 4.1: sedentary/light 1.40–1.69, active/moderate 1.70–1.99, vigorous 2.00–2.40.
// (These are NOT the older 1.2/1.375/1.55 "Harris-Benedict multipliers" — those multiply BMR on a
// different scale.) People routinely over-rate their activity; the adaptive target (section 8) corrects it.
export const ACTIVITY = {
  sedentary: { pal: 1.40, en: 'Sedentary — desk job, little exercise', vi: 'Ít vận động — làm văn phòng, ít tập thể dục' },
  light: { pal: 1.55, en: 'Light — on your feet some, or light exercise 1–3 days/week', vi: 'Nhẹ — đi lại khá nhiều, hoặc tập nhẹ 1–3 ngày/tuần' },
  moderate: { pal: 1.75, en: 'Moderate — exercise 3–5 days/week', vi: 'Vừa — tập thể dục 3–5 ngày/tuần' },
  very: { pal: 1.95, en: 'Very active — hard exercise 6–7 days/week', vi: 'Rất năng động — tập nặng 6–7 ngày/tuần' },
  extra: { pal: 2.20, en: 'Extra active — physical job plus training', vi: 'Cực kỳ năng động — lao động chân tay và tập luyện' },
};
export const SEXES = ['male', 'female', 'unspecified'];
// share of the "female" equation: 1 female, 0 male, 0.5 = average of both (prefer not to say)
const femaleShare = (sex) => (sex === 'female' ? 1 : sex === 'male' ? 0 : 0.5);

// Accepts metric ({weightKg, heightCm}) or US ({units:'us', weightLb, heightFt, heightIn}) input.
// Returns {profile, errors[]} — profile is always metric.
export function normalizeProfile(input = {}) {
  const us = input.units === 'us';
  const weightKg = us ? (num(input.weightLb) == null ? null : lbToKg(num(input.weightLb))) : num(input.weightKg);
  const heightCm = us ? (num(input.heightFt) == null ? null : ftInToCm(num(input.heightFt), num(input.heightIn) || 0)) : num(input.heightCm);
  const sex = SEXES.includes(input.sex) ? input.sex : 'unspecified';
  const activity = ACTIVITY[input.activity] ? input.activity : null;
  const bf = num(input.bodyFatPct);
  const profile = {
    age: num(input.age), sex, heightCm, weightKg, activity, pal: activity ? ACTIVITY[activity].pal : null,
    bodyFatPct: bf != null && bf >= 3 && bf <= 70 ? bf : null,
    pregnant: !!input.pregnant, breastfeeding: !!input.breastfeeding,
    bmiScale: input.bmiScale === 'asian' ? 'asian' : 'who',
  };
  const errors = [];
  if ([profile.age, heightCm, weightKg].some((v) => v == null) || !activity) errors.push(MSG.missingProfile);
  else if (profile.age < 2 || profile.age > 120 || heightCm < 100 || heightCm > 250 || weightKg < 25 || weightKg > 350) errors.push(MSG.outOfRange);
  return { profile, errors };
}

// Adults only, and not while pregnant/breastfeeding. Returns {ok, reasons[]} (reasons are MSG entries).
export function planningEligibility(profile) {
  const reasons = [];
  if (profile.age != null && profile.age < 18) reasons.push(MSG.under18);
  if (profile.pregnant || profile.breastfeeding) reasons.push(MSG.pregnant);
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------
// BMI — WHO (2000) TRS 894 categories; optional Asian public-health action points from the WHO Expert
// Consultation, Lancet 2004;363:157–163 (action points 23 and 27.5, used here as the overweight / obesity
// labels). The 2004 consultation KEPT 18.5 as the underweight cut-off for Asian populations — only the
// upper cut-offs are lower, so the underweight line and the "no goal below 18.5" rule match on both scales.
// ---------------------------------------------------------------------------------------------
export const bmi = (weightKg, heightCm) => weightKg / (heightCm / 100) ** 2;
export const weightForBmi = (b, heightCm) => b * (heightCm / 100) ** 2;
export const MIN_TARGET_BMI = 18.5; // both scales (WHO 2000; WHO Expert Consultation 2004)
const BMI_CATS = {
  who: [
    [16, 'thin3', { en: 'Severely underweight', vi: 'Thiếu cân nặng' }],
    [17, 'thin2', { en: 'Moderately underweight', vi: 'Thiếu cân vừa' }],
    [18.5, 'thin1', { en: 'Underweight', vi: 'Thiếu cân' }],
    [25, 'normal', { en: 'Healthy weight', vi: 'Cân nặng khỏe mạnh' }],
    [30, 'over', { en: 'Overweight', vi: 'Thừa cân' }],
    [35, 'obese1', { en: 'Obesity class I', vi: 'Béo phì độ I' }],
    [40, 'obese2', { en: 'Obesity class II', vi: 'Béo phì độ II' }],
    [Infinity, 'obese3', { en: 'Obesity class III', vi: 'Béo phì độ III' }],
  ],
  asian: [
    [16, 'thin3', { en: 'Severely underweight', vi: 'Thiếu cân nặng' }],
    [17, 'thin2', { en: 'Moderately underweight', vi: 'Thiếu cân vừa' }],
    [18.5, 'thin1', { en: 'Underweight', vi: 'Thiếu cân' }],
    [23, 'normal', { en: 'Healthy weight (Asian cut-offs)', vi: 'Cân nặng khỏe mạnh (ngưỡng châu Á)' }],
    [27.5, 'over', { en: 'Overweight (Asian cut-off 23)', vi: 'Thừa cân (ngưỡng châu Á 23)' }],
    [Infinity, 'obese', { en: 'Obesity (Asian cut-off 27.5)', vi: 'Béo phì (ngưỡng châu Á 27,5)' }],
  ],
};
export const BMI_ASIAN_NOTE = { en: 'For people of Asian background, health risks such as diabetes start at a lower BMI. WHO suggests overweight from 23 and obesity from 27.5 instead of 25 and 30. Underweight stays below 18.5.', vi: 'Với người gốc châu Á, nguy cơ sức khỏe như tiểu đường bắt đầu ở BMI thấp hơn. WHO đề xuất thừa cân từ 23 và béo phì từ 27,5 thay vì 25 và 30. Thiếu cân vẫn là dưới 18,5.' };
export const BMI_LIMITS_NOTE = { en: 'BMI does not see muscle vs fat, and is less accurate for very muscular people, older adults and pregnancy.', vi: 'BMI không phân biệt cơ và mỡ, và kém chính xác với người nhiều cơ, người lớn tuổi và khi mang thai.' };
export function bmiCategory(b, scale = 'who') {
  const table = BMI_CATS[scale] || BMI_CATS.who;
  const row = table.find(([hi]) => b < hi);
  return { bmi: round(b, 1), id: row[1], label: row[2], scale: scale === 'asian' ? 'asian' : 'who', healthyMax: scale === 'asian' ? 23 : 25, notes: scale === 'asian' ? [BMI_ASIAN_NOTE, BMI_LIMITS_NOTE] : [BMI_LIMITS_NOTE] };
}
const healthyBmiMax = (scale) => (scale === 'asian' ? 23 : 25);

// ---------------------------------------------------------------------------------------------
// 3. Energy needs
// ---------------------------------------------------------------------------------------------
// Mifflin MD, St Jeor ST, et al. "A new predictive equation for resting energy expenditure in healthy
// individuals." Am J Clin Nutr 1990;51:241–247 — published form, kcal/day:
//     REE = 9.99·kg + 6.25·cm − 4.92·age + 166·male − 161
// (the popular rounded form 10/6.25/5/+5/−161 differs by ≤ ~3 kcal for typical adults).
// Frankenfield D, Roth-Yousey L, Compher C. J Am Diet Assoc 2005;105:775–789 (ADA Evidence Analysis
// systematic review): Mifflin-St Jeor was the most reliable, within ±10% of measured REE in more
// non-obese AND obese adults than any other equation. "Prefer not to say" = mean of both = −78.
export function mifflinStJeor({ weightKg, heightCm, age, sex }) {
  const s = femaleShare(sex);
  return 9.99 * weightKg + 6.25 * heightCm - 4.92 * age + 5 * (1 - s) - 161 * s;
}
// Katch-McArdle: REE = 370 + 21.6·fat-free mass (kg). McArdle WD, Katch FI, Katch VL. Exercise Physiology
// (textbook, all editions). Useful only with a decent body-fat measurement; home scales are noisy.
export const katchMcArdle = (weightKg, bodyFatPct) => 370 + 21.6 * weightKg * (1 - bodyFatPct / 100);

// TDEE = REE × PAL. Mifflin stays the primary REE (best validated, and the dynamic model below is
// calibrated on it); Katch-McArdle is reported alongside when body-fat % is known.
export function energyNeeds(profile) {
  const mifflin = mifflinStJeor(profile);
  const katch = profile.bodyFatPct != null ? katchMcArdle(profile.weightKg, profile.bodyFatPct) : null;
  const notes = [];
  if (profile.sex === 'unspecified') notes.push(MSG.sexUnspecified);
  return {
    ree: round(mifflin), mifflin: round(mifflin, 1), katchMcArdle: katch == null ? null : round(katch, 1),
    pal: profile.pal, tdee: round(mifflin * profile.pal), tdeeKatch: katch == null ? null : round(katch * profile.pal), notes,
  };
}

// ---------------------------------------------------------------------------------------------
// 4. Dynamic weight-change model — Hall KD, Sacks G, Chandramohan D, et al. "Quantification of the effect
// of energy imbalance on bodyweight." Lancet 2011;378:826–837 (the NIH Body Weight Planner model).
// Ported from the published supplementary equations as implemented in the MIT-licensed R package `bw`
// (Camacho-García-Formentí D, Zepeda-Tello R; Instituto Nacional de Salud Pública de México, CRAN),
// src/adult_weight.cpp — constants below are copied from it and match the Lancet appendix (kJ → kcal).
// Compartments: fat F, lean L, glycogen G (+2.7 g water/g → 3.7·G), extracellular fluid ECF, and adaptive
// thermogenesis AT. Body weight BW = F + L + ECF + 3.7·G. Fat/lean partition follows Forbes:
// L − L0 = 10.4·ln(F/F0) (Forbes GB, Ann N Y Acad Sci 2000;904:359–365).
// The static "3,500 kcal = 1 lb" rule (Wishnofsky 1958) ignores that a lighter body burns less, so it
// badly overestimates long-term loss (Hall, Int J Obes 2008;32:573–576; Thomas et al., Int J Obes
// 2013;37:1611–1613). It is exported only for comparison (naive3500RuleKg).
// ---------------------------------------------------------------------------------------------
const HALL = {
  rhoG: 4206.501,   // kcal/kg glycogen (17.6 MJ/kg)
  Na: 3220,         // mg sodium per L ECF
  zetaNa: 3000,     // mg/L/day sodium excretion sensitivity
  zetaCI: 4000,     // mg/day sodium excretion effect of carbohydrate
  rhoF: 9440.727,   // kcal/kg fat (39.5 MJ/kg)
  rhoL: 1816.444,   // kcal/kg lean (7.6 MJ/kg)
  gammaF: 3.107075, // kcal/kg/day fat maintenance (13 kJ)
  gammaL: 21.98853, // kcal/kg/day lean maintenance (92 kJ)
  etaF: 179.2543,   // kcal/kg fat synthesis/breakdown cost (750 kJ)
  etaL: 229.4455,   // kcal/kg lean synthesis/breakdown cost (960 kJ)
  betaTEF: 0.1,     // thermic effect of feeding, fraction of intake change
  betaAT: 0.14,     // adaptive thermogenesis, fraction of intake change
  tauAT: 14,        // days
  G0: 0.5,          // kg baseline glycogen
};
HALL.C = 10.4 * (HALL.rhoL / HALL.rhoF);
HALL.alfa1 = -(1 + HALL.etaL / HALL.rhoL) * HALL.C;
HALL.alfa2 = -(1 + HALL.etaF / HALL.rhoF);
export const HALL_CONSTANTS = Object.freeze({ ...HALL });

// Baseline: the person is assumed weight-stable at intake EI0 = REE(Mifflin) × PAL (Hall, personal
// communication quoted in `bw`). Baseline fat (no body-fat % given): Hall 2011 appendix regression on
// Jackson et al., Int J Obes 2002;26:789–796 —
//   men   %fat = 0.14·age + 37.31·ln(BMI) − 103.94
//   women %fat = 0.14·age + 39.96·ln(BMI) − 102.01
// Baseline ECF: Silva et al. equations as used in the Hall 2011 appendix / `bw`.
export function bodyModel(profile, { carbFraction = 0.5 } = {}) {
  const s = femaleShare(profile.sex);
  const ht = profile.heightCm / 100, bw = profile.weightKg, age = profile.age, pal = profile.pal;
  const rmr = mifflinStJeor(profile);
  const EI0 = rmr * pal;
  const ecf0 = (0.025 * age + 9.57 * ht + 0.191 * bw - 12.4) * (1 - s) + (-4.0 + 5.98 * ht + 0.167 * bw) * s;
  const b = bw / ht ** 2;
  const fatPct = profile.bodyFatPct != null ? profile.bodyFatPct
    : (0.14 * age + 37.31 * Math.log(b) - 103.94) * (1 - s) + (0.14 * age + 39.96 * Math.log(b) - 102.01) * s;
  const fat0 = bw * clamp(fatPct, 3, 70) / 100;
  const lean0 = bw - (ecf0 + fat0 + 3.7 * HALL.G0);
  const delta = ((1 - HALL.betaTEF) * pal - 1) * rmr / bw; // physical-activity cost per kg
  const K = EI0 - HALL.gammaL * lean0 - HALL.gammaF * fat0 - delta * bw;
  const CIb = carbFraction * EI0;
  const kG = CIb / HALL.G0 ** 2;
  return { profile, rmr, EI0, ecf0, fat0, lean0, delta, K, carbFraction, CIb, kG, heightM: ht };
}
const fatFromLean = (m, L) => m.fat0 * Math.exp((L - m.lean0) / 10.4); // = F0·exp(ρL(L−L0)/(ρF·C))

// y = [AT, ECF, G, L]; EI = total daily intake (kcal)
function derivs(m, y, EI) {
  const [AT, ECF, G, L] = y;
  const dEI = EI - m.EI0;
  const CI = m.carbFraction * EI;
  const dAT = (HALL.betaAT * dEI - AT) / HALL.tauAT;
  const dECF = m.CIb > 0 ? (0 - HALL.zetaNa * (ECF - m.ecf0) - HALL.zetaCI * (1 - CI / m.CIb)) / HALL.Na : 0;
  const dG = m.CIb > 0 ? (CI - m.kG * G * G) / HALL.rhoG : 0;
  const F = fatFromLean(m, L);
  const W = F + L + ECF + 3.7 * G;
  const R = (m.K + m.delta * W + HALL.betaTEF * dEI + AT - EI + HALL.rhoG * dG + HALL.gammaL * L + HALL.gammaF * F) / (HALL.alfa1 + HALL.alfa2 * F);
  return [dAT, dECF, dG, R * HALL.C / HALL.rhoL];
}
const initState = (m) => [0, m.ecf0, HALL.G0, m.lean0];
const stateWeight = (m, y) => { const F = fatFromLean(m, y[3]); return { weightKg: F + y[3] + y[1] + 3.7 * y[2], fatKg: F, leanKg: y[3] }; };
function rk4Step(m, y, EI, dt = 1) {
  const add = (a, b, k) => a.map((v, i) => v + k * b[i]);
  const k1 = derivs(m, y, EI);
  const k2 = derivs(m, add(y, k1, dt / 2), EI);
  const k3 = derivs(m, add(y, k2, dt / 2), EI);
  const k4 = derivs(m, add(y, k3, dt), EI);
  return y.map((v, i) => v + dt * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]) / 6);
}
// Simulate `days` days at constant intake (1-day RK4 steps, as in `bw`). onDay(day, state) is optional;
// return true from it to stop early.
function simulate(m, EI, days, onDay) {
  let y = initState(m);
  for (let d = 1; d <= days; d++) {
    y = rk4Step(m, y, EI);
    if (onDay && onDay(d, stateWeight(m, y))) return { day: d, y };
  }
  return { day: days, y };
}
const weightAfter = (m, EI, days) => stateWeight(m, simulate(m, EI, days).y).weightKg;

// Steady state at a constant intake (all derivatives zero, sodium unchanged): the weight you would
// eventually settle at. ECF and glycogen settle to their carb-dependent levels, AT = βAT·ΔEI.
export function equilibriumAt(m, EI) {
  const dEI = EI - m.EI0;
  const CI = m.carbFraction * EI;
  const ECF = m.CIb > 0 ? m.ecf0 - (HALL.zetaCI / HALL.zetaNa) * (1 - CI / m.CIb) : m.ecf0;
  const G = m.CIb > 0 ? HALL.G0 * Math.sqrt(Math.max(0, CI / m.CIb)) : HALL.G0;
  const g = (L) => { const F = fatFromLean(m, L); return m.K + m.delta * (F + L + ECF + 3.7 * G) + (HALL.betaTEF + HALL.betaAT) * dEI - EI + HALL.gammaL * L + HALL.gammaF * F; };
  let lo = 1, hi = 250; // g(L) increases with L
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (g(mid) > 0) hi = mid; else lo = mid; }
  const L = (lo + hi) / 2, F = fatFromLean(m, L);
  return { weightKg: F + L + ECF + 3.7 * G, fatKg: F, leanKg: L };
}
// Intake that holds a given weight forever (maintenance after reaching a goal).
export function maintenanceKcalAt(m, weightKg) {
  let lo = 300, hi = 8000;
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (equilibriumAt(m, mid).weightKg > weightKg) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
// Constant intake that lands exactly on targetKg after `days` days (weight at day N rises with intake).
function solveIntake(m, targetKg, days) {
  let lo = 0, hi = m.EI0 + 5000;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (weightAfter(m, mid, days) > targetKg) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}
// First day the weight crosses the target at constant intake (null if it never does within maxDays).
function reachDay(m, EI, targetKg, dir, maxDays) {
  let hit = null;
  simulate(m, EI, maxDays, (d, s) => { if (dir < 0 ? s.weightKg <= targetKg : s.weightKg >= targetKg) { hit = d; return true; } return false; });
  return hit;
}
// Static rule for comparison only: 3,500 kcal per lb ≈ 7,716 kcal per kg, never slowing down.
export const naive3500RuleKg = (dailyKcalChange, days) => (dailyKcalChange * days) / (3500 / KG_PER_LB);

// ---------------------------------------------------------------------------------------------
// Dates (plain 'YYYY-MM-DD' strings, UTC so time zones never shift a day)
// ---------------------------------------------------------------------------------------------
const toUtc = (iso) => { const [y, mo, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, mo - 1, d); };
export const addDays = (iso, n) => new Date(toUtc(iso) + n * 86400000).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);
const todayIso = () => new Date().toISOString().slice(0, 10);

function weeklyCurve(m, EI, days, startDate) {
  const pts = [{ week: 0, day: 0, date: startDate, ...rounded(stateWeight(m, initState(m))) }];
  const lastDay = days;
  simulate(m, EI, lastDay, (d, s) => {
    if (d % 7 === 0 || d === lastDay) pts.push({ week: round(d / 7, 1), day: d, date: addDays(startDate, d), ...rounded(s) });
    return false;
  });
  return pts;
}
const rounded = (s) => ({ weightKg: round(s.weightKg, 2), fatKg: round(s.fatKg, 2), leanKg: round(s.leanKg, 2) });

// Inverse direction: "if I eat X kcal a day, what happens to my weight?"
// Returns weekly points, the weight after `days`, the weight you would eventually settle at, and how long
// it takes to get half / 95% of the way there.
export function projectWeight({ profile, dailyKcal, days = 365, startDate = todayIso(), carbFraction = 0.5 }) {
  const m = bodyModel(profile, { carbFraction });
  const eq = equilibriumAt(m, dailyKcal);
  const total = eq.weightKg - profile.weightKg;
  let half = null, ninetyFive = null;
  if (Math.abs(total) > 0.05) {
    simulate(m, dailyKcal, 365 * 15, (d, s) => {
      const frac = (s.weightKg - profile.weightKg) / total;
      if (half == null && frac >= 0.5) half = d;
      if (ninetyFive == null && frac >= 0.95) { ninetyFive = d; return true; }
      return false;
    });
  }
  const weekly = weeklyCurve(m, dailyKcal, days, startDate);
  return {
    model: 'hall2011', dailyKcal, maintenanceKcal: round(m.EI0), weekly, finalKg: weekly[weekly.length - 1].weightKg,
    eventualKg: round(eq.weightKg, 2), daysToHalf: half, daysTo95: ninetyFive,
    naive3500Kg: round(profile.weightKg + naive3500RuleKg(dailyKcal - m.EI0, days), 2),
  };
}

// ---------------------------------------------------------------------------------------------
// 5. Planner + safety rails
// ---------------------------------------------------------------------------------------------
// Calorie floor: never below 1,200 kcal women / 1,500 kcal men (1,350 = the average, "prefer not to say")
// without medical supervision — the low ends of the deficit diets in the AHA/ACC/TOS 2013 Obesity Guideline
// (Jensen MD et al., Circulation 2014;129(25 Suppl 2):S102–S138: 1,200–1,500 kcal/d women, 1,500–1,800
// kcal/d men), also NIH/NHLBI "Aim for a Healthy Weight". No resting-energy floor: for people with severe
// obesity it sits far above those guideline diets and made reachable goals look impossible.
// Deficit cap: never more than 1,000 kcal/day below TDEE (NHLBI 1998: 500–1,000 kcal/day deficit).
// The intake is the HIGHEST of: what the (rate-capped) goal needs, the floor, and TDEE − 1,000.
// Rate cap: ≤ 1% of body weight per week (Helms ER et al., J Int Soc Sports Nutr 2014;11:20 — 0.5–1%/wk
// preserves lean mass); NHLBI 1998 Clinical Guidelines: 1–2 lb (0.5–0.9 kg)/week. Default loss pace 1 lb/wk.
// Gain: surplus capped at +500 kcal/day (a slow lean gain ≈ +250–500 kcal/day; Iraki J et al., Sports
// 2019;7:154), pace capped at 0.5 kg/week, default 0.25 kg/week.
export const SAFETY = { floorFemale: 1200, floorMale: 1500, floorUnspecified: 1350, maxDeficitKcal: 1000, nearFloorKcal: 100, maxLossPctPerWeek: 1, defaultLossKgPerWeek: KG_PER_LB, defaultGainKgPerWeek: 0.25, maxGainKgPerWeek: 0.5, maxSurplusKcal: 500, maxPlanDays: 365 * 5 };
export function calorieFloor(profile) {
  const sexFloor = profile.sex === 'female' ? SAFETY.floorFemale : profile.sex === 'male' ? SAFETY.floorMale : SAFETY.floorUnspecified;
  return sexFloor;
}

function refusal(reasons) { return { ok: false, reasons, warnings: [] }; }

// planToTarget: {profile, targetWeightKg, targetDate?, ratePerWeekKg?, startDate?, carbFraction?}
// ratePerWeekKg is a positive number (speed); direction comes from the target. targetDate wins over rate.
// Returns the daily calories for the change phase, the maintenance calories after, weekly projected
// weights, and the date the goal is reached — all from the Hall model, after the safety rails.
export function planToTarget({ profile, targetWeightKg, targetDate = null, ratePerWeekKg = null, startDate = todayIso(), carbFraction = 0.5 }) {
  const { profile: p, errors } = normalizeProfile(profile);
  if (errors.length) return refusal(errors);
  const elig = planningEligibility(p);
  if (!elig.ok) return refusal(elig.reasons);
  const target = num(targetWeightKg);
  if (target == null || target < 25 || target > 350) return refusal([MSG.outOfRange]);
  if (bmi(target, p.heightCm) < MIN_TARGET_BMI && target < p.weightKg + 0.01) {
    return { ...refusal([MSG.targetUnderweight]), minTargetKg: round(weightForBmi(MIN_TARGET_BMI, p.heightCm), 1) };
  }
  const warnings = [];
  if (p.sex === 'unspecified') warnings.push(MSG.sexUnspecified);
  if (p.age >= 65) warnings.push(MSG.older);
  if (bmi(p.weightKg, p.heightCm) >= 40) warnings.push(MSG.bmiHigh);
  const m = bodyModel(p, { carbFraction });
  const tdee = m.EI0;
  const diff = target - p.weightKg;
  const dir = Math.abs(diff) < 0.5 ? 0 : Math.sign(diff);
  const floor = calorieFloor(p);
  if (dir === 0) {
    return { ok: true, mode: 'maintain', dailyKcal: round(tdee, -1), maintenanceKcal: round(tdee, -1), tdeeKcal: round(tdee), floorKcal: floor, startDate, reachDate: startDate, days: 0, weekly: weeklyCurve(m, tdee, 0, startDate), warnings, model: 'hall2011' };
  }
  if (dir > 0 && bmi(target, p.heightCm) > healthyBmiMax(p.bmiScale)) warnings.push(MSG.gainAboveHealthy);

  // 1) how many days are we aiming for
  const maxRate = dir < 0 ? p.weightKg * SAFETY.maxLossPctPerWeek / 100 : SAFETY.maxGainKgPerWeek;
  let days;
  if (targetDate) days = Math.max(7, daysBetween(startDate, targetDate));
  else {
    const rate = num(ratePerWeekKg) != null && num(ratePerWeekKg) > 0 ? num(ratePerWeekKg) : (dir < 0 ? SAFETY.defaultLossKgPerWeek : SAFETY.defaultGainKgPerWeek);
    days = Math.ceil(Math.abs(diff) / rate * 7);
  }
  const minDays = Math.ceil(Math.abs(diff) / maxRate * 7);
  if (days < minDays) { days = minDays; warnings.push(dir < 0 ? MSG.rateCapped : MSG.gainRateCapped); }
  days = Math.min(days, SAFETY.maxPlanDays);

  // 2) the constant intake that gets there in `days`, then the rails
  let EI = solveIntake(m, target, days);
  const deficitMin = tdee - SAFETY.maxDeficitKcal;
  const lossMin = Math.max(floor, deficitMin);
  if (dir < 0 && EI < lossMin) { EI = lossMin; warnings.push(floor >= deficitMin ? MSG.floorApplied : MSG.deficitCapped); }
  if (dir > 0 && EI > tdee + SAFETY.maxSurplusKcal) { EI = tdee + SAFETY.maxSurplusKcal; warnings.push(MSG.surplusCapped); }
  // never round a deficit below the floor or a surplus above the cap
  let daily = round(EI, -1);
  if (dir < 0 && daily < lossMin) daily = Math.ceil(lossMin / 10) * 10;
  if (dir < 0 && daily - floor < SAFETY.nearFloorKcal) warnings.push(MSG.nearFloor);
  if (dir > 0 && daily > tdee + SAFETY.maxSurplusKcal) daily = Math.floor((tdee + SAFETY.maxSurplusKcal) / 10) * 10;

  // 3) project with the number we actually tell the user
  const reach = reachDay(m, daily, target, dir, SAFETY.maxPlanDays);
  const maintenance = maintenanceKcalAt(m, target);
  if (dir < 0) warnings.push(MSG.waterWeight, MSG.plateau);
  if (reach == null) {
    const eq = equilibriumAt(m, daily);
    // either weight levels off before the goal, or it gets there but only after the 5-year planning horizon
    warnings.push((dir < 0 ? eq.weightKg > target : eq.weightKg < target) ? MSG.notReachable : MSG.tooLong);
    return {
      ok: true, reached: false, mode: dir < 0 ? 'lose' : 'gain', dailyKcal: daily, maintenanceKcal: round(maintenance, -1), tdeeKcal: round(tdee), floorKcal: floor,
      changeKcal: round(daily - tdee), startDate, reachDate: null, days: null, plateauKg: round(eq.weightKg, 1),
      weekly: weeklyCurve(m, daily, 365, startDate), warnings, model: 'hall2011',
    };
  }
  return {
    ok: true, reached: true, mode: dir < 0 ? 'lose' : 'gain', dailyKcal: daily, maintenanceKcal: round(maintenance, -1), tdeeKcal: round(tdee), floorKcal: floor,
    changeKcal: round(daily - tdee), startDate, reachDate: addDays(startDate, reach), days: reach, weeks: round(reach / 7, 1),
    avgKgPerWeek: round(Math.abs(diff) / (reach / 7), 2),
    weekly: weeklyCurve(m, daily, reach, startDate), warnings, model: 'hall2011',
  };
}

// "Lose (or gain) X kg per week" with no particular goal weight: aims for X·weeks over `weeks` weeks
// (default 12) and returns the same shape as planToTarget. ratePerWeekKg < 0 = lose, > 0 = gain.
export function planByRate({ profile, ratePerWeekKg, weeks = 12, startDate = todayIso(), carbFraction = 0.5 }) {
  const { profile: p, errors } = normalizeProfile(profile);
  if (errors.length) return refusal(errors);
  const r = num(ratePerWeekKg) || 0;
  const target = p.weightKg + r * weeks;
  return planToTarget({ profile, targetWeightKg: target, targetDate: addDays(startDate, weeks * 7), startDate, carbFraction });
}

// ---------------------------------------------------------------------------------------------
// 6. Daily nutrition targets
// ---------------------------------------------------------------------------------------------
// Protein: RDA 0.8 g/kg/day is the floor (IOM DRI Macronutrients 2005). During an energy deficit
// 1.2–1.6 g/kg/day helps keep lean mass (Leidy HJ et al., Am J Clin Nutr 2015;101:1320S–1329S; ISSN
// position stand, Jäger R et al., J Int Soc Sports Nutr 2017;14:20). With BMI above the healthy range the
// g/kg is applied to the weight at the top of the healthy range (a reference weight), so a 130 kg person is
// not told to eat 200 g — a common clinical convention; see SCIENCE.md.
// Fiber 14 g per 1,000 kcal (DGA 2020–2025). Added sugars < 10% kcal (DGA 2020–2025; WHO 2015 sugars
// guideline). Saturated fat < 10% kcal (DGA). Sodium < 2,300 mg (DGA / NASEM 2019 CDRR). Fat 20–35% and
// carbohydrate 45–65% of energy, protein 10–35% (IOM AMDR 2005).
export function nutritionTargets({ profile, dailyKcal, phase = 'maintain' }) {
  const p = profile;
  const ref = Math.min(p.weightKg, weightForBmi(healthyBmiMax(p.bmiScale || 'who'), p.heightCm));
  const per = phase === 'lose' ? [1.2, 1.6] : phase === 'gain' ? [1.2, 1.6] : [0.8, 1.2];
  const maxProteinG = 0.35 * dailyKcal / 4;
  return {
    kcal: dailyKcal,
    proteinMinG: round(0.8 * ref),
    proteinG: [round(Math.min(per[0] * ref, maxProteinG)), round(Math.min(per[1] * ref, maxProteinG))],
    proteinRefKg: round(ref, 1),
    fiberMinG: round(14 * dailyKcal / 1000),
    addedSugarMaxG: round(0.10 * dailyKcal / 4),
    satFatMaxG: round(0.10 * dailyKcal / 9),
    sodiumMaxMg: 2300,
    fatG: [round(0.20 * dailyKcal / 9), round(0.35 * dailyKcal / 9)],
    carbsG: [round(0.45 * dailyKcal / 4), round(0.65 * dailyKcal / 4)],
  };
}

// ---------------------------------------------------------------------------------------------
// 7. Food log math (Open Food Facts products)
// ---------------------------------------------------------------------------------------------
export const NUTRIENTS = ['kcal', 'protein', 'carbs', 'sugars', 'addedSugars', 'fat', 'satFat', 'fiber', 'sodiumMg'];
const OFF_KEY = { protein: 'proteins', carbs: 'carbohydrates', sugars: 'sugars', addedSugars: 'added-sugars', fat: 'fat', satFat: 'saturated-fat', fiber: 'fiber' };

// One basis (`_100g` or `_serving`) -> our nutrients. Missing stays null — NEVER 0.
// Energy: kcal field, else kJ ÷ 4.184 (OFF's bare `energy_*` is kJ). Sodium in mg: sodium (g) × 1000,
// else salt ÷ 2.5 (EU Reg. 1169/2011 Annex I: salt = sodium × 2.5).
function readBasis(nm, suffix) {
  const out = { kcalFromKj: false };
  let kcal = num(nm[`energy-kcal${suffix}`]);
  if (kcal == null) {
    const kj = num(nm[`energy-kj${suffix}`]) ?? num(nm[`energy${suffix}`]);
    if (kj != null) { kcal = kj / KJ_PER_KCAL; out.kcalFromKj = true; }
  }
  out.kcal = kcal;
  for (const [k, off] of Object.entries(OFF_KEY)) out[k] = num(nm[`${off}${suffix}`]);
  const na = num(nm[`sodium${suffix}`]);
  const salt = num(nm[`salt${suffix}`]);
  out.sodiumMg = na != null ? na * 1000 : salt != null ? (salt / 2.5) * 1000 : null;
  return out;
}

// "30 g", "1 cup (240 ml)", "2 biscuits (25g)", "1.5 l", "6 x 330 ml", "400 g ℮" -> {qty, unit:'g'|'ml'}
export function parseQuantity(text) {
  if (text == null) return null;
  const s = String(text).toLowerCase().replace(',', '.');
  const re = /(?:(\d+(?:\.\d+)?)\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(kg|mg|g|gr|grams?|ml|cl|dl|l|litres?|liters?|fl\.?\s*oz|oz|lbs?)\b/g;
  let m, best = null;
  while ((m = re.exec(s))) {
    const mult = m[1] ? Number(m[1]) : 1;
    const v = Number(m[2]) * mult;
    const u = m[3].replace(/\s/g, '');
    let q = null;
    if (/^(g|gr|grams?)$/.test(u)) q = { qty: v, unit: 'g' };
    else if (u === 'kg') q = { qty: v * 1000, unit: 'g' };
    else if (u === 'mg') q = { qty: v / 1000, unit: 'g' };
    else if (u === 'ml') q = { qty: v, unit: 'ml' };
    else if (u === 'cl') q = { qty: v * 10, unit: 'ml' };
    else if (u === 'dl') q = { qty: v * 100, unit: 'ml' };
    else if (/^(l|litres?|liters?)$/.test(u)) q = { qty: v * 1000, unit: 'ml' };
    else if (/^fl\.?oz$/.test(u)) q = { qty: flOzToMl(v), unit: 'ml' };
    else if (u === 'oz') q = { qty: ozToG(v), unit: 'g' };
    else if (/^lbs?$/.test(u)) q = { qty: lbToKg(v) * 1000, unit: 'g' };
    // "1 cup (240 ml)": prefer the metric amount in brackets over a US one before it
    if (q && (!best || /\(\s*$/.test(s.slice(0, m.index)))) best = q;
  }
  return best;
}

const unitOf = (u) => (/^(ml|cl|l|dl)$/i.test(String(u || '').trim()) ? 'ml' : String(u || '').trim() ? 'g' : null);
export function isLiquid(product) {
  if (unitOf(product.product_quantity_unit) === 'ml' || unitOf(product.serving_quantity_unit) === 'ml') return true;
  const q = parseQuantity(product.quantity);
  return !!(q && q.unit === 'ml');
}
export function servingOf(product) {
  const sq = num(product.serving_quantity);
  if (sq != null && sq > 0) return { qty: sq, unit: unitOf(product.serving_quantity_unit) || (isLiquid(product) ? 'ml' : 'g') };
  return parseQuantity(product.serving_size);
}
export function packageOf(product) {
  const pq = num(product.product_quantity);
  if (pq != null && pq > 0) return { qty: pq, unit: unitOf(product.product_quantity_unit) || (isLiquid(product) ? 'ml' : 'g') };
  return parseQuantity(product.quantity);
}

// Per-100 g (or 100 ml for drinks) nutrients of an OFF product.
export function per100(product) {
  const nm = product.nutriments || {};
  return { basis: isLiquid(product) ? '100ml' : '100g', ...readBasis(nm, '_100g') };
}

// amount: {servings} | {grams} | {ml} | {oz} | {flOz} | {packages}
// -> {ok, qty, unit, nutrients{kcal..sodiumMg}, notes[]} — or {ok:false, error}
export function nutrientsEaten(product, amount = {}) {
  const base = per100(product);
  const liquid = base.basis === '100ml';
  const notes = [];
  let qty = null, unit = liquid ? 'ml' : 'g';
  const serving = servingOf(product);
  const n = (v) => (num(v) != null && num(v) >= 0 ? num(v) : null);
  if (n(amount.servings) != null) {
    if (serving) { qty = n(amount.servings) * serving.qty; if (serving.unit !== unit) notes.push(MSG.assumedDensity); }
    else {
      // label gives only per-serving numbers and no serving size: use them directly
      const ps = readBasis(product.nutriments || {}, '_serving');
      if (ps.kcal == null && NUTRIENTS.every((k) => ps[k] == null)) return { ok: false, error: 'noServingSize' };
      const f = n(amount.servings);
      const nutrients = Object.fromEntries(NUTRIENTS.map((k) => [k, ps[k] == null ? null : ps[k] * f]));
      return { ok: true, qty: null, unit: 'serving', servings: f, nutrients, kcalFromKj: ps.kcalFromKj, notes };
    }
  } else if (n(amount.grams) != null) { qty = n(amount.grams); if (liquid) notes.push(MSG.assumedDensity); }
  else if (n(amount.oz) != null) { qty = ozToG(n(amount.oz)); if (liquid) notes.push(MSG.assumedDensity); }
  else if (n(amount.ml) != null) { qty = n(amount.ml); if (!liquid) notes.push(MSG.assumedDensity); }
  else if (n(amount.flOz) != null) { qty = flOzToMl(n(amount.flOz)); if (!liquid) notes.push(MSG.assumedDensity); }
  else if (n(amount.packages) != null) {
    const pk = packageOf(product);
    if (!pk) return { ok: false, error: 'noPackageSize' };
    qty = n(amount.packages) * pk.qty;
    if (pk.unit !== unit) notes.push(MSG.assumedDensity);
  } else return { ok: false, error: 'noAmount' };

  const f = qty / 100;
  let nutrients = Object.fromEntries(NUTRIENTS.map((k) => [k, base[k] == null ? null : base[k] * f]));
  // per-100 missing but the label has per-serving values and a known serving size: scale those
  if (serving && NUTRIENTS.some((k) => nutrients[k] == null)) {
    const ps = readBasis(product.nutriments || {}, '_serving');
    for (const k of NUTRIENTS) if (nutrients[k] == null && ps[k] != null) nutrients[k] = ps[k] * qty / serving.qty;
  }
  return { ok: true, qty, unit, nutrients, kcalFromKj: base.kcalFromKj, notes };
}

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const MEAL_NAMES = { breakfast: { en: 'Breakfast', vi: 'Bữa sáng' }, lunch: { en: 'Lunch', vi: 'Bữa trưa' }, dinner: { en: 'Dinner', vi: 'Bữa tối' }, snacks: { en: 'Snacks', vi: 'Ăn vặt' } };

// Sum nutrients. A total is the sum of what is KNOWN; `missing[k]` counts entries that lacked k, so the
// page can say "at least 1,240 kcal (1 item has no calorie info)". All-missing -> null, never 0.
export function sumNutrients(list) {
  const total = {}, missing = {};
  for (const k of NUTRIENTS) {
    let s = 0, known = 0, miss = 0;
    for (const x of list) { const v = x && x[k]; if (v == null) miss++; else { s += v; known++; } }
    total[k] = known ? s : (list.length ? null : 0);
    if (miss) missing[k] = miss;
  }
  return { total, missing };
}
// entries: [{meal, nutrients}] -> {byMeal:{breakfast:{total,missing,count}...}, day:{total,missing,count}}
export function dayTotals(entries = []) {
  const byMeal = {};
  for (const meal of MEALS) {
    const list = entries.filter((e) => (MEALS.includes(e.meal) ? e.meal : 'snacks') === meal).map((e) => e.nutrients);
    byMeal[meal] = { ...sumNutrients(list), count: list.length };
  }
  return { byMeal, day: { ...sumNutrients(entries.map((e) => e.nutrients)), count: entries.length } };
}
// remaining vs targets. Limits (sugar, sat fat, sodium) are "max"; protein & fiber are "min"; kcal is a
// target. partial=true when some logged item lacked that nutrient (the eaten number is a lower bound).
export function remainingVsTargets(day, targets) {
  const t = targets, tot = day.total, miss = day.missing || {};
  const row = (k, goal, kind) => {
    const eaten = tot[k];
    const out = { goal, eaten: eaten == null ? null : round(eaten, 1), kind, partial: !!miss[k] };
    if (eaten == null) return { ...out, remaining: null, status: 'unknown' };
    out.remaining = round(goal - eaten, 1);
    if (kind === 'max') out.status = eaten > goal ? 'over' : 'ok';
    else if (kind === 'min') out.status = eaten >= goal ? 'ok' : 'under';
    else out.status = eaten > goal * 1.05 ? 'over' : eaten < goal * 0.95 ? 'under' : 'ok';
    return out;
  };
  // added sugars: fall back to total sugars (an upper bound of added sugars) when no added-sugar data
  const sugarKey = tot.addedSugars != null && !miss.addedSugars ? 'addedSugars' : 'sugars';
  return {
    kcal: row('kcal', t.kcal, 'target'),
    protein: row('protein', t.proteinG ? t.proteinG[0] : t.proteinMinG, 'min'),
    fiber: row('fiber', t.fiberMinG, 'min'),
    sugar: { ...row(sugarKey, t.addedSugarMaxG, 'max'), usedTotalSugars: sugarKey === 'sugars' },
    satFat: row('satFat', t.satFatMaxG, 'max'),
    sodiumMg: row('sodiumMg', t.sodiumMaxMg, 'max'),
  };
}

// ---------------------------------------------------------------------------------------------
// 8. Adaptive target — learn the user's REAL daily burn from their own log
// ---------------------------------------------------------------------------------------------
// Energy balance: intake − expenditure = energy stored. Over a window, expenditure ≈ mean intake −
// (weight slope × energy density of the tissue lost/gained). 7,700 kcal/kg (≈ 3,500 kcal/lb, Wishnofsky
// 1958) is the conventional density; it is too HIGH for the first 1–2 weeks of a new diet (water and
// glycogen are lost at ~1,000–4,200 kcal/kg — see the Hall model constants) and for lean people (more of
// the loss is lean tissue at 1,816 kcal/kg), so early estimates read low and confidence is marked.
// This is the same idea as Hall KD & Chow CC's intake back-calculation (Am J Clin Nutr 2011;94:66–74) and
// commercial "adaptive" trackers (e.g. MacroFactor). Weight noise (water, salt, gut contents) is handled by
// an ordinary least-squares slope through all weigh-ins in the window (unbiased for a linear trend, gives a
// standard error); the exponentially smoothed trend line (10% per day, Walker J, "The Hacker's Diet", 1991)
// is returned for display.
export const KCAL_PER_KG_CHANGE = 7700;

export function ewmaTrend(points, alpha = 0.1) {
  const out = [];
  let t = null;
  for (const p of points) { if (p.weightKg == null) continue; t = t == null ? p.weightKg : t + alpha * (p.weightKg - t); out.push({ date: p.date, trendKg: round(t, 2) }); }
  return out;
}

// log: [{date:'YYYY-MM-DD', kcal?, weightKg?}] (any order, one row per day)
// opts: {windowDays=28, profile?, currentTargetKcal?, goalRateKgPerWeek? (negative = lose), maxStepKcal=250}
export function estimateTdee(log = [], { windowDays = 28, profile = null, currentTargetKcal = null, goalRateKgPerWeek = null, maxStepKcal = 250 } = {}) {
  const rows = [...log].filter((r) => r && r.date).sort((a, b) => toUtc(a.date) - toUtc(b.date));
  if (!rows.length) return { ok: false, status: 'needMoreData', messages: [MSG.needMoreData] };
  const end = rows[rows.length - 1].date;
  const start = addDays(end, -(windowDays - 1));
  const win = rows.filter((r) => toUtc(r.date) >= toUtc(start));
  const spanDays = daysBetween(win[0].date, end) + 1;
  const intakes = win.filter((r) => num(r.kcal) != null);
  const weighs = win.filter((r) => num(r.weightKg) != null);
  const trend = ewmaTrend(win.map((r) => ({ date: r.date, weightKg: num(r.weightKg) })));
  if (spanDays < 14 || intakes.length < 10 || weighs.length < 5) {
    return { ok: false, status: 'needMoreData', spanDays, intakeDays: intakes.length, weighIns: weighs.length, trend, messages: [MSG.needMoreData] };
  }
  const meanIntake = intakes.reduce((s, r) => s + num(r.kcal), 0) / intakes.length;
  // OLS slope of weight on day number
  const xs = weighs.map((r) => daysBetween(win[0].date, r.date)), ys = weighs.map((r) => num(r.weightKg));
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx; // kg/day
  const resid = ys.map((y, i) => y - (my + slope * (xs[i] - mx)));
  const se = n > 2 ? Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / (n - 2) / sxx) : Infinity;
  const tdee = meanIntake - slope * KCAL_PER_KG_CHANGE;
  const ci95 = 1.96 * se * KCAL_PER_KG_CHANGE;
  const coverage = intakes.length / spanDays;
  const messages = [];
  if (coverage < 0.85) messages.push(MSG.lowLogging);
  let confidence = 'low';
  if (spanDays >= 28 && coverage >= 0.85 && n >= 14 && ci95 <= 150) confidence = 'high';
  else if (coverage >= 0.7 && n >= 7 && ci95 <= 300) confidence = 'medium';

  let suggestedKcal = null;
  if (confidence !== 'low' && goalRateKgPerWeek != null) {
    const wanted = tdee + (num(goalRateKgPerWeek) * KCAL_PER_KG_CHANGE) / 7;
    let s = wanted;
    if (currentTargetKcal != null) s = clamp(wanted, currentTargetKcal - maxStepKcal, currentTargetKcal + maxStepKcal);
    s = Math.max(s, tdee - SAFETY.maxDeficitKcal);
    if (profile) s = Math.max(s, calorieFloor(profile));
    suggestedKcal = round(s, -1);
  } else if (confidence === 'low') messages.push(MSG.lowConfidence);
  return {
    ok: true, status: 'estimated', tdeeKcal: round(tdee), rangeKcal: [round(tdee - ci95), round(tdee + ci95)], confidence,
    meanIntakeKcal: round(meanIntake), kgPerWeek: round(slope * 7, 2), spanDays, intakeDays: intakes.length, weighIns: n,
    loggingCoverage: round(coverage, 2), suggestedKcal, trend, messages,
  };
}

// ---------------------------------------------------------------------------------------------
// 9. One-day plan from the user's scanned products
// ---------------------------------------------------------------------------------------------
// A greedy knapsack, deterministic: (1) protein first — add the portion with the best
// quality × protein-per-kcal until the protein minimum is met; (2) fill calories — add the portion with
// the best (quality + fiber help − sugar/sat-fat/sodium overshoot) per kcal, until the total is inside
// target ±5%. Portions move in half servings (or 50 g/ml steps if the label has no serving size), at most
// 2 servings / 200 g of one product, and no product supplies more than 35% of the day (variety). Protein
// or fat above 35% of energy is penalised so the day stays balanced (AMDR upper limits).
// Anything containing — or possibly containing — one of the user's allergens is excluded, and so is any
// product whose ingredient list could not be checked. If the scanned items cannot make a sensible day, it
// says so and returns plate guidance (Harvard Healthy Eating Plate / USDA MyPlate) instead of a bad plan.
const SNACK_CAT = /(snack|sweet|confection|candy|candies|chocolate|biscuit|cookie|crisps|chips|dessert|cake|soda|soft-drink|sugary|energy-drink|ice-cream)/;
const BREAKFAST_CAT = /(breakfast|cereal|muesli|granola|oat|yogurt|yoghurt|milk|bread|spread)/;
export const PLATE_GUIDANCE = {
  en: 'Build each meal on a plate: half vegetables and fruit, a quarter lean protein (fish, chicken, tofu, eggs, beans), a quarter whole grains (brown rice, whole-wheat noodles, oats). Drink water or unsweetened tea. Scan a few more of these everyday foods and the app can build a full day for you.',
  vi: 'Mỗi bữa ăn theo đĩa: một nửa rau và trái cây, một phần tư đạm nạc (cá, gà, đậu phụ, trứng, các loại đậu), một phần tư ngũ cốc nguyên hạt (gạo lứt, bún/mì nguyên cám, yến mạch). Uống nước lọc hoặc trà không đường. Hãy quét thêm vài món ăn hằng ngày như vậy để ứng dụng lập được thực đơn cả ngày cho bạn.',
};
const PLAN_REASONS = {
  tooFew: { en: 'Not enough scanned foods you can eat to build a full day yet.', vi: 'Chưa đủ món đã quét mà bạn ăn được để lập thực đơn cả ngày.' },
  notEnoughFood: { en: 'Your scanned foods cannot reach your calorie target in sensible portions.', vi: 'Các món đã quét không đủ đạt lượng calo mục tiêu với khẩu phần hợp lý.' },
  overshoot: { en: 'Could not land within 5% of your calorie target with these portion sizes.', vi: 'Không thể đạt trong khoảng 5% lượng calo mục tiêu với các khẩu phần này.' },
  proteinShort: { en: 'Your scanned foods do not have enough protein for a healthy day.', vi: 'Các món đã quét không đủ chất đạm cho một ngày ăn lành mạnh.' },
  mostlySnacks: { en: 'Most of your scanned foods are snacks or sweets — a day built from them would not be healthy.', vi: 'Phần lớn món đã quét là đồ ăn vặt hoặc đồ ngọt — thực đơn từ chúng sẽ không lành mạnh.' },
  lowQuality: { en: 'Your scanned foods score too low on health to make a good day.', vi: 'Các món đã quét có điểm sức khỏe quá thấp để tạo một ngày ăn tốt.' },
};
const EXCLUDE = {
  allergen: { en: 'contains one of your allergens', vi: 'chứa chất gây dị ứng của bạn' },
  maybeAllergen: { en: 'may contain one of your allergens', vi: 'có thể chứa chất gây dị ứng của bạn' },
  unchecked: { en: 'ingredients could not be checked for your allergens', vi: 'không kiểm tra được thành phần về chất gây dị ứng' },
  noCalories: { en: 'no calorie information', vi: 'không có thông tin calo' },
  notFood: { en: 'not a food', vi: 'không phải thực phẩm' },
};

function isSnackLike(prod, b) {
  const cats = (prod.categories || prod.categories_tags || []).join(' ').toLowerCase();
  if (cats) return SNACK_CAT.test(cats);
  // no categories: UK FSA "high sugar" (>22.5 g/100 g) or energy-dense with little protein
  if (b.sugars != null && b.sugars > 22.5) return true;
  if (b.kcal != null && b.kcal >= 450 && (b.protein == null || (b.protein * 4) / b.kcal < 0.1)) return true;
  return false;
}

// products: [{code|id, name, nutriments, serving_quantity?, serving_size?, quantity?, score, ecs?, type?,
//             alg?:{c:[],t:[],u:bool} | allergens?:[ids], traces?:[ids], categories?:[...]}]
// targets: nutritionTargets(...) ; allergens: user's allergen ids (same ids as engine.js ALLERGENS)
// opts: {tolerance=0.05, eczemaWeight=0 (0..1 blend of eczema score into quality)}
export function buildMealPlan({ products = [], targets, allergens = [], tolerance = 0.05, eczemaWeight = 0 }) {
  const T = targets.kcal;
  const lo = T * (1 - tolerance), hi = T * (1 + tolerance);
  const mine = new Set(allergens);
  const excluded = [];
  const cands = [];
  const sorted = [...products].sort((a, b) => String(a.code || a.id || a.name).localeCompare(String(b.code || b.id || b.name)));
  for (const prod of sorted) {
    const id = String(prod.code || prod.id || prod.name);
    if (prod.type && prod.type !== 'food') { excluded.push({ id, name: prod.name, why: EXCLUDE.notFood }); continue; }
    if (mine.size) {
      const c = prod.alg ? prod.alg.c || [] : prod.allergens || [];
      const t = prod.alg ? prod.alg.t || [] : prod.traces || [];
      const unchecked = prod.alg ? !!prod.alg.u : !prod.allergens;
      if (c.some((a) => mine.has(a))) { excluded.push({ id, name: prod.name, why: EXCLUDE.allergen }); continue; }
      if (t.some((a) => mine.has(a))) { excluded.push({ id, name: prod.name, why: EXCLUDE.maybeAllergen }); continue; }
      if (unchecked) { excluded.push({ id, name: prod.name, why: EXCLUDE.unchecked }); continue; }
    }
    const b = per100(prod);
    if (b.kcal == null || b.kcal <= 0) { excluded.push({ id, name: prod.name, why: EXCLUDE.noCalories }); continue; }
    const serving = servingOf(prod);
    const step = serving ? { servings: 0.5 } : { grams: 50 };
    const stepQty = serving ? serving.qty * 0.5 : 50;
    const unit = nutrientsEaten(prod, step);
    if (!unit.ok || unit.nutrients.kcal == null) { excluded.push({ id, name: prod.name, why: EXCLUDE.noCalories }); continue; }
    const health = num(prod.score), ecz = num(prod.ecs);
    const qScore = health == null ? 40 : health; // unknown score: treated as below average, never as good
    const quality = ((1 - eczemaWeight) * qScore + eczemaWeight * (ecz == null ? qScore : ecz)) / 100;
    cands.push({ id, name: prod.name, prod, step, stepQty, serving, unit: unit.nutrients, maxSteps: 4, quality, snack: isSnackLike(prod, b), units: 0 });
  }
  const fail = (reason, extra = {}) => ({ ok: false, reason, message: PLAN_REASONS[reason], guidance: PLATE_GUIDANCE, excluded, ...extra });
  if (cands.length < 3) return fail('tooFew');

  const tot = Object.fromEntries(NUTRIENTS.map((k) => [k, 0]));
  // sugar limit is on ADDED sugars; where a label lacks them, its total sugars stand in (conservative)
  tot.sugarForLimit = 0;
  const sugarOf = (u) => (u.addedSugars != null ? u.addedSugars : u.sugars);
  const canAdd = (c) => c.units < c.maxSteps && tot.kcal + c.unit.kcal <= hi && (c.units + 1) * c.unit.kcal <= 0.35 * T;
  const add = (c) => { c.units++; for (const k of NUTRIENTS) tot[k] += c.unit[k] || 0; tot.sugarForLimit += sugarOf(c.unit) || 0; };
  const over = (val, lim) => Math.max(0, val - lim) / lim;
  // macro balance (AMDR): protein above 35% or fat above 35% of energy is penalised like the limits
  const proteinMax = 0.35 * T / 4;
  const fatMax = targets.fatG ? targets.fatG[1] : 0.35 * T / 9;
  const pick = (scoreFn) => {
    let best = null, bestS = -Infinity;
    for (const c of cands) { if (!canAdd(c)) continue; const s = scoreFn(c); if (s > bestS + 1e-12) { best = c; bestS = s; } }
    return best;
  };
  // (1) protein first
  while (tot.protein < targets.proteinMinG) {
    const c = pick((c) => (c.unit.protein || 0) > 0 ? c.quality * Math.min(c.unit.protein, targets.proteinMinG - tot.protein) / c.unit.kcal : -Infinity);
    if (!c || !(c.unit.protein > 0)) break;
    add(c);
  }
  // (2) fill calories, best value per kcal
  const value = (c) => {
    const u = c.unit;
    const fiberHelp = targets.fiberMinG ? (Math.min(tot.fiber + (u.fiber || 0), targets.fiberMinG) - Math.min(tot.fiber, targets.fiberMinG)) / targets.fiberMinG : 0;
    const pen = (k, lim, inc) => (lim ? over(tot[k] + inc, lim) - over(tot[k], lim) : 0);
    const penalty = pen('sugarForLimit', targets.addedSugarMaxG, sugarOf(u) || 0) + pen('satFat', targets.satFatMaxG, u.satFat || 0) + pen('sodiumMg', targets.sodiumMaxMg, u.sodiumMg || 0)
      + pen('protein', proteinMax, u.protein || 0) + pen('fat', fatMax, u.fat || 0);
    return (c.quality * u.kcal / T + 0.5 * fiberHelp - 2 * penalty - (c.snack ? 0.1 * u.kcal / T : 0)) / u.kcal;
  };
  while (tot.kcal < T) {
    const c = pick(value);
    if (!c) break;
    // stop if this step overshoots more than staying put undershoots (once inside the window)
    if (tot.kcal >= lo && tot.kcal + c.unit.kcal - T > T - tot.kcal) break;
    add(c);
  }
  const chosen = cands.filter((c) => c.units > 0);
  const kcal = tot.kcal;
  const snackShare = chosen.reduce((s, c) => s + (c.snack ? c.units * c.unit.kcal : 0), 0) / (kcal || 1);
  const avgScore = chosen.reduce((s, c) => s + c.quality * c.units * c.unit.kcal, 0) / (kcal || 1) * 100;
  const summary = { kcal: round(kcal), protein: round(tot.protein, 1), fiber: round(tot.fiber, 1), sugarForLimit: round(tot.sugarForLimit, 1), satFat: round(tot.satFat, 1), sodiumMg: round(tot.sodiumMg), avgScore: round(avgScore) };
  // the most useful explanation first: a day of snacks is "mostly snacks" even if it also falls short
  if (snackShare > 0.5) return fail('mostlySnacks', { summary });
  if (avgScore < 35) return fail('lowQuality', { summary });
  if (kcal < lo) return fail('notEnoughFood', { summary });
  if (kcal > hi) return fail('overshoot', { summary });
  if (tot.protein < targets.proteinMinG) return fail('proteinShort', { summary });

  // meals: snacks to "snacks", breakfast-type foods to breakfast, the rest balanced across lunch/dinner
  const meals = Object.fromEntries(MEALS.map((m) => [m, []]));
  const mealKcal = Object.fromEntries(MEALS.map((m) => [m, 0]));
  const share = { breakfast: 0.25, lunch: 0.35, dinner: 0.35, snacks: 0.10 };
  const items = chosen.map((c) => ({
    id: c.id, name: c.name, amount: c.serving ? { servings: c.units * 0.5 } : { grams: c.units * 50 }, qty: round(c.units * c.stepQty, 1),
    unit: c.serving ? c.serving.unit : (per100(c.prod).basis === '100ml' ? 'ml' : 'g'), kcal: round(c.units * c.unit.kcal), protein: round(c.units * (c.unit.protein || 0), 1),
    score: num(c.prod.score), snack: c.snack, breakfastish: BREAKFAST_CAT.test((c.prod.categories || c.prod.categories_tags || []).join(' ').toLowerCase()),
  })).sort((a, b) => b.kcal - a.kcal || a.id.localeCompare(b.id));
  const put = (it, meal) => { meals[meal].push(it); mealKcal[meal] += it.kcal; };
  for (const it of items) {
    if (it.snack) put(it, 'snacks');
    else if (it.breakfastish && mealKcal.breakfast < share.breakfast * T) put(it, 'breakfast');
    else put(it, mealKcal.lunch <= mealKcal.dinner ? 'lunch' : 'dinner');
  }
  // no breakfast-type food scanned: breakfast gets the lightest, least protein-heavy item from lunch/dinner
  if (!meals.breakfast.length) {
    const pool = [...meals.lunch, ...meals.dinner].sort((a, b) => a.protein / a.kcal - b.protein / b.kcal || a.kcal - b.kcal || a.id.localeCompare(b.id));
    const it = pool.find((x) => x.kcal <= share.breakfast * T * 1.5);
    if (it) { for (const m of ['lunch', 'dinner']) meals[m] = meals[m].filter((x) => x !== it); mealKcal.lunch = meals.lunch.reduce((s, x) => s + x.kcal, 0); mealKcal.dinner = meals.dinner.reduce((s, x) => s + x.kcal, 0); put(it, 'breakfast'); }
  }
  const softWarnings = [];
  if (tot.fiber < targets.fiberMinG) softWarnings.push({ en: `Fiber is ${round(tot.fiber)} g — add vegetables, fruit or whole grains to reach ${targets.fiberMinG} g.`, vi: `Chất xơ là ${round(tot.fiber)} g — thêm rau, trái cây hoặc ngũ cốc nguyên hạt để đạt ${targets.fiberMinG} g.` });
  if (tot.sugarForLimit > targets.addedSugarMaxG) softWarnings.push({ en: `Added sugar is about ${round(tot.sugarForLimit)} g, above the ${targets.addedSugarMaxG} g limit.`, vi: `Đường bổ sung khoảng ${round(tot.sugarForLimit)} g, vượt giới hạn ${targets.addedSugarMaxG} g.` });
  if (tot.satFat > targets.satFatMaxG) softWarnings.push({ en: `Saturated fat is ${round(tot.satFat)} g, above the ${targets.satFatMaxG} g limit.`, vi: `Chất béo bão hòa là ${round(tot.satFat)} g, vượt giới hạn ${targets.satFatMaxG} g.` });
  if (tot.protein * 4 > 0.35 * kcal) softWarnings.push({ en: `Protein is ${round(tot.protein)} g — a bit above 35% of calories; fine for a day, but swap some for whole grains or vegetables if you can.`, vi: `Chất đạm là ${round(tot.protein)} g — hơi trên 35% lượng calo; một ngày thì không sao, nhưng nên đổi bớt sang ngũ cốc nguyên hạt hoặc rau nếu có thể.` });
  if (tot.sodiumMg > targets.sodiumMaxMg) softWarnings.push({ en: `Sodium is ${round(tot.sodiumMg)} mg, above ${targets.sodiumMaxMg} mg.`, vi: `Natri là ${round(tot.sodiumMg)} mg, vượt ${targets.sodiumMaxMg} mg.` });
  return { ok: true, meals, summary, softWarnings, excluded };
}
