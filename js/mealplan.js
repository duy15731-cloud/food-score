// Food Score — WEEKLY MEAL PLAN (pure logic). No screen, no storage of its own, no network, no AI.
// Same inputs -> the same plan, every time (deterministic). The calorie and protein numbers come from
// diet.js (Hall 2011 / Mifflin-St Jeor / AHA floors, via the user's saved goal) — this file never works
// out a calorie target of its own; it only turns that target into food, a shopping list and a walk.
//
// FOOD VALUES: per 100 g as eaten, from USDA FoodData Central (SR Legacy descriptions given per item).
// PRICES: approximate 2026 US average grocery prices (one typical store package each; based on BLS
//   average-price series and common national-chain shelf prices). They are estimates, and the screen says so.
// YIELDS (raw/dry package -> cooked grams): USDA Agricultural Handbook 102 "Food Yields" (approximate).
// EXERCISE: CDC "Physical Activity Guidelines for Americans" 2nd ed. (2018) / WHO 2020 guidelines:
//   adults >= 150 min moderate activity a week + muscle-strengthening on >= 2 days; older adults also
//   balance training on >= 3 days. Walking ~100 steps/min = moderate (Tudor-Locke C et al., Br J Sports Med
//   2018;52:776). Brisk walking 3.5 MET, light resistance training 3.5 MET (Compendium of Physical
//   Activities, Ainsworth 2011); calories shown are NET (MET - 1, the resting part is already in the plan).
//   ACSM position stand (Donnelly 2009, Med Sci Sports Exerc 41:459) — > 250 min/week helps weight loss.
// WATER: NASEM Dietary Reference Intakes for Water (2004): ~2.2 L (9 cups) women / 3.0 L (13 cups) men of drinks.
import * as D from './diet.js';

const OZ = D.G_PER_OZ;
const r1 = (x) => Math.round(x * 10) / 10;
const unitOf = (g, en1, en2, vi) => ({ g, en: [en1, en2], vi });
const OZU = unitOf(OZ, 'oz', 'oz', 'oz');
const CUP = (g) => unitOf(g, 'cup', 'cups', 'cốc');
const TBSP = (g) => unitOf(g, 'tbsp', 'tbsp', 'muỗng canh');
const TSP = (g) => unitOf(g, 'tsp', 'tsp', 'muỗng cà phê');

// ---------------------------------------------------------------------------------------------
// The food table. per100 = [kcal, protein g, carbs g, fat g] per 100 g AS EATEN (cooked if `cooked`).
// hh = household unit; steps = [min, start, max, step] in household units.
// slots: BP/BC/BF breakfast protein/carb/fruit (BCa = breakfast carb in Asian style only), LP/LC/LV lunch, DP/DC/DV dinner, S snack.
// notWith = protein ids this carb is never served with (no tofu sandwich, no rice with a glass of milk).
// pack = what you buy: g = EDIBLE grams one package gives (after cooking/peeling), price in US$,
//   keeps = lasts well past a week (frozen / dry / jar) -> only the part used this week counts toward the budget.
// alg = engine.js ALLERGENS ids it contains; may = ids it often contains / is cross-contaminated with (also excluded).
// ---------------------------------------------------------------------------------------------
const F = (id, cat, kind, name, per100, hh, steps, slots, pack, o = {}) => ({ id, cat, kind, name, per100: { kcal: per100[0], p: per100[1], c: per100[2], f: per100[3] }, hh,
  steps: { min: steps[0], start: steps[1], max: steps[2], inc: steps[3] }, slots, pack, alg: o.alg || [], may: o.may || [], meat: o.meat || null, notWith: o.notWith || [], asian: !!o.asian, form: o.form || null, src: o.src || '' });
const P = (g, price, en, vi, keeps = false) => ({ g, price, en, vi, keeps });

export const FOODS = [
  // ---- chicken / beef / pork (meat counted cooked; packages are raw, yield ~73-75%)
  F('chicken_breast', 'chicken', 'meat', { en: 'Chicken breast', vi: 'Ức gà' }, [165, 31.0, 0, 3.6], OZU, [3, 4, 8, 1], ['LP', 'DP'],
    P(340, 4.29, '{q} lb raw', '{q} lb sống'), { meat: 'chicken', form: 'cooked', asian: true, src: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted' }),
  F('chicken_thigh', 'chicken', 'meat', { en: 'Chicken thighs, boneless', vi: 'Đùi gà rút xương' }, [209, 26.0, 0, 10.9], OZU, [3, 4, 7, 1], ['DP', 'LP'],
    P(330, 3.29, '{q} lb raw', '{q} lb sống'), { meat: 'chicken', form: 'cooked', asian: true, src: 'Chicken, broilers or fryers, thigh, meat only, cooked, roasted' }),
  F('ground_beef', 'beef', 'meat', { en: 'Ground beef 85% lean', vi: 'Thịt bò xay (85% nạc)' }, [250, 25.9, 0, 15.4], OZU, [3, 4, 6, 1], ['DP'],
    P(327, 5.79, '{q} lb raw', '{q} lb sống'), { meat: 'beef', form: 'cooked', src: 'Beef, ground, 85% lean meat / 15% fat, crumbles, cooked, pan-browned' }),
  F('pork_tenderloin', 'pork', 'meat', { en: 'Pork tenderloin', vi: 'Thăn heo' }, [143, 26.2, 0, 3.5], OZU, [3, 4, 8, 1], ['DP', 'LP'],
    P(340, 4.99, '{q} lb raw', '{q} lb sống'), { meat: 'pork', form: 'cooked', asian: true, src: 'Pork, fresh, loin, tenderloin, separable lean only, cooked, roasted' }),
  F('ground_pork', 'pork', 'meat', { en: 'Ground pork', vi: 'Thịt heo xay' }, [297, 25.7, 0, 20.8], OZU, [3, 3, 5, 1], ['DP'],
    P(327, 4.29, '{q} lb raw', '{q} lb sống'), { meat: 'pork', form: 'cooked', asian: true, src: 'Pork, fresh, ground, cooked' }),
  // ---- fish / seafood
  F('tuna_can', 'fish', 'fish', { en: 'Canned tuna in water', vi: 'Cá ngừ hộp (ngâm nước)' }, [116, 25.5, 0, 0.8], OZU, [3, 4, 5, 1], ['LP'],
    P(113, 1.29, '{n} × 5 oz can', '{n} hộp 5 oz', true), { alg: ['fish'], src: 'Fish, tuna, light, canned in water, drained solids' }),
  F('salmon', 'fish', 'fish', { en: 'Salmon', vi: 'Cá hồi' }, [206, 22.1, 0, 12.4], OZU, [3, 4, 6, 1], ['DP'],
    P(363, 8.99, '{q} lb frozen', '{q} lb đông lạnh', true), { alg: ['fish'], form: 'cooked', asian: true, src: 'Fish, salmon, Atlantic, farmed, cooked, dry heat' }),
  F('tilapia', 'fish', 'fish', { en: 'Tilapia fish', vi: 'Cá rô phi' }, [128, 26.2, 0, 2.7], OZU, [3, 5, 8, 1], ['DP'],
    P(726, 8.99, '{n} × 2 lb bag (frozen)', '{n} túi 2 lb (đông lạnh)', true), { alg: ['fish'], form: 'cooked', asian: true, src: 'Fish, tilapia, cooked, dry heat' }),
  F('shrimp', 'fish', 'fish', { en: 'Shrimp', vi: 'Tôm' }, [99, 24.0, 0.2, 0.3], OZU, [3, 4, 8, 1], ['DP', 'LP'],
    P(400, 7.99, '{n} × 1 lb bag, cooked (frozen)', '{n} túi 1 lb, đã luộc (đông lạnh)', true), { alg: ['crustaceans'], asian: true, src: 'Crustaceans, shrimp, mixed species, cooked, moist heat' }),
  // ---- eggs / dairy
  F('eggs', 'eggs', 'egg', { en: 'Eggs', vi: 'Trứng gà' }, [155, 12.6, 1.1, 10.6], unitOf(50, 'egg', 'eggs', 'quả'), [1, 2, 4, 1], ['BP', 'LP'],
    P(600, 3.79, '{n} dozen', '{n} chục (12 quả)'), { alg: ['egg'], asian: true, src: 'Egg, whole, cooked, hard-boiled (large egg = 50 g)' }),
  F('greek_yogurt', 'dairy', 'dairy', { en: 'Greek yogurt, plain nonfat', vi: 'Sữa chua Hy Lạp không đường, không béo' }, [59, 10.2, 3.6, 0.4], CUP(227), [0.5, 0.75, 1.5, 0.25], ['BP', 'S'],
    P(907, 5.49, '{n} × 32 oz tub', '{n} hộp 32 oz'), { alg: ['milk'], src: 'Yogurt, Greek, plain, nonfat' }),
  F('milk', 'dairy', 'dairy', { en: 'Milk, 2%', vi: 'Sữa tươi 2% béo' }, [50, 3.3, 4.8, 2.0], CUP(244), [0.5, 1, 2, 0.5], ['BP'],
    P(1950, 2.79, '{n} × half gallon', '{n} bình nửa gallon'), { alg: ['milk'], src: 'Milk, reduced fat, fluid, 2% milkfat' }),
  F('cheddar', 'dairy', 'dairy', { en: 'Cheddar cheese', vi: 'Phô mai cheddar' }, [403, 24.9, 1.3, 33.1], OZU, [1, 1, 2, 0.5], ['S'],
    P(227, 2.99, '{n} × 8 oz block', '{n} khối 8 oz', true), { alg: ['milk'], src: 'Cheese, cheddar' }),
  F('cottage_cheese', 'dairy', 'dairy', { en: 'Cottage cheese, 2%', vi: 'Phô mai cottage 2%' }, [81, 10.5, 4.8, 2.3], CUP(226), [0.5, 0.5, 1.5, 0.25], ['BP', 'S'],
    P(454, 2.99, '{n} × 16 oz tub', '{n} hộp 16 oz'), { alg: ['milk'], src: 'Cheese, cottage, lowfat, 2% milkfat' }),
  // ---- beans / lentils
  F('black_beans', 'beans', 'plant', { en: 'Black beans', vi: 'Đậu đen' }, [132, 8.9, 23.7, 0.5], CUP(172), [0.5, 0.75, 2, 0.25], ['LP', 'DP'],
    P(250, 1.09, '{n} × 15 oz can', '{n} hộp 15 oz', true), { src: 'Beans, black, mature seeds, cooked, boiled, without salt' }),
  F('lentils', 'beans', 'plant', { en: 'Lentils', vi: 'Đậu lăng' }, [116, 9.0, 20.1, 0.4], CUP(198), [0.5, 0.75, 2, 0.25], ['DP', 'LP'],
    P(1100, 1.79, '{n} × 1 lb bag (dry)', '{n} túi 1 lb (khô)', true), { form: 'cooked', src: 'Lentils, mature seeds, cooked, boiled, without salt' }),
  F('chickpeas', 'beans', 'plant', { en: 'Chickpeas', vi: 'Đậu gà' }, [164, 8.9, 27.4, 2.6], CUP(164), [0.5, 0.75, 2, 0.25], ['LP', 'DP'],
    P(250, 1.19, '{n} × 15 oz can', '{n} hộp 15 oz', true), { src: 'Chickpeas (garbanzo beans), mature seeds, cooked, boiled, without salt' }),
  F('hummus', 'beans', 'plant', { en: 'Hummus', vi: 'Hummus (sốt đậu gà)' }, [166, 7.9, 14.3, 9.6], TBSP(15), [2, 4, 6, 1], ['S'],
    P(283, 3.49, '{n} × 10 oz tub', '{n} hộp 10 oz'), { alg: ['sesame'], src: 'Hummus, commercial' }),
  // ---- tofu
  F('tofu', 'tofu', 'plant', { en: 'Tofu, firm', vi: 'Đậu hũ (loại cứng)' }, [144, 17.3, 2.8, 8.7], OZU, [3, 4, 8, 1], ['DP', 'LP', 'BP'],
    P(397, 2.29, '{n} × 14 oz block', '{n} bìa 14 oz'), { alg: ['soy'], asian: true, src: 'Tofu, raw, firm, prepared with calcium sulfate' }),
  // ---- nuts
  F('peanut_butter', 'nuts', 'plant', { en: 'Peanut butter', vi: 'Bơ đậu phộng' }, [588, 25.1, 19.6, 50.4], TBSP(16), [1, 2, 2, 1], ['BP', 'S'],
    P(454, 2.79, '{n} × 16 oz jar', '{n} hũ 16 oz', true), { alg: ['peanut'], src: 'Peanut butter, smooth style, without salt' }),
  F('almonds', 'nuts', 'plant', { en: 'Almonds', vi: 'Hạnh nhân' }, [579, 21.2, 21.6, 49.9], OZU, [0.5, 1, 2, 0.5], ['S'],
    P(454, 6.99, '{n} × 16 oz bag', '{n} túi 16 oz', true), { alg: ['treenuts'], src: 'Nuts, almonds' }),
  F('peanuts', 'nuts', 'plant', { en: 'Peanuts, dry-roasted', vi: 'Đậu phộng rang' }, [585, 24.4, 21.3, 49.7], OZU, [0.5, 1, 2, 0.5], ['S'],
    P(454, 3.49, '{n} × 16 oz jar', '{n} hũ 16 oz', true), { alg: ['peanut'], src: 'Peanuts, all types, dry-roasted, without salt' }),
  // ---- rice / pasta & noodles / bread / potatoes / oats
  F('white_rice', 'rice', 'plant', { en: 'White rice (jasmine or long-grain)', vi: 'Gạo trắng (gạo thơm)' }, [130, 2.7, 28.2, 0.3], CUP(158), [0.5, 1, 3, 0.25], ['LC', 'DC', 'BCa'],
    P(2320, 2.49, '{n} × 2 lb bag', '{n} túi 2 lb', true), { notWith: ['peanut_butter', 'milk', 'greek_yogurt', 'cottage_cheese'], form: 'cooked', asian: true, src: 'Rice, white, long-grain, regular, enriched, cooked' }),
  F('brown_rice', 'rice', 'plant', { en: 'Brown rice', vi: 'Gạo lứt' }, [123, 2.7, 25.6, 1.0], CUP(158), [0.5, 1, 3, 0.25], ['LC', 'DC'],
    P(2270, 2.99, '{n} × 2 lb bag', '{n} túi 2 lb', true), { notWith: ['peanut_butter', 'milk', 'greek_yogurt', 'cottage_cheese'], form: 'cooked', asian: true, src: 'Rice, brown, long-grain, cooked' }),
  F('spaghetti', 'pasta', 'plant', { en: 'Spaghetti / pasta', vi: 'Mì Ý (spaghetti)' }, [158, 5.8, 30.9, 0.9], CUP(140), [0.5, 1, 3, 0.25], ['DC', 'LC'],
    P(1000, 1.49, '{n} × 1 lb box', '{n} hộp 1 lb', true), { alg: ['wheat', 'gluten'], may: ['egg'], notWith: ['tofu', 'black_beans', 'peanut_butter'], form: 'cooked', src: 'Pasta, cooked, enriched, without added salt' }),
  F('rice_noodles', 'pasta', 'plant', { en: 'Rice noodles (phở / bún)', vi: 'Bánh phở / bún khô' }, [108, 1.8, 24.0, 0.2], CUP(176), [0.5, 1, 3, 0.25], ['DC', 'LC'],
    P(900, 2.99, '{n} × 14 oz pack', '{n} gói 14 oz', true), { notWith: ['tuna_can', 'black_beans', 'lentils', 'chickpeas'], form: 'cooked', asian: true, src: 'Rice noodles, cooked' }),
  F('wheat_bread', 'bread', 'plant', { en: 'Whole-wheat bread', vi: 'Bánh mì nguyên cám (lát)' }, [252, 12.4, 42.7, 3.5], unitOf(32, 'slice', 'slices', 'lát'), [1, 2, 4, 1], ['BC', 'LC'],
    P(567, 3.29, '{n} × 20 oz loaf', '{n} ổ 20 oz'), { alg: ['wheat', 'gluten'], may: ['soy', 'sesame', 'milk'], notWith: ['tofu', 'black_beans', 'lentils', 'shrimp', 'ground_beef', 'ground_pork', 'salmon', 'tilapia'], src: 'Bread, whole-wheat, commercially prepared' }),
  F('flour_tortilla', 'bread', 'plant', { en: 'Flour tortillas (8 inch)', vi: 'Bánh tortilla bột mì (20 cm)' }, [306, 8.2, 50.0, 7.9], unitOf(49, 'tortilla', 'tortillas', 'cái'), [1, 1, 3, 1], ['LC', 'BC', 'DC'],
    P(490, 2.99, '{n} × pack of 10', '{n} gói 10 cái'), { alg: ['wheat', 'gluten'], may: ['soy', 'milk'], notWith: ['lentils', 'milk', 'greek_yogurt', 'cottage_cheese'], src: 'Tortillas, ready-to-bake or -fry, flour' }),
  F('corn_tortilla', 'bread', 'plant', { en: 'Corn tortillas (6 inch)', vi: 'Bánh tortilla bắp (15 cm)' }, [218, 5.7, 44.6, 2.9], unitOf(26, 'tortilla', 'tortillas', 'cái'), [2, 2, 5, 1], ['LC', 'DC'],
    P(780, 2.49, '{n} × pack of 30', '{n} gói 30 cái'), { alg: ['corn'], notWith: ['lentils', 'tuna_can', 'tofu', 'chickpeas'], src: 'Tortillas, ready-to-bake or -fry, corn' }),
  F('potato', 'potatoes', 'plant', { en: 'Potatoes (russet)', vi: 'Khoai tây' }, [93, 2.5, 21.2, 0.1], unitOf(173, 'medium potato', 'medium potatoes', 'củ vừa'), [0.5, 1, 3, 0.5], ['DC', 'BC', 'LC'],
    P(1880, 3.99, '{n} × 5 lb bag', '{n} túi 5 lb', true), { notWith: ['tofu', 'peanut_butter', 'milk', 'greek_yogurt', 'cottage_cheese'], form: 'baked', src: 'Potatoes, baked, flesh and skin, without salt' }),
  F('sweet_potato', 'potatoes', 'plant', { en: 'Sweet potatoes', vi: 'Khoai lang' }, [90, 2.0, 20.7, 0.2], unitOf(114, 'medium sweet potato', 'medium sweet potatoes', 'củ vừa'), [0.5, 1, 3, 0.5], ['DC', 'LC'],
    P(363, 1.29, '{q} lb', '{q} lb'), { form: 'baked', asian: true, src: 'Sweet potato, cooked, baked in skin, flesh, without salt' }),
  F('oats', 'oats', 'plant', { en: 'Rolled oats', vi: 'Yến mạch cán' }, [379, 13.2, 67.7, 6.5], CUP(80), [0.25, 0.5, 1.25, 0.25], ['BC'],
    P(1190, 4.49, '{n} × 42 oz canister', '{n} hộp 42 oz', true), { alg: ['oats'], may: ['gluten'], notWith: ['tofu'], form: 'dry', src: 'Cereals, oats, regular and quick, not fortified, dry' }),
  // ---- vegetables
  F('broccoli', 'vegetables', 'plant', { en: 'Broccoli', vi: 'Bông cải xanh' }, [35, 2.4, 7.2, 0.4], CUP(156), [1, 1, 2, 0.5], ['DV', 'LV'],
    P(340, 1.49, '{n} × 12 oz bag (frozen)', '{n} túi 12 oz (đông lạnh)', true), { form: 'cooked', asian: true, src: 'Broccoli, cooked, boiled, drained, without salt' }),
  F('mixed_veg', 'vegetables', 'plant', { en: 'Mixed vegetables', vi: 'Rau củ trộn' }, [65, 2.9, 13.1, 0.2], CUP(182), [0.5, 1, 2, 0.5], ['LV', 'DV'],
    P(454, 1.49, '{n} × 16 oz bag (frozen)', '{n} túi 16 oz (đông lạnh)', true), { alg: ['corn'], form: 'cooked', src: 'Vegetables, mixed, frozen, cooked, boiled, drained, without salt' }),
  F('carrots', 'vegetables', 'plant', { en: 'Baby carrots', vi: 'Cà rốt baby' }, [41, 0.9, 9.6, 0.2], CUP(128), [0.5, 1, 2, 0.5], ['LV', 'S'],
    P(454, 1.49, '{n} × 1 lb bag', '{n} túi 1 lb'), { src: 'Carrots, raw' }),
  F('spinach', 'vegetables', 'plant', { en: 'Spinach / salad greens', vi: 'Rau bina / xà lách' }, [23, 2.9, 3.6, 0.4], CUP(30), [1, 2, 3, 1], ['LV', 'DV'],
    P(142, 2.49, '{n} × 5 oz box', '{n} hộp 5 oz'), { src: 'Spinach, raw' }),
  F('cabbage', 'vegetables', 'plant', { en: 'Cabbage', vi: 'Bắp cải' }, [25, 1.3, 5.8, 0.1], CUP(89), [1, 1.5, 3, 0.5], ['LV', 'DV'],
    P(725, 1.79, '{n} × head (about 2 lb)', '{n} bắp (khoảng 2 lb)'), { asian: true, src: 'Cabbage, raw' }),
  F('bok_choy', 'vegetables', 'plant', { en: 'Bok choy', vi: 'Cải thìa (bok choy)' }, [12, 1.6, 1.8, 0.2], CUP(170), [1, 1, 2, 0.5], ['DV', 'LV'],
    P(410, 1.99, '{q} lb', '{q} lb'), { form: 'cooked', asian: true, src: 'Cabbage, chinese (pak-choi), cooked, boiled, drained, without salt' }),
  F('tomato', 'vegetables', 'plant', { en: 'Tomatoes', vi: 'Cà chua' }, [18, 0.9, 3.9, 0.2], unitOf(123, 'tomato', 'tomatoes', 'quả'), [0.5, 1, 2, 0.5], ['LV'],
    P(454, 1.99, '{q} lb', '{q} lb'), { src: 'Tomatoes, red, ripe, raw' }),
  // ---- fruit
  F('banana', 'fruit', 'plant', { en: 'Bananas', vi: 'Chuối' }, [89, 1.1, 22.8, 0.3], unitOf(118, 'banana', 'bananas', 'quả'), [0.5, 1, 2, 0.5], ['BF', 'S'],
    P(118, 0.29, '{n} bananas', '{n} quả chuối'), { asian: true, src: 'Bananas, raw (medium, 118 g)' }),
  F('apple', 'fruit', 'plant', { en: 'Apples', vi: 'Táo' }, [52, 0.3, 13.8, 0.2], unitOf(182, 'apple', 'apples', 'quả'), [1, 1, 2, 1], ['S', 'BF'],
    P(182, 0.75, '{n} apples', '{n} quả táo'), { src: 'Apples, raw, with skin (medium, 182 g)' }),
  F('orange', 'fruit', 'plant', { en: 'Oranges', vi: 'Cam' }, [49, 0.9, 12.5, 0.2], unitOf(140, 'orange', 'oranges', 'quả'), [1, 1, 2, 1], ['S', 'BF'],
    P(140, 0.89, '{n} oranges', '{n} quả cam'), { asian: true, src: 'Oranges, raw, navels (medium, 140 g)' }),
  F('blueberries', 'fruit', 'plant', { en: 'Blueberries', vi: 'Việt quất' }, [51, 0.4, 12.2, 0.6], CUP(155), [0.5, 0.5, 1.5, 0.5], ['BF', 'S'],
    P(454, 3.99, '{n} × 16 oz bag (frozen)', '{n} túi 16 oz (đông lạnh)', true), { src: 'Blueberries, frozen, unsweetened' }),
];
// cooking oil is not a "food preference" — it is part of cooking lunch and dinner (and the cheapest way to add calories)
export const OIL = F('oil', 'oil', 'plant', { en: 'Cooking oil (canola or olive)', vi: 'Dầu ăn (canola hoặc ô liu)' }, [884, 0, 0, 100], TSP(4.5), [0, 1, 3, 1], ['O'],
  P(1300, 4.99, '{n} × 48 oz bottle', '{n} chai 48 oz', true), { src: 'Oil, canola' });
export const FOOD_BY_ID = Object.fromEntries([...FOODS, OIL].map((f) => [f.id, f]));

export const CATS = [
  ['chicken', '🍗', { en: 'Chicken', vi: 'Thịt gà' }], ['beef', '🥩', { en: 'Beef', vi: 'Thịt bò' }], ['pork', '🐖', { en: 'Pork', vi: 'Thịt heo' }],
  ['fish', '🐟', { en: 'Fish & seafood', vi: 'Cá & hải sản' }], ['eggs', '🥚', { en: 'Eggs', vi: 'Trứng' }], ['dairy', '🥛', { en: 'Milk, yogurt, cheese', vi: 'Sữa, sữa chua, phô mai' }],
  ['beans', '🥫', { en: 'Beans & lentils', vi: 'Các loại đậu' }], ['tofu', '🥢', { en: 'Tofu', vi: 'Đậu hũ' }], ['rice', '🍚', { en: 'Rice', vi: 'Cơm / gạo' }],
  ['pasta', '🍝', { en: 'Pasta & noodles', vi: 'Mì, phở, bún' }], ['bread', '🍞', { en: 'Bread & tortillas', vi: 'Bánh mì, tortilla' }], ['potatoes', '🥔', { en: 'Potatoes', vi: 'Khoai tây, khoai lang' }],
  ['oats', '🥣', { en: 'Oatmeal', vi: 'Yến mạch' }], ['vegetables', '🥦', { en: 'Vegetables', vi: 'Rau củ' }], ['fruit', '🍎', { en: 'Fruit', vi: 'Trái cây' }], ['nuts', '🥜', { en: 'Nuts & peanut butter', vi: 'Các loại hạt, bơ đậu phộng' }],
].map(([id, icon, name]) => ({ id, icon, name }));
export const CAT_IDS = CATS.map((c) => c.id);
export const STYLES = [
  ['vegetarian', '🥗', { en: 'Vegetarian (no meat or fish)', vi: 'Ăn chay (không thịt, cá)' }],
  ['vegan', '🌱', { en: 'Vegan (no animal foods)', vi: 'Thuần chay (không đồ ăn từ động vật)' }],
  ['pescatarian', '🐟', { en: 'Fish but no other meat', vi: 'Ăn cá, không ăn thịt khác' }],
  ['noPork', '🚫', { en: 'No pork', vi: 'Không ăn thịt heo' }],
  ['noBeef', '🚫', { en: 'No beef', vi: 'Không ăn thịt bò' }],
  ['asian', '🥢', { en: 'Asian / Vietnamese style (rice, noodles, tofu, greens)', vi: 'Kiểu Á / Việt (cơm, phở, đậu hũ, rau)' }],
].map(([id, icon, name]) => ({ id, icon, name }));
export const BUDGETS = [{ id: 'budget', usd: 40, name: { en: 'Budget', vi: 'Tiết kiệm' } }, { id: 'moderate', usd: 70, name: { en: 'Moderate', vi: 'Vừa phải' } }, { id: 'flexible', usd: 110, name: { en: 'Flexible', vi: 'Thoải mái' } }];

export const NOTE = {
  doctor: { kind: 'info', en: 'If you have diabetes, heart or kidney disease, an eating disorder, or take daily medicine, show this plan to your doctor before you start.', vi: 'Nếu bạn bị tiểu đường, bệnh tim hoặc thận, rối loạn ăn uống, hay đang uống thuốc hằng ngày, hãy đưa kế hoạch này cho bác sĩ xem trước khi bắt đầu.' },
  floorApplied: { kind: 'warn', en: 'Your calories were below the safe minimum, so this plan uses the safe minimum instead.', vi: 'Lượng calo của bạn thấp hơn mức tối thiểu an toàn, nên kế hoạch dùng mức tối thiểu an toàn.' },
  surplusCapped: { kind: 'warn', en: 'To gain weight safely the plan keeps the extra calories to about 500 a day.', vi: 'Để tăng cân an toàn, kế hoạch giữ lượng calo dư khoảng 500 mỗi ngày.' },
  overBudget: { kind: 'warn', en: 'Your budget is too low for these foods at this many calories. Below is the cheapest plan we could make.', vi: 'Ngân sách quá thấp cho những món này với lượng calo này. Dưới đây là kế hoạch rẻ nhất có thể.' },
  offTarget: { kind: 'warn', en: 'With only the foods you picked, some days cannot reach your calories. Add more kinds of food (see below).', vi: 'Chỉ với những món bạn chọn, có ngày không đủ calo. Hãy thêm loại món ăn (xem bên dưới).' },
  lowProtein: { kind: 'warn', en: 'Protein is low with the foods you picked. Eggs, beans, tofu, Greek yogurt, chicken or fish would help.', vi: 'Lượng đạm thấp với những món bạn chọn. Trứng, đậu, đậu hũ, sữa chua Hy Lạp, thịt gà hoặc cá sẽ giúp.' },
  emptyMeal: { kind: 'info', en: 'Some meals are empty because none of the foods you picked fit them — add eggs, oats, bread or fruit for breakfast.', vi: 'Có bữa trống vì không món nào bạn chọn hợp với bữa đó — hãy thêm trứng, yến mạch, bánh mì hoặc trái cây cho bữa sáng.' },
  sameDinner: { kind: 'info', en: 'You picked few foods, so dinners repeat. Tick more foods for more variety.', vi: 'Bạn chọn ít món nên bữa tối lặp lại. Hãy chọn thêm món để đa dạng hơn.' },
  noFood: { kind: 'stop', en: 'No foods are left to plan with — tick more foods, or check your diet style and allergies.', vi: 'Không còn món nào để lập kế hoạch — hãy chọn thêm món, hoặc xem lại kiểu ăn và dị ứng.' },
  noTarget: { kind: 'stop', en: 'Set your weight goal first, so the plan knows how many calories to give you.', vi: 'Hãy đặt mục tiêu cân nặng trước, để kế hoạch biết nên cho bạn bao nhiêu calo.' },
};

// ---------------------------------------------------------------------------------------------
// Which foods may be planned: picked categories, minus diet style, minus anything that contains OR may
// contain one of the user's allergens (never "probably fine").
// ---------------------------------------------------------------------------------------------
export function styleBlocks(food, styles = []) {
  const s = new Set(styles);
  if ((s.has('vegetarian') || s.has('vegan')) && (food.kind === 'meat' || food.kind === 'fish')) return true;
  if (s.has('vegan') && (food.kind === 'egg' || food.kind === 'dairy')) return true;
  if (s.has('pescatarian') && food.kind === 'meat') return true;
  if (s.has('noPork') && food.meat === 'pork') return true;
  if (s.has('noBeef') && food.meat === 'beef') return true;
  return false;
}
export const allergyBlocks = (food, allergens = []) => food.alg.some((a) => allergens.includes(a)) || food.may.some((a) => allergens.includes(a));
export function allowedFoods({ likes = CAT_IDS, styles = [], allergens = [] } = {}) {
  const like = new Set(likes);
  const ok = [], leftOutAllergy = [];
  for (const f of FOODS) {
    if (!like.has(f.cat) || styleBlocks(f, styles)) continue;
    if (allergyBlocks(f, allergens)) { leftOutAllergy.push(f); continue; }
    ok.push(f);
  }
  return { foods: ok, leftOutAllergy };
}

// ---------------------------------------------------------------------------------------------
// Portions
// ---------------------------------------------------------------------------------------------
const per = (f, q, k) => (f.per100[k] * q * f.hh.g) / 100;
const FRAC = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' };
export function fmtQty(q) {
  const whole = Math.floor(q + 1e-9), rest = Math.round((q - whole) * 4) / 4;
  const fr = FRAC[rest] != null ? FRAC[rest] : String(r1(rest)).replace(/^0/, '');
  return whole ? `${whole}${fr ? ` ${fr}` : ''}` : fr || '0';
}
const FORM = { cooked: { en: 'cooked', vi: 'chín' }, dry: { en: 'dry', vi: 'khô' }, baked: { en: 'baked', vi: 'nướng' } };
// "1 ¼ cups cooked (198 g)" / "1 ¼ cốc chín (198 g)"
export function portionText(food, q) {
  const g = Math.round(q * food.hh.g), n = fmtQty(q), form = food.form ? FORM[food.form] : null;
  const en = `${n} ${q > 1 ? food.hh.en[1] : food.hh.en[0]}${form ? ` ${form.en}` : ''} (${g} g)`;
  const vi = `${n} ${food.hh.vi}${form ? ` ${form.vi}` : ''} (${g} g)`;
  return { en, vi };
}
const fill = (tpl, n, q) => tpl.replace('{n}', String(n)).replace('{q}', String(q));
export const buyText = (food, packs) => ({ en: fill(food.pack.en, packs, packs), vi: fill(food.pack.vi, packs, packs) });

// ---------------------------------------------------------------------------------------------
// Building one week
// ---------------------------------------------------------------------------------------------
const costPerG = (f) => f.pack.price / f.pack.g;
const MEAL_SLOTS = { breakfast: ['BP', 'BC', 'BF'], lunch: ['LP', 'LC', 'LV', 'O'], dinner: ['DP', 'DC', 'DV', 'O'], snack: ['S'] };
export const PLAN_MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const ROLE = (slot) => (slot === 'O' ? 'O' : slot === 'S' ? 'S' : slot[1]);   // P C F V O S
const KCAL_SHARE = { breakfast: 0.25, lunch: 0.30, dinner: 0.35, snack: 0.10 };
const PROT_SHARE = { breakfast: 0.25, lunch: 0.35, dinner: 0.40, snack: 0 };
// How many different foods each slot rotates through, by budget level: 0 = most variety (one from each picked
// food group first) ... 4 = cheapest. Keep-well staples (rice, pasta, frozen veg) only count the part used, so even the
// cheapest level keeps two carbs and two vegetables — dinners still change from day to day.
const LEVELS = [
  { spread: true, P: 4, C: 3, V: 3, F: 3, S: 3, BP: 2, BC: 2 },
  { spread: true, P: 3, C: 3, V: 2, F: 2, S: 2, BP: 2, BC: 2 },
  { spread: false, P: 3, C: 2, V: 2, F: 2, S: 2, BP: 2, BC: 2 },
  { spread: false, P: 2, C: 2, V: 2, F: 1, S: 1, BP: 1, BC: 1 },
  { spread: false, P: 1, C: 2, V: 2, F: 1, S: 1, BP: 1, BC: 1 },
];
export const LEVEL_COUNT = LEVELS.length;

function sortKey(f, role, cheapOnly) {
  // protein: $ per gram of protein; with room in the budget, calories per gram of protein count too, so lean
  // protein (chicken, fish, tofu, yogurt) comes before calorie-dense protein (peanut butter, salmon)
  if (role === 'P') return costPerG(f) / Math.max(0.01, f.per100.p / 100) + (cheapOnly ? 0 : 0.01 * f.per100.kcal / Math.max(0.01, f.per100.p));
  if (role === 'C' || role === 'S') return costPerG(f) / Math.max(0.01, f.per100.kcal / 100);   // $ per kcal
  return costPerG(f) * f.hh.g * f.steps.start;                                         // $ per serving
}
const byCost = (role, cheapOnly) => (a, b) => sortKey(a, role, cheapOnly) - sortKey(b, role, cheapOnly) || a.id.localeCompare(b.id);
// variety for bigger budgets: one food from each picked group first (cheapest in each), then the next cheapest
const spread = (list, k) => {
  const seen = new Set(), first = [], rest = [];
  for (const f of list) (seen.has(f.cat) ? rest : first).push(f), seen.add(f.cat);
  return [...first, ...rest].slice(0, k);
};
function pools(foods, level, asian) {
  const L = LEVELS[level], out = {};
  for (const slot of ['DP', 'DC', 'DV', 'LP', 'LC', 'LV', 'BP', 'BC', 'BF', 'S']) {
    const role = ROLE(slot);
    // white rice / noodles for breakfast only in Asian style (rice with peanut butter is nobody's breakfast)
    let list = foods.filter((f) => f.slots.includes(slot) || (asian && slot === 'BC' && f.slots.includes('BCa'))).sort(byCost(role, !L.spread));
    // Asian style: Asian-style foods first when there is room in the budget; the cheap levels stay cheapest-first
    if (asian && L.spread && (role === 'C' || role === 'V' || role === 'P')) { const a = list.filter((f) => f.asian); if (a.length) list = [...a, ...list.filter((f) => !f.asian)]; }
    if (asian && slot[0] !== 'B' && role === 'C') { const a = list.filter((f) => f.asian); if (a.length) list = a; }
    // lunch re-uses what dinner already bought when the budget is tight (one package instead of two)
    if (level >= 1 && slot[0] === 'L' && out[`D${slot[1]}`]) {
      const shared = out[`D${slot[1]}`];
      list = [...list.filter((f) => shared.includes(f)), ...list.filter((f) => !shared.includes(f))];
    }
    const k = L[slot] || L[role];
    out[slot] = L.spread ? spread(list, k) : list.slice(0, k);
  }
  return out;
}

const pick = (pool, i, avoid = [], fits = () => true) => {
  if (!pool.length) return null;
  for (const strict of [true, false]) {
    for (let k = 0; k < pool.length; k++) { const f = pool[(i + k) % pool.length]; if (!avoid.includes(f) && (!strict || fits(f))) return f; }
  }
  return pool[i % pool.length];
};
// a carb that goes with this protein (no tofu sandwiches, no rice with a glass of milk)
const goesWith = (prot) => (carb) => !prot || !carb.notWith.includes(prot.id);
function composeDay(pl, d) {
  const meals = {};
  const dp = pick(pl.DP, d), dc = pick(pl.DC, d, [], goesWith(dp)), dv = pick(pl.DV, d + 1);
  meals.dinner = [['P', dp], ['C', dc], ['V', dv]];
  const lp = pick(pl.LP, d + 1, [dp]), lc = pick(pl.LC, d + 1, [dc], goesWith(lp)), lv = pick(pl.LV, d, [dv]);
  meals.lunch = [['P', lp], ['C', lc], ['V', lv]];
  const bc = pick(pl.BC, d), bf = pick(pl.BF, d);
  const bp = pick(pl.BP, d, [], (p) => !bc || !bc.notWith.includes(p.id));
  meals.breakfast = [['P', bp], ['C', bc], ['F', bf]];
  meals.snack = [['S', pick(pl.S, d, [bf, lp, bp, lv])]];
  for (const m of ['lunch', 'dinner']) if (meals[m].some(([, f]) => f)) meals[m].push(['O', OIL]);
  for (const m of PLAN_MEALS) meals[m] = meals[m].filter(([, f]) => f).map(([role, f]) => ({ role, f, q: 0 }));
  return meals;
}

const itemKcal = (it) => per(it.f, it.q, 'kcal');
const itemProt = (it) => per(it.f, it.q, 'p');
const sum = (list, fn) => list.reduce((s, x) => s + fn(x), 0);
const snapQ = (f, q) => Math.min(f.steps.max, Math.max(f.steps.min, Math.round(q / f.steps.inc) * f.steps.inc));

// size one day's portions to hit the calorie target (±2.5% aim, ±5% hard) with protein at or above the minimum
function sizeDay(meals, T, pAim, pMin) {
  const pMax = pAim * 1.5;   // don't pile on protein just to add calories (fruit, carbs and oil come first)
  for (const m of PLAN_MEALS) {
    const list = meals[m];
    for (const it of list) if (it.role === 'V' || it.role === 'F' || it.role === 'O') it.q = it.f.steps.start;
    const prot = list.find((it) => it.role === 'P');
    if (prot) it_setByProtein(prot, 0.85 * pAim * PROT_SHARE[m]);   // ~15% of the day's protein comes from grains, beans, milk and vegetables
    const fixed = sum(list.filter((it) => it.role !== 'C' && it.role !== 'S'), itemKcal);
    for (const it of list) if (it.role === 'C' || it.role === 'S') it.q = snapQ(it.f, (T * KCAL_SHARE[m] - fixed) / per(it.f, 1, 'kcal'));
  }
  const all = PLAN_MEALS.flatMap((m) => meals[m]);
  const total = () => sum(all, itemKcal), prot = () => sum(all, itemProt);
  const step = (it, dir) => {
    const nq = Math.round((it.q + dir * it.f.steps.inc) * 100) / 100;
    if (nq < it.f.steps.min - 1e-9 || nq > it.f.steps.max + 1e-9) return null;
    return nq;
  };
  const UP = ['C', 'S', 'O', 'F', 'P', 'V'], DOWN = ['O', 'C', 'S', 'F', 'P', 'V'];
  const fit = (noProteinDown = false, pCap = pMax) => {
    for (let guard = 0; guard < 400; guard++) {
      const err = T - total();
      if (Math.abs(err) <= 0.02 * T) return;
      const dir = err > 0 ? 1 : -1;
      let done = false;
      for (const role of dir > 0 ? UP : DOWN) {
        if (noProteinDown && role === 'P' && dir < 0) continue;
        let best = null;
        for (const it of all) {
          if (it.role !== role) continue;
          const nq = step(it, dir);
          if (nq == null) continue;
          const dk = per(it.f, nq - it.q, 'kcal');
          const newErr = Math.abs(err - dk);
          if (newErr >= Math.abs(err) - 1e-6) continue;
          if (dir < 0 && role === 'P' && prot() - per(it.f, it.q - nq, 'p') < pMin) continue;
          if (dir > 0 && role === 'P' && prot() + per(it.f, nq - it.q, 'p') > pCap) continue;
          // the closest result wins; a tie goes to the portion that is smallest relative to its range (spreads it out)
          const fill = (it.q - it.f.steps.min) / Math.max(1e-9, it.f.steps.max - it.f.steps.min);
          if (!best || newErr < best.newErr - 1e-6 || (Math.abs(newErr - best.newErr) <= 1e-6 && (dir > 0 ? fill < best.fill : fill > best.fill))) best = { it, nq, newErr, fill };
        }
        if (best) { best.it.q = best.nq; done = true; break; }
      }
      if (!done) return;
    }
  };
  fit();
  if (Math.abs(T - total()) > 0.05 * T) fit(false, Infinity);   // still short: protein foods may grow too
  // protein below the minimum: trade carbs for protein (protein up one step, then calories re-fitted without cutting protein)
  for (let guard = 0; guard < 30 && prot() < pMin; guard++) {
    const cands = all.filter((it) => (it.role === 'P' || (it.role === 'S' && it.f.per100.p * 4 >= 0.3 * it.f.per100.kcal)) && step(it, 1) != null).sort((a, b) => per(a.f, 1, 'kcal') / Math.max(0.01, per(a.f, 1, 'p')) - per(b.f, 1, 'kcal') / Math.max(0.01, per(b.f, 1, 'p')));
    if (!cands.length) break;
    cands[0].q = step(cands[0], 1);
    fit(true, Infinity);
  }
  function it_setByProtein(it, grams) { it.q = snapQ(it.f, grams / Math.max(0.01, per(it.f, 1, 'p'))); }
  return { kcal: total(), protein: prot() };
}

export function weekFrom(foods, level, ctx) {
  const pl = pools(foods, level, ctx.asian);
  const days = [];
  for (let d = 0; d < 7; d++) {
    const meals = composeDay(pl, d);
    const tot = sizeDay(meals, ctx.kcal, ctx.pAim, ctx.pMin);
    const outMeals = {};
    for (const m of PLAN_MEALS) {
      outMeals[m] = meals[m].filter((it) => it.q > 0).map((it) => ({ id: it.f.id, role: it.role, name: it.f.name, q: it.q, g: Math.round(it.q * it.f.hh.g),
        portion: portionText(it.f, it.q), kcal: Math.round(itemKcal(it)), protein: r1(itemProt(it)) }));
    }
    const dayK = sum(PLAN_MEALS.flatMap((m) => outMeals[m]), (x) => x.kcal);
    const dayP = sum(PLAN_MEALS.flatMap((m) => outMeals[m]), (x) => x.protein);
    days.push({ date: D.addDays(ctx.start, d), meals: outMeals, kcal: dayK, protein: r1(dayP), exactKcal: tot.kcal,
      dinnerKey: meals.dinner.filter((it) => it.role !== 'O').map((it) => it.f.id).join('+') });
  }
  // shopping list: edible grams per food over the week -> whole store packages
  const grams = {};
  for (const d of days) for (const m of PLAN_MEALS) for (const it of d.meals[m]) grams[it.id] = (grams[it.id] || 0) + it.g;
  const shopping = Object.entries(grams).map(([id, g]) => {
    const f = FOOD_BY_ID[id], packs = Math.max(1, Math.ceil(g / f.pack.g - 1e-9));
    const checkout = packs * f.pack.price, used = (g / f.pack.g) * f.pack.price;
    return { id, name: f.name, cat: f.cat, g, packs, buy: buyText(f, packs), price: f.pack.price, checkout: Math.round(checkout * 100) / 100,
      week: Math.round((f.pack.keeps ? used : checkout) * 100) / 100, keeps: f.pack.keeps };
  }).sort((a, b) => CAT_ORDER.indexOf(FOOD_BY_ID[a.id].cat) - CAT_ORDER.indexOf(FOOD_BY_ID[b.id].cat) || a.id.localeCompare(b.id));
  const weekCost = Math.round(sum(shopping, (s) => s.week) * 100) / 100;
  const checkoutCost = Math.round(sum(shopping, (s) => s.checkout) * 100) / 100;
  const fits = days.every((d) => Math.abs(d.kcal - ctx.kcal) <= 0.05 * ctx.kcal);   // the numbers the screen shows
  const lowProtein = days.some((d) => d.protein < ctx.pMin - 0.5);
  return { level, days, shopping, weekCost, checkoutCost, fits, lowProtein };
}
const CAT_ORDER = ['chicken', 'beef', 'pork', 'fish', 'eggs', 'dairy', 'tofu', 'beans', 'nuts', 'rice', 'pasta', 'bread', 'potatoes', 'oats', 'vegetables', 'fruit', 'oil'];

// The cheapest (fitting) week for a set of choices — used for "what to add" suggestions.
function cheapest(foods, ctx) {
  let best = null;
  for (let lv = 0; lv < LEVELS.length; lv++) {
    const w = weekFrom(foods, lv, ctx);
    if (!best || (w.fits && !best.fits) || (w.fits === best.fits && w.weekCost < best.weekCost)) best = w;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// The whole plan.
// profile: diet.js normalized profile (metric). dailyKcal / proteinG: from the user's saved goal (diet.js
// planToTarget / planByRate + nutritionTargets). mode: 'lose' | 'maintain' | 'gain'. tdeeKcal: today's burn
// (for the +500 gain cap). budget: US$ per week. likes: CAT ids. styles: STYLES ids. allergens: engine ids.
// ---------------------------------------------------------------------------------------------
export function makeWeekPlan({ profile, dailyKcal, proteinG, mode = 'maintain', tdeeKcal = null, budget = 70, likes = CAT_IDS, styles = [], allergens = [], startDate, rateKgPerWeek = null }) {
  const notes = [NOTE.doctor];
  if (!profile) return { ok: false, stop: [NOTE.noTarget], notes };
  const elig = D.planningEligibility(profile);
  if (!elig.ok) return { ok: false, stop: elig.reasons, notes };
  if (!(dailyKcal > 0)) return { ok: false, stop: [NOTE.noTarget], notes };
  // safety rails, checked again here: never below the AHA floor, never more than +500 over today's burn
  const floor = D.calorieFloor(profile);
  let kcal = dailyKcal;
  if (kcal < floor) { kcal = floor; notes.push(NOTE.floorApplied); }
  if (mode === 'gain' && tdeeKcal && kcal > tdeeKcal + D.SAFETY.maxSurplusKcal) { kcal = Math.floor((tdeeKcal + D.SAFETY.maxSurplusKcal) / 10) * 10; notes.push(NOTE.surplusCapped); }
  // protein: diet.js range (1.2–1.6 g/kg of a healthy reference weight when losing or gaining), capped at 35% of calories
  const pr = proteinG && proteinG.length === 2 ? proteinG : D.nutritionTargets({ profile, dailyKcal: kcal, phase: mode }).proteinG;
  const pMin = Math.min(pr[0], (0.35 * kcal) / 4), pAim = Math.min(pr[1], (0.35 * kcal) / 4);
  const asian = styles.includes('asian');
  const { foods, leftOutAllergy } = allowedFoods({ likes, styles, allergens });
  const start = startDate || D.addDays('2026-01-01', 0);
  const ctx = { kcal, pAim, pMin, asian, start };
  const exercise = exercisePlan({ profile, mode, rateKgPerWeek });
  const water = waterCups(profile);
  const base = { kcal, requestedKcal: dailyKcal, floorKcal: floor, protein: { min: Math.round(pMin), aim: Math.round(pAim) }, budget, mode, exercise, water,
    leftOutAllergy: leftOutAllergy.map((f) => ({ id: f.id, name: f.name })), start };
  if (!foods.length) return { ...base, ok: false, stop: [NOTE.noFood], notes };

  // most variety that fits the budget; otherwise the cheapest week we can make (and say so)
  let chosen = null, overBudget = false;
  const tried = [];
  for (let lv = 0; lv < LEVELS.length; lv++) {
    const w = weekFrom(foods, lv, ctx);
    tried.push(w);
    if (w.fits && !w.lowProtein && w.weekCost <= budget) { chosen = w; break; }
  }
  if (!chosen) {
    const fitting = tried.filter((w) => w.fits && !w.lowProtein).length ? tried.filter((w) => w.fits && !w.lowProtein) : tried.filter((w) => w.fits);
    chosen = (fitting.length ? fitting : tried).reduce((a, b) => (b.weekCost < a.weekCost ? b : a));
    overBudget = chosen.weekCost > budget;
  }
  const suggestions = [];
  if (overBudget || !chosen.fits || chosen.lowProtein) {
    const blocked = new Set(likes);
    for (const c of CAT_IDS) {
      if (blocked.has(c)) continue;
      const more = allowedFoods({ likes: [...likes, c], styles, allergens }).foods;
      if (more.length === foods.length) continue;      // style / allergies leave nothing new in that group
      const w = cheapest(more, ctx);
      const better = (!chosen.fits && w.fits) || (chosen.lowProtein && !w.lowProtein && w.fits) || (w.fits && w.weekCost < chosen.weekCost - 0.5);
      if (better) suggestions.push({ cat: c, weekCost: w.weekCost, saves: Math.round((chosen.weekCost - w.weekCost) * 100) / 100, fixesCalories: !chosen.fits && w.fits, fixesProtein: chosen.lowProtein && !w.lowProtein });
    }
    suggestions.sort((a, b) => (b.fixesCalories - a.fixesCalories) || (b.fixesProtein - a.fixesProtein) || a.weekCost - b.weekCost || a.cat.localeCompare(b.cat));
    suggestions.splice(3);
  }
  if (overBudget) notes.push(NOTE.overBudget);
  if (!chosen.fits) notes.push(NOTE.offTarget);
  if (chosen.lowProtein) notes.push(NOTE.lowProtein);
  const dinners = new Set(chosen.days.map((d) => d.dinnerKey));
  const repeatsDaily = chosen.days.some((d, i) => i > 0 && d.dinnerKey === chosen.days[i - 1].dinnerKey);
  if (dinners.size === 1 || repeatsDaily) notes.push(NOTE.sameDinner);
  if (chosen.days.some((d) => PLAN_MEALS.some((m) => !d.meals[m].length))) notes.push(NOTE.emptyMeal);
  return { ...base, ok: true, days: chosen.days, shopping: chosen.shopping, weekCost: chosen.weekCost, checkoutCost: chosen.checkoutCost,
    withinBudget: !overBudget, overBudget, fits: chosen.fits, lowProtein: chosen.lowProtein, level: chosen.level, suggestions, notes,
    distinctDinners: dinners.size, cheapestCost: overBudget ? chosen.weekCost : null };
}

// ---------------------------------------------------------------------------------------------
// Daily exercise (CDC / WHO adult guidance), scaled to the goal and the activity level in the profile.
// The food plan does NOT eat these calories back: the calorie target already assumes the activity level
// the user chose. For someone who chose sedentary/light, a new daily walk is a BONUS on top of the plan.
// ---------------------------------------------------------------------------------------------
const MET_WALK = 3.5, MET_STRENGTH = 3.5, STRENGTH_MIN = 15, STEPS_PER_MIN = 100;
export const MOVES = {
  squat: { en: 'Chair squats (sit down, stand up) — 2 rounds of 10', vi: 'Ngồi xuống đứng lên khỏi ghế — 2 hiệp × 10 lần' },
  pushup: { en: 'Wall push-ups — 2 rounds of 10', vi: 'Hít đất vào tường — 2 hiệp × 10 lần' },
  bridge: { en: 'Glute bridges (lying on your back, lift hips) — 2 rounds of 12', vi: 'Nằm ngửa nâng hông — 2 hiệp × 12 lần' },
  plank: { en: 'Plank (knees down is fine) — 2 × 20 seconds', vi: 'Plank (chống gối cũng được) — 2 lần × 20 giây' },
  row: { en: 'Backpack rows (bend forward, pull a loaded backpack up) — 2 rounds of 10', vi: 'Kéo ba lô (cúi người, kéo ba lô có đồ lên) — 2 hiệp × 10 lần' },
  balance: { en: 'Balance: stand on one foot, holding a chair — 3 × 20 seconds each leg', vi: 'Thăng bằng: đứng một chân, vịn ghế — 3 lần × 20 giây mỗi chân' },
};
export function exercisePlan({ profile, mode = 'maintain', rateKgPerWeek = null }) {
  const kg = profile.weightKg, act = profile.activity || 'light';
  let goalMin = mode === 'lose' ? 40 : mode === 'gain' ? 25 : 30;
  if (mode === 'lose' && rateKgPerWeek != null && Math.abs(rateKgPerWeek) >= 0.7) goalMin = 45;
  const startLow = act === 'sedentary';
  const walkMin = startLow ? Math.min(goalMin, 25) : goalMin;       // 25 min x 7 = 175 min/week: still above the 150-minute minimum
  const strengthDays = mode === 'gain' ? [0, 2, 4] : [1, 4];
  const balanceDays = profile.age >= 65 ? [0, 2, 4] : [];
  const moves = ['squat', 'pushup', 'bridge', mode === 'gain' ? 'row' : 'plank'];
  const net = (met, min) => Math.round((met - 1) * kg * (min / 60));
  return {
    walkMin, goalMin, startLow, steps: walkMin * STEPS_PER_MIN, weeklyMin: walkMin * 7,
    strengthDays, balanceDays, moves, strengthMin: STRENGTH_MIN,
    walkKcal: net(MET_WALK, walkMin), strengthKcal: net(MET_STRENGTH, STRENGTH_MIN),
    bonus: act === 'sedentary' || act === 'light',   // a new daily walk is EXTRA burn on top of the activity level the calories assume
  };
}
export const waterCups = (profile) => (profile.sex === 'male' ? 13 : profile.sex === 'female' ? 9 : 11);

// ---------------------------------------------------------------------------------------------
// Checkboxes: one tick per task per DATE, kept per plan, so a new plan never wipes old ticks.
// storage = anything with getItem/setItem (localStorage on the phone, a fake in tests).
// ---------------------------------------------------------------------------------------------
export const DAY_TASKS = ['breakfast', 'lunch', 'dinner', 'snack', 'exercise', 'water'];
export const CHECKS_KEY = 'fs_mp_checks';
export function checkStore(storage, key = CHECKS_KEY) {
  const load = () => { try { const v = JSON.parse(storage.getItem(key)); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const save = (all) => { try { storage.setItem(key, JSON.stringify(all)); return true; } catch { return false; } };
  return {
    get: (planId, k) => !!(load()[planId] || {})[k],
    set(planId, k, on) {
      const all = load(); const p = all[planId] || {};
      if (on) p[k] = 1; else delete p[k];
      all[planId] = p; return save(all);
    },
    all: (planId) => ({ ...(load()[planId] || {}) }),
    plans: () => Object.keys(load()),
  };
}
export const dayKey = (iso, task) => `${iso}|${task}`;
export const shopKey = (id) => `shop|${id}`;
export function dayProgress(ticks, iso) {
  const done = DAY_TASKS.filter((t) => ticks[dayKey(iso, t)]).length;
  return { done, total: DAY_TASKS.length };
}
