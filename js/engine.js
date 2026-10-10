// Food Score engine — the ONE source of truth for scoring, additives, eczema triggers,
// ingredient ratings, barcode handling and OCR label parsing. Pure functions only (no DOM),
// so the very same file runs in the phone browser and in `node --test`.
//
// Every user-facing sentence is a {en, vi} pair; the page picks the language.

// ---------------------------------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------------------------------
export const OFF_FIELDS = ['code', 'product_name', 'product_name_en', 'product_name_vi', 'brands', 'quantity',
  'image_front_url', 'image_front_small_url', 'image_front_thumb_url', 'image_small_url', 'image_url', 'ingredients_text', 'ingredients_text_en', 'ingredients_text_vi',
  'ingredients', 'allergens_tags', 'traces_tags', 'additives_tags', 'nutriments', 'nova_group',
  'nutriscore_score', 'nutriscore_grade', 'nutriscore', 'categories_tags', 'lang',
  // portion sizes for the calorie log (v1.7; cached products without them still work — diet.js falls back to `quantity`)
  'serving_size', 'serving_quantity', 'serving_quantity_unit', 'product_quantity', 'product_quantity_unit',
  'product_type'];   // which Open*Facts site holds it: food | beauty | petfood | product

// db: 'food' (Open Food Facts) | 'beauty' (Open Beauty Facts) | 'products' (Open Products Facts) — see DATABASES
export function offUrl(code, db = 'food') {
  const host = (DATABASES.find((d) => d.id === db) || DATABASES[0]).host;
  return `https://${host}/api/v2/product/${code}.json?fields=${OFF_FIELDS.join(',')}`;
}

// ONE call for all three sites: Open Beauty Facts with ?product_type=all answers for a product filed on ANY
// Open*Facts site (it redirects to the site that holds it; the redirect carries CORS headers). Asking each site
// separately missed products filed under another type (OBF answers 404 "found with a different product type").
export const offAllUrl = (code) => `https://world.openbeautyfacts.org/api/v2/product/${code}.json?product_type=all&fields=${OFF_FIELDS.join(',')}`;
// which database a combined-call answer came from: the product's own product_type, else the host it was served by
export function dbOfProduct(p, finalUrl = '') {
  const pt = p && p.product_type;
  if (pt === 'beauty') return 'beauty';
  if (pt === 'product') return 'products';
  if (pt === 'food' || pt === 'petfood') return 'food';
  if (/openbeautyfacts\./.test(finalUrl)) return 'beauty';
  if (/openproductsfacts\./.test(finalUrl)) return 'products';
  return 'food';
}

// openFDA drug labels (public domain, no key, ~1,000 calls/day per phone): over-the-counter personal care such as
// sunscreen, antiperspirant, toothpaste and dandruff shampoo carries an FDA "Drug Facts" label with active and
// inactive ingredients. Searched by the 0-padded 13-digit UPC (the form openFDA stores).
export const FDA_SOURCE = { id: 'fda', name: 'FDA drug label (openFDA)' };
export function fdaUpc13(code) {
  let c = String(code || '').replace(/\D/g, '');
  if (c.length === 8) c = expandUpcE(c) || '';
  if (c.length === 12) c = '0' + c;
  return c.length === 13 ? c : '';
}
export const fdaLabelUrl = (code) => { const c = fdaUpc13(code); return c ? `https://api.fda.gov/drug/label.json?search=openfda.upc:%22${c}%22&limit=1` : ''; };
export function classifyFdaResponse(httpStatus, body) {
  if (httpStatus === 200 && body && Array.isArray(body.results) && body.results.length) return 'found';
  if (httpStatus === 404) return 'notfound';   // openFDA: {"error":{"code":"NOT_FOUND"}}
  return 'failed';
}
// "Active ingredient(s) Avobenzone 3% ... Purpose Sunscreen" + "Inactive ingredients water, ..." -> one ingredient list
const fdaText = (v) => (Array.isArray(v) ? v.join(' ') : String(v || '')).replace(/\s+/g, ' ').trim();
export function fdaIngredientsText(label) {
  const active = fdaText(label.active_ingredient)
    .replace(/^\s*(drug\s+facts\s+)?active\s+ingredients?\s*(\((?:in each|per)[^)]*\))?\s*[:\-–]?\s*/i, '')
    .replace(/\(\s*\d+(?:\.\d+)?\s*%[^)]*\)/g, ',')          // "Aluminum Sesquichlorohydrate (16%)" -> "Aluminum Sesquichlorohydrate,"
    .replace(/\bpurposes?\b[\s\S]*$/i, '')                         // the "Purpose" column is not an ingredient
    .replace(/\s*\d+(?:\.\d+)?\s*%\s*(?:w\/w|w\/v)?/gi, ',')   // "Avobenzone 3% Homosalate 10%" -> "Avobenzone, Homosalate,"
    .replace(/\s*,\s*(,\s*)*/g, ', ').replace(/,\s*\(/g, ' (').replace(/^[,\s]+|[,\s.]+$/g, '');
  const inactive = fdaText(label.inactive_ingredient)
    .replace(/^\s*(drug\s+facts\s+)?inactive\s+ingredients?\s*[:\-–]?\s*/i, '').replace(/[\s.]+$/, '');
  return [active, inactive].filter(Boolean).join(', ');
}
export function productFromFdaLabel(label) {
  const o = label.openfda || {};
  const first = (a) => (Array.isArray(a) ? a[0] : a) || '';
  return { product_name: first(o.brand_name) || first(o.generic_name) || '', brands: first(o.manufacturer_name), ingredients_text: fdaIngredientsText(label), ingredients_source: 'fda' };
}

// The whole barcode lookup, with the network passed in (so it is tested with a fake fetch):
//   fetchJson(url) -> {status, body, url}   (status 0 = no answer)
// 1) the combined Open*Facts call for every barcode candidate; 2) only if that call could not be answered, the
// old one-site-at-a-time chain; 3) for a non-food product with no ingredient list, or a code no site has, the FDA
// drug label. States stay three: found / notfound / failed (a site that did not answer is never "not found").
export async function lookupProduct(raw, { fetchJson, format = '' } = {}) {
  const cands = lookupCandidates(raw, format);
  const ask = async (url) => { try { return (await fetchJson(url)) || { status: 0, body: null, url }; } catch { return { status: 0, body: null, url }; } };
  let hit = null, failed = false, via = 'all';
  for (const c of cands) {
    const r = await ask(offAllUrl(c));
    const st = classifyOffResponse(r.status, r.body);
    if (st === 'found') { hit = { code: c, product: r.body.product, db: dbOfProduct(r.body.product, r.url || '') }; break; }
    if (st === 'failed') failed = true;
  }
  let state = hit ? 'found' : failed ? 'failed' : 'notfound';
  if (!hit && failed) {                       // the combined call did not answer: ask each site (old chain)
    via = 'chain';
    const results = [];
    for (const d of DATABASES) {
      const res = { state: 'notfound', db: d.id };
      for (const c of cands) {
        const r = await ask(offUrl(c, d.id));
        const st = classifyOffResponse(r.status, r.body);
        if (st === 'found') { Object.assign(res, { state: 'found', product: r.body.product, code: c }); break; }
        if (st === 'failed') res.state = 'failed';
      }
      results.push(res);
      if (res.state === 'found') break;
    }
    const comb = combineLookups(results);
    if (comb.state === 'found') hit = { code: comb.code, product: comb.product, db: comb.db };
    state = comb.state;
  }
  const nonFood = hit && productTypeOf(hit.db, hit.product.categories_tags || []) !== 'food';
  let fda = 'skipped';
  if ((nonFood && !pickIngredientText(hit.product).trim()) || state === 'notfound') {
    const url = fdaLabelUrl(raw);
    if (url) {
      const r = await ask(url);
      fda = classifyFdaResponse(r.status, r.body);
      if (fda === 'found') {
        const fp = productFromFdaLabel(r.body.results[0]);
        if (fp.ingredients_text) {
          if (hit) hit.product = { ...hit.product, ingredients_text: fp.ingredients_text, ingredients_source: 'fda' };
          else { hit = { code: cands[0], product: { ...fp, code: cands[0] }, db: 'fda' }; state = 'found'; }
        }
      }
    }
  }
  // a database that could not be asked is not an answer of "no such product": say we could not check
  if (!hit && state === 'notfound' && fda === 'failed') state = 'failed';
  return hit ? { state: 'found', ...hit, tried: cands, via, fda } : { state, tried: cands, via, fda };
}

// Classify one OFF response into the three states. `httpStatus` 0 = network error.
// found        -> product usable
// notfound     -> OFF answered and genuinely has no such product (status 0 / HTTP 404)
// failed       -> could not get an answer (network, 429, 5xx, garbage) — NEVER cached, never "not found"
export function classifyOffResponse(httpStatus, body) {
  if (!httpStatus) return 'failed';
  if (httpStatus === 429 || httpStatus >= 500) return 'failed';
  if (body && typeof body === 'object') {
    if (body.status === 1 && body.product) return 'found';
    if (body.status === 0 || httpStatus === 404) return 'notfound';
  }
  if (httpStatus === 404) return 'notfound';
  return 'failed';
}

// ---------------------------------------------------------------------------------------------
// Barcodes: EAN-13, EAN-8, UPC-A (12), UPC-E (8)
// ---------------------------------------------------------------------------------------------
function gs1CheckOk(code) {
  if (!/^\d{8,14}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
export { gs1CheckOk as checkDigitOk };

// UPC-E (8 digits: number system 0/1, six data digits, check digit) -> UPC-A (12 digits).
export function expandUpcE(code) {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0], x = code.slice(1, 7), c = code[7];
  const [x1, x2, x3, x4, x5, d6] = x.split('');
  let body;
  if ('012'.includes(d6)) body = x1 + x2 + d6 + '0000' + x3 + x4 + x5;
  else if (d6 === '3') body = x1 + x2 + x3 + '00000' + x4 + x5;
  else if (d6 === '4') body = x1 + x2 + x3 + x4 + '00000' + x5;
  else body = x1 + x2 + x3 + x4 + x5 + '0000' + d6;
  const upca = ns + body + c;
  return gs1CheckOk(upca) ? upca : null;
}

// Which codes to ask Open Food Facts for, in order. `format` is the scanner's format name if known.
export function lookupCandidates(raw, format = '') {
  const code = String(raw || '').replace(/\D/g, '');
  if (!code) return [];
  const f = String(format).toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  if (f === 'upce' && code.length === 8) {
    const a = expandUpcE(code);
    if (a) { add(a); add('0' + a); }
    add(code);
    return out;
  }
  add(code);
  if (code.length === 12) add('0' + code);                         // UPC-A -> EAN-13
  if (code.length === 13 && code[0] === '0') add(code.slice(1));  // EAN-13 with leading 0 -> UPC-A
  if (code.length === 8) {                                        // typed 8 digits: EAN-8 or UPC-E
    const a = expandUpcE(code);
    if (a) { add(a); add('0' + a); }
  }
  if (code.length < 13 && code.length !== 8) add(code.padStart(13, '0'));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text matching helpers
// ---------------------------------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reCache = new Map();
function wordRe(w) {
  let re = reCache.get(w);
  if (!re) {
    const plural = /^[a-z ]+[a-z]$/.test(w) && !/s$/.test(w) ? '(?:e?s)?' : '';
    re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(w)}${plural}(?![\\p{L}\\p{N}])`, 'iu');
    reCache.set(w, re);
  }
  return re;
}
export function norm(s) {
  return String(s || '').normalize('NFC').toLowerCase()
    .replace(/[_]/g, ' ').replace(/\s+/g, ' ').trim();
}
const phraseCache = new Map();
function stripPhrases(text, phrases) {
  let t = text;
  for (const p of phrases || []) {
    let re = phraseCache.get(p);
    if (!re) { re = new RegExp(esc(p), 'giu'); phraseCache.set(p, re); }
    t = t.replace(re, ' ');
  }
  return t;
}
function matchesAny(text, words, notPhrases) {
  const t = stripPhrases(text, notPhrases);
  for (const w of words) if (wordRe(w).test(t)) return w;
  return null;
}
// E-numbers / INS numbers in free text: "E150d", "e 211", "INS 621", "E322(i)"
export function eNumbersInText(text) {
  const out = new Set();
  const re = /(?<![\p{L}\p{N}])(?:e|ins)\s?-?(\d{3,4})\s?([a-f])?(?:\s?\(?\s?([ivx]+)\s?\))?(?![\p{L}\p{N}])/giu;
  let m;
  while ((m = re.exec(text))) out.add(('e' + m[1] + (m[2] || '')).toLowerCase());
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// ADDITIVES table (hand-kept). risk: high | moderate | low. Points off the 30-point additive score.
// ---------------------------------------------------------------------------------------------
const WHY = {
  azo: { en: 'artificial dye linked to hyperactivity in children (EU requires a warning label)', vi: 'phẩm màu nhân tạo, liên quan đến tăng động ở trẻ em (EU bắt buộc dán cảnh báo)' },
  nitrite: { en: 'preservative in processed meat; forms cancer-linked nitrosamines', vi: 'chất bảo quản trong thịt chế biến; tạo nitrosamine liên quan đến ung thư' },
  caramel4: { en: 'caramel colour that can contain 4-MEI, a possible carcinogen', vi: 'màu caramel có thể chứa 4-MEI, chất có thể gây ung thư' },
  sweet: { en: 'artificial sweetener; long-term safety is debated', vi: 'chất tạo ngọt nhân tạo; độ an toàn lâu dài còn tranh cãi' },
  gut: { en: 'emulsifier/thickener that harmed the gut lining or gut bacteria in studies', vi: 'chất nhũ hoá/làm đặc gây hại niêm mạc ruột hoặc vi khuẩn đường ruột trong nghiên cứu' },
  phos: { en: 'added phosphate — too much is linked to kidney and heart problems', vi: 'phosphat thêm vào — quá nhiều liên quan đến bệnh thận và tim' },
  benz: { en: 'preservative; can form benzene with vitamin C and may trigger reactions', vi: 'chất bảo quản; có thể tạo benzen khi gặp vitamin C và gây phản ứng' },
  sulph: { en: 'preservative that can trigger asthma and allergy-type reactions', vi: 'chất bảo quản có thể gây hen suyễn và phản ứng dị ứng' },
  dye: { en: 'artificial dye; some safety concerns', vi: 'phẩm màu nhân tạo; có một số lo ngại về an toàn' },
  alu: { en: 'aluminium-based additive; aluminium builds up in the body', vi: 'phụ gia chứa nhôm; nhôm tích tụ trong cơ thể' },
  polys: { en: 'synthetic emulsifier; may disturb gut bacteria', vi: 'chất nhũ hoá tổng hợp; có thể ảnh hưởng vi khuẩn đường ruột' },
  enh: { en: 'flavour enhancer; some people feel unwell after large amounts', vi: 'chất điều vị; một số người thấy khó chịu khi ăn nhiều' },
  sorb: { en: 'preservative; generally well tolerated', vi: 'chất bảo quản; thường dung nạp tốt' },
  prop: { en: 'preservative; possible link to irritability in children', vi: 'chất bảo quản; có thể liên quan đến cáu gắt ở trẻ' },
  polyol: { en: 'sugar alcohol; can cause bloating or a laxative effect', vi: 'đường rượu; có thể gây đầy hơi hoặc nhuận tràng' },
};
const A = (codes, risk, label, why, names = []) => ({ codes, risk, label, why, names });
export const ADDITIVES = [
  // --- HIGH ---
  A(['e102'], 'high', { en: 'Tartrazine (Yellow 5)', vi: 'Tartrazine (Vàng 5)' }, WHY.azo, ['tartrazine', 'yellow 5', 'yellow #5', 'yellow no. 5', 'yellow no 5']),
  A(['e104'], 'high', { en: 'Quinoline yellow', vi: 'Vàng quinoline' }, WHY.azo, ['quinoline yellow']),
  A(['e110'], 'high', { en: 'Sunset yellow (Yellow 6)', vi: 'Vàng hoàng hôn (Vàng 6)' }, WHY.azo, ['sunset yellow', 'yellow 6', 'yellow #6', 'yellow no. 6', 'yellow no 6']),
  A(['e122'], 'high', { en: 'Carmoisine', vi: 'Carmoisine' }, WHY.azo, ['carmoisine', 'azorubine']),
  A(['e123'], 'high', { en: 'Amaranth dye (E123)', vi: 'Phẩm màu amaranth (E123)' }, { en: 'red dye banned in US food', vi: 'phẩm màu đỏ bị cấm trong thực phẩm ở Mỹ' }),
  A(['e124'], 'high', { en: 'Ponceau 4R', vi: 'Ponceau 4R' }, WHY.azo, ['ponceau 4r', 'ponceau']),
  A(['e127'], 'high', { en: 'Erythrosine (Red 3)', vi: 'Erythrosine (Đỏ 3)' }, { en: 'dye the US FDA revoked for food (2025) after cancer findings in animals', vi: 'phẩm màu FDA Mỹ đã thu hồi cho thực phẩm (2025) do gây ung thư ở động vật' }, ['erythrosine', 'red 3', 'red #3', 'red no. 3', 'red no 3']),
  A(['e129'], 'high', { en: 'Allura red (Red 40)', vi: 'Đỏ allura (Đỏ 40)' }, WHY.azo, ['allura red', 'red 40', 'red #40', 'red no. 40', 'red no 40']),
  A(['e171'], 'high', { en: 'Titanium dioxide', vi: 'Titan dioxit' }, { en: 'banned in EU food since 2022 — may damage DNA', vi: 'bị cấm trong thực phẩm ở EU từ 2022 — có thể gây hại ADN' }, ['titanium dioxide']),
  A(['e249'], 'high', { en: 'Potassium nitrite', vi: 'Kali nitrit' }, WHY.nitrite, ['potassium nitrite']),
  A(['e250'], 'high', { en: 'Sodium nitrite', vi: 'Natri nitrit' }, WHY.nitrite, ['sodium nitrite', 'natri nitrit']),
  A(['e251'], 'high', { en: 'Sodium nitrate', vi: 'Natri nitrat' }, WHY.nitrite, ['sodium nitrate', 'natri nitrat']),
  A(['e252'], 'high', { en: 'Potassium nitrate', vi: 'Kali nitrat' }, WHY.nitrite, ['potassium nitrate']),
  A(['e320'], 'high', { en: 'BHA', vi: 'BHA' }, { en: 'preservative rated "possibly carcinogenic" (IARC 2B)', vi: 'chất bảo quản được xếp "có thể gây ung thư" (IARC 2B)' }, ['bha', 'butylated hydroxyanisole']),
  A(['e321'], 'high', { en: 'BHT', vi: 'BHT' }, { en: 'preservative under review for possible hormone and liver effects', vi: 'chất bảo quản đang bị xem xét vì có thể ảnh hưởng nội tiết và gan' }, ['bht', 'butylated hydroxytoluene']),
  A(['e951'], 'high', { en: 'Aspartame', vi: 'Aspartame' }, { en: 'debated sweetener — rated "possibly carcinogenic" (IARC 2023)', vi: 'chất tạo ngọt gây tranh cãi — được xếp "có thể gây ung thư" (IARC 2023)' }, ['aspartame', 'aspartam']),
  A(['e950'], 'high', { en: 'Acesulfame K', vi: 'Acesulfame K' }, WHY.sweet, ['acesulfame', 'acesulfame potassium', 'acesulfame k', 'ace-k']),
  A(['e952'], 'high', { en: 'Cyclamate', vi: 'Cyclamate' }, { en: 'sweetener banned in the US', vi: 'chất tạo ngọt bị cấm ở Mỹ' }, ['cyclamate', 'sodium cyclamate']),
  A(['e954'], 'high', { en: 'Saccharin', vi: 'Saccharin' }, WHY.sweet, ['saccharin']),
  A(['e962'], 'high', { en: 'Aspartame-acesulfame salt', vi: 'Muối aspartame-acesulfame' }, WHY.sweet),
  A(['e150c'], 'high', { en: 'Ammonia caramel (E150c)', vi: 'Caramel amoniac (E150c)' }, WHY.caramel4),
  A(['e150d'], 'high', { en: 'Sulphite ammonia caramel (E150d)', vi: 'Caramel amoniac sulfit (E150d)' }, WHY.caramel4),
  A(['e407', 'e407a'], 'high', { en: 'Carrageenan', vi: 'Carrageenan' }, { en: 'thickener linked to gut inflammation in studies', vi: 'chất làm đặc liên quan đến viêm ruột trong nghiên cứu' }, ['carrageenan']),
  A(['e433'], 'high', { en: 'Polysorbate 80', vi: 'Polysorbate 80' }, WHY.gut, ['polysorbate 80']),
  A(['e466'], 'high', { en: 'Carboxymethylcellulose (cellulose gum)', vi: 'Carboxymethylcellulose (gôm cellulose)' }, WHY.gut, ['carboxymethylcellulose', 'carboxymethyl cellulose', 'cellulose gum', 'sodium carboxymethylcellulose']),
  A(['e924'], 'high', { en: 'Potassium bromate', vi: 'Kali bromat' }, { en: 'flour additive banned in the EU/UK; possible carcinogen', vi: 'phụ gia bột mì bị cấm ở EU/Anh; có thể gây ung thư' }, ['potassium bromate', 'bromated']),
  A(['e443'], 'high', { en: 'Brominated vegetable oil', vi: 'Dầu thực vật brom hoá' }, { en: 'banned by the US FDA in 2024', vi: 'bị FDA Mỹ cấm năm 2024' }, ['brominated vegetable oil', 'bvo']),
  A(['x-pho'], 'high', { en: 'Partially hydrogenated oil', vi: 'Dầu hydro hoá một phần' }, { en: 'source of trans fat — raises heart-disease risk', vi: 'nguồn chất béo chuyển hoá — tăng nguy cơ bệnh tim' }, ['partially hydrogenated', 'partially-hydrogenated', 'partiellement hydrogéné', 'hydro hóa một phần', 'hydro hoá một phần']),
  // --- MODERATE ---
  A(['x-hyd'], 'moderate', { en: 'Hydrogenated fat', vi: 'Chất béo hydro hoá' }, { en: 'hardened fat; may contain some trans fat', vi: 'chất béo làm cứng; có thể chứa chất béo chuyển hoá' }, ['hydrogenated', 'hydrogéné', 'hydro hóa', 'hydro hoá']),
  A(['x-hfcs'], 'moderate', { en: 'High-fructose corn syrup', vi: 'Siro ngô nhiều fructose' }, { en: 'highly refined added sugar', vi: 'đường thêm vào tinh luyện cao' }, ['high fructose corn syrup', 'high-fructose corn syrup', 'glucose-fructose syrup', 'glucose fructose syrup', 'isoglucose', 'hfcs']),
  A(['e132'], 'moderate', { en: 'Indigotine (Blue 2)', vi: 'Indigotine (Xanh 2)' }, WHY.dye, ['indigotine', 'indigo carmine', 'blue 2', 'blue #2', 'blue no. 2']),
  A(['e133'], 'moderate', { en: 'Brilliant blue (Blue 1)', vi: 'Xanh brilliant (Xanh 1)' }, WHY.dye, ['brilliant blue', 'blue 1', 'blue #1', 'blue no. 1']),
  A(['e151'], 'moderate', { en: 'Brilliant black', vi: 'Đen brilliant' }, WHY.dye, ['brilliant black']),
  A(['e155'], 'moderate', { en: 'Brown HT', vi: 'Nâu HT' }, WHY.dye),
  A(['e180'], 'moderate', { en: 'Lithol rubine', vi: 'Lithol rubine' }, WHY.dye),
  A(['x-car'], 'moderate', { en: 'Caramel colour (type not stated)', vi: 'Màu caramel (không ghi loại)' }, { en: 'type not stated — some types (E150c/E150d) can contain 4-MEI', vi: 'không ghi loại — một số loại (E150c/E150d) có thể chứa 4-MEI' }, ['caramel color', 'caramel colour', 'caramel coloring', 'colorant caramel', 'màu caramel']),
  A(['e173', 'e520', 'e521', 'e522', 'e523', 'e541', 'e554', 'e555', 'e556', 'e559'], 'moderate', { en: 'Aluminium additive', vi: 'Phụ gia chứa nhôm' }, WHY.alu, ['sodium aluminum phosphate', 'sodium aluminium phosphate', 'aluminum sulfate', 'aluminium sulphate']),
  A(['e319'], 'moderate', { en: 'TBHQ', vi: 'TBHQ' }, { en: 'preservative; affected the immune system in animal studies', vi: 'chất bảo quản; ảnh hưởng hệ miễn dịch trong nghiên cứu trên động vật' }, ['tbhq', 'tert-butylhydroquinone', 'tertiary butylhydroquinone']),
  A(['e210', 'e211', 'e212', 'e213'], 'moderate', { en: 'Benzoate preservative', vi: 'Chất bảo quản benzoat' }, WHY.benz, ['benzoic acid', 'sodium benzoate', 'potassium benzoate', 'calcium benzoate', 'natri benzoat', 'kali benzoat']),
  A(['e220', 'e221', 'e222', 'e223', 'e224', 'e225', 'e226', 'e227', 'e228'], 'moderate', { en: 'Sulphite preservative', vi: 'Chất bảo quản sulfit' }, WHY.sulph, ['sulfite', 'sulphite', 'bisulfite', 'bisulphite', 'metabisulfite', 'metabisulphite', 'sulfur dioxide', 'sulphur dioxide']),
  A(['e338'], 'moderate', { en: 'Phosphoric acid', vi: 'Axit photphoric' }, WHY.phos, ['phosphoric acid', 'axit photphoric', 'acide phosphorique']),
  A(['e339', 'e340', 'e341', 'e343', 'e450', 'e451', 'e452'], 'moderate', { en: 'Phosphate additive', vi: 'Phụ gia phosphat' }, WHY.phos, ['sodium phosphate', 'disodium phosphate', 'trisodium phosphate', 'monosodium phosphate', 'potassium phosphate', 'dipotassium phosphate', 'tripotassium phosphate', 'calcium phosphate', 'tricalcium phosphate', 'dicalcium phosphate', 'sodium tripolyphosphate', 'sodium hexametaphosphate', 'sodium acid pyrophosphate', 'tetrasodium pyrophosphate', 'pyrophosphate', 'polyphosphate', 'diphosphate', 'triphosphate']),
  A(['e955'], 'moderate', { en: 'Sucralose', vi: 'Sucralose' }, { en: 'artificial sweetener; recent studies raise questions', vi: 'chất tạo ngọt nhân tạo; nghiên cứu gần đây đặt ra nghi vấn' }, ['sucralose']),
  A(['e961'], 'moderate', { en: 'Neotame', vi: 'Neotame' }, WHY.sweet, ['neotame']),
  A(['e432', 'e434', 'e435', 'e436'], 'moderate', { en: 'Polysorbate', vi: 'Polysorbate' }, WHY.polys, ['polysorbate 20', 'polysorbate 60', 'polysorbate 65', 'polysorbate 40']),
  // --- LOW ---
  A(['e621'], 'low', { en: 'MSG (monosodium glutamate)', vi: 'Bột ngọt (MSG)' }, WHY.enh, ['monosodium glutamate', 'msg', 'bột ngọt', 'mì chính', 'glutamate monosodique']),
  A(['e627', 'e631', 'e635'], 'low', { en: 'Flavour enhancer', vi: 'Chất điều vị' }, WHY.enh, ['disodium guanylate', 'disodium inosinate', 'disodium ribonucleotides']),
  A(['e200', 'e201', 'e202', 'e203'], 'low', { en: 'Sorbate preservative', vi: 'Chất bảo quản sorbat' }, WHY.sorb, ['sorbic acid', 'potassium sorbate', 'calcium sorbate', 'kali sorbat']),
  A(['e280', 'e281', 'e282', 'e283'], 'low', { en: 'Propionate preservative', vi: 'Chất bảo quản propionat' }, WHY.prop, ['calcium propionate', 'sodium propionate', 'propionic acid']),
  A(['e420', 'e421', 'e953', 'e965', 'e966', 'e967', 'e968'], 'low', { en: 'Sugar alcohol', vi: 'Đường rượu (polyol)' }, WHY.polyol, ['sorbitol', 'mannitol', 'maltitol', 'xylitol', 'isomalt', 'lactitol', 'erythritol']),
  A(['e471'], 'low', { en: 'Mono- and diglycerides', vi: 'Mono- và diglycerid' }, { en: 'emulsifier; may carry traces of trans fat', vi: 'chất nhũ hoá; có thể chứa vết chất béo chuyển hoá' }, ['mono- and diglycerides', 'mono and diglycerides', 'monoglycerides', 'mono- et diglycérides']),
  A(['e385'], 'low', { en: 'EDTA', vi: 'EDTA' }, { en: 'preservative; low concern at food levels', vi: 'chất bảo quản; ít lo ngại ở liều thực phẩm' }, ['calcium disodium edta', 'disodium edta', 'edta']),
  A(['e1520'], 'low', { en: 'Propylene glycol', vi: 'Propylene glycol' }, { en: 'solvent/humectant; low concern at food levels', vi: 'dung môi/chất giữ ẩm; ít lo ngại ở liều thực phẩm' }, ['propylene glycol']),
  A(['e476'], 'low', { en: 'PGPR', vi: 'PGPR' }, { en: 'chocolate emulsifier; low concern', vi: 'chất nhũ hoá trong sô-cô-la; ít lo ngại' }, ['polyglycerol polyricinoleate', 'pgpr']),
  A(['e900'], 'low', { en: 'Dimethylpolysiloxane', vi: 'Dimethylpolysiloxane' }, { en: 'anti-foaming agent; low concern', vi: 'chất chống tạo bọt; ít lo ngại' }, ['dimethylpolysiloxane']),
];
const ADDITIVE_BY_CODE = new Map();
for (const a of ADDITIVES) for (const c of a.codes) ADDITIVE_BY_CODE.set(c, a);
export const NON_NUTRITIVE_SWEETENERS = new Set(['e950', 'e951', 'e952', 'e954', 'e955', 'e957', 'e959', 'e960', 'e960a', 'e961', 'e962', 'e969']);
// Additives with no meaningful concern (used only to rate an ingredient "neutral" instead of "not rated").
const SAFE_ADDITIVES = { en: 'common additive, considered safe', vi: 'phụ gia phổ biến, được coi là an toàn' };
const SAFE_CODES = new Set(['e100', 'e101', 'e140', 'e141', 'e150a', 'e160a', 'e160b', 'e160c', 'e162', 'e163', 'e170', 'e260', 'e270', 'e290',
  'e296', 'e300', 'e301', 'e302', 'e306', 'e307', 'e308', 'e309', 'e322', 'e325', 'e326', 'e327', 'e330', 'e331', 'e332', 'e333', 'e334', 'e335',
  'e336', 'e400', 'e401', 'e406', 'e410', 'e412', 'e414', 'e415', 'e418', 'e422', 'e440', 'e460', 'e500', 'e501', 'e503', 'e504', 'e508',
  'e509', 'e960', 'e960a', 'e1400', 'e1404', 'e1410', 'e1412', 'e1414', 'e1420', 'e1422', 'e1440', 'e1442', 'e1450', 'e1451', 'e472e', 'e472b', 'e472c']);
const RISK_POINTS = { high: 20, moderate: 10, low: 5 };

function additiveForCode(code) {
  const c = code.toLowerCase();
  if (ADDITIVE_BY_CODE.has(c)) return ADDITIVE_BY_CODE.get(c);
  if (c === 'e150') return ADDITIVE_BY_CODE.get('x-car');
  const base = c.replace(/[a-f]$/, '');
  if (base !== c && base !== 'e150' && ADDITIVE_BY_CODE.has(base)) return ADDITIVE_BY_CODE.get(base);
  return null;
}
// All additives in one piece of text (E-numbers + names). Returns table entries.
export function additivesInText(text) {
  const t = norm(text);
  const found = new Set();
  for (const code of eNumbersInText(t)) {
    if (code === 'e150') { found.add(ADDITIVE_BY_CODE.get('x-car')); continue; }
    const a = additiveForCode(code);
    if (a) found.add(a);
  }
  for (const a of ADDITIVES) {
    if (!a.names.length) continue;
    // "partially hydrogenated" must not also count as plain "hydrogenated"
    if (a.codes[0] === 'x-hyd' && /partial|partiel|một phần/.test(t)) continue;
    if (matchesAny(t, a.names)) found.add(a);
  }
  if (found.has(ADDITIVE_BY_CODE.get('x-car')) && [...found].some((a) => a.codes[0] === 'e150c' || a.codes[0] === 'e150d')) found.delete(ADDITIVE_BY_CODE.get('x-car'));
  return [...found];
}
function codesFromTags(tags) {
  const out = [];
  for (const t of tags || []) {
    const m = String(t).toLowerCase().replace(/^[a-z]{2}:/, '').match(/^(e\d{3,4}[a-f]?)(?![a-z]{2})/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ECZEMA triggers (hand-kept). severity: high | medium | low.
// Sources (checked 2026-10-10):
//  [AAD]   American Academy of Dermatology, "Can food fix eczema?" — milk, egg, peanut, soy, wheat are the
//          common food triggers in children with eczema.
//  [AAAAI] AAAAI Work Group Report "Atopic Dermatitis and Food Allergy: Best Practices and Knowledge Gaps" (2022):
//          cow's milk, hen's egg, peanut, wheat, soy, tree nuts, fish cause >90% of food allergy in AD children;
//          sesame and shellfish are major allergens (US FASTER Act 2023 added sesame).
//  [NEA]   National Eczema Association, eczema & diet / dyshidrotic eczema: nickel-rich foods (cocoa, chocolate,
//          soy) and balsam-of-Peru-related foods can flare some people.
//  [VB89]  Van Bever et al., Allergy 1989;44:588 "Food and food additives in severe atopic dermatitis" — DBPCFC
//          reactions to tartrazine, sodium benzoate, sodium glutamate (MSG), sodium metabisulfite.
//  [W01]   Worm et al., Clin Exp Allergy 2000;30:407 and 2001;31:265 — a subgroup of adults with AD worsened on
//          double-blind food-additive challenge (tartrazine, benzoate, nitrite).
//  [SF01]  Salam & Fowler, J Am Acad Dermatol 2001;45:377 — balsam-of-Peru systemic contact dermatitis improved on
//          a diet avoiding citrus, tomato, cinnamon, cloves, vanilla, chocolate.
//  [H20]   Hong et al., Exp Dermatol 2020 — skin AGE levels higher in AD (weak, indirect evidence for added sugar /
//          fried, high-AGE foods). Alcohol was LEFT OUT: Halling-Overgaard 2018 meta-analysis found no consistent
//          adult association. Generic "spices" LEFT OUT: no support beyond the balsam-related spices above.
// ---------------------------------------------------------------------------------------------
const E = (id, sev, name, why, words, opts = {}) => ({ id, sev, name, why, words, not: opts.not || [], allergens: opts.allergens || [], additives: opts.additives || [] });
export const ECZEMA = [
  E('milk', 'high', { en: "Cow's milk / dairy", vi: 'Sữa bò / sản phẩm sữa' },
    { en: 'one of the most common food triggers of eczema, especially in children (AAD)', vi: 'một trong những tác nhân thực phẩm gây chàm phổ biến nhất, nhất là ở trẻ em (AAD)' },
    ['milk', 'whey', 'casein', 'caseinate', 'lactose', 'butter', 'buttermilk', 'cream', 'cheese', 'yogurt', 'yoghurt', 'ghee', 'lactalbumin', 'lactoglobulin', 'curd', 'milkfat', 'milk fat', 'lait', 'lactosérum', 'beurre', 'crème', 'fromage', 'sữa', 'bơ sữa', 'phô mai', 'kem sữa', 'váng sữa'],
    { allergens: ['en:milk'], not: ['coconut milk', 'almond milk', 'oat milk', 'soy milk', 'soya milk', 'rice milk', 'cashew milk', 'cocoa butter', 'peanut butter', 'nut butter', 'shea butter', 'apple butter', 'beurre de cacao', 'cream of tartar', 'sữa dừa', 'sữa đậu nành', 'bơ ca cao', 'milk thistle', 'non-dairy', 'dairy-free', 'lait de coco'] }),
  E('egg', 'high', { en: 'Egg', vi: 'Trứng' },
    { en: 'a top eczema-linked food allergen in children (AAD, AAAAI)', vi: 'chất gây dị ứng thực phẩm hàng đầu liên quan đến chàm ở trẻ (AAD, AAAAI)' },
    ['egg', 'egg white', 'egg yolk', 'albumen', 'ovalbumin', 'lysozyme', 'mayonnaise', 'oeuf', 'œuf', 'trứng'],
    { allergens: ['en:eggs'], not: ['eggplant'], additives: ['e1105'] }),
  E('peanut', 'high', { en: 'Peanut', vi: 'Đậu phộng (lạc)' },
    { en: 'a top eczema-linked food allergen (AAD, AAAAI)', vi: 'chất gây dị ứng thực phẩm hàng đầu liên quan đến chàm (AAD, AAAAI)' },
    ['peanut', 'groundnut', 'arachide', 'arachis', 'đậu phộng', 'lạc rang', 'bơ đậu phộng'],
    { allergens: ['en:peanuts'] }),
  E('treenuts', 'high', { en: 'Tree nuts', vi: 'Các loại hạt cây' },
    { en: 'tree nuts are among the foods behind >90% of food allergy in eczema (AAAAI)', vi: 'hạt cây nằm trong nhóm gây >90% dị ứng thực phẩm ở người bị chàm (AAAAI)' },
    ['almond', 'hazelnut', 'walnut', 'cashew', 'pecan', 'pistachio', 'macadamia', 'brazil nut', 'pine nut', 'filbert', 'praline', 'nut', 'noisette', 'amande', 'noix', 'pistache', 'hạt điều', 'hạnh nhân', 'óc chó', 'hạt phỉ', 'hạt dẻ cười', 'mắc ca'],
    { allergens: ['en:nuts'], not: ['nutmeg', 'coconut', 'noix de coco', 'butternut', 'peanut', 'nutrition', 'nutritional', 'doughnut', 'donut', 'chestnut', 'water chestnut', 'nut-free', 'nut free'] }),
  E('wheat', 'high', { en: 'Wheat / gluten', vi: 'Lúa mì / gluten' },
    { en: 'a common eczema-linked food allergen in children (AAD, AAAAI)', vi: 'chất gây dị ứng thực phẩm phổ biến liên quan đến chàm ở trẻ (AAD, AAAAI)' },
    ['wheat', 'gluten', 'barley', 'rye', 'spelt', 'semolina', 'durum', 'farina', 'couscous', 'bulgur', 'seitan', 'malt', 'blé', 'froment', 'orge', 'seigle', 'épeautre', 'lúa mì', 'bột mì', 'lúa mạch'],
    { allergens: ['en:gluten'], not: ['buckwheat', 'gluten free', 'gluten-free', 'sans gluten', 'no gluten', 'không chứa gluten', 'không gluten', 'blé noir', 'malt vinegar'] }),
  E('soy', 'high', { en: 'Soy', vi: 'Đậu nành' },
    { en: 'a common eczema-linked food allergen in children (AAD); soy is also high in nickel (NEA)', vi: 'chất gây dị ứng thực phẩm phổ biến liên quan đến chàm ở trẻ (AAD); đậu nành cũng nhiều niken (NEA)' },
    ['soy', 'soya', 'soybean', 'edamame', 'tofu', 'miso', 'tempeh', 'soja', 'đậu nành', 'đậu tương', 'đậu hũ', 'nước tương', 'tương'],
    { allergens: ['en:soybeans'] }),
  // Soy lecithin is made from soy but is nearly protein-free; most soy-allergic people tolerate it (FARE / AAAAI guidance).
  E('soylecithin', 'medium', { en: 'Soy lecithin', vi: 'Lecithin đậu nành' },
    { en: 'made from soy but has very little soy protein — most soy-sensitive people tolerate it', vi: 'làm từ đậu nành nhưng rất ít đạm đậu nành — đa số người nhạy cảm vẫn dung nạp được' }, []),
  E('fish', 'high', { en: 'Fish', vi: 'Cá' },
    { en: 'fish is among the foods behind >90% of food allergy in eczema (AAAAI)', vi: 'cá nằm trong nhóm gây >90% dị ứng thực phẩm ở người bị chàm (AAAAI)' },
    ['fish', 'anchovy', 'anchovies', 'tuna', 'salmon', 'cod', 'sardine', 'mackerel', 'tilapia', 'pollock', 'haddock', 'trout', 'fish sauce', 'poisson', 'thon', 'saumon', 'cá', 'nước mắm', 'cá cơm'],
    { allergens: ['en:fish'], not: ['shellfish', 'fish-free', 'cá nhân'] }),
  E('shellfish', 'high', { en: 'Shellfish', vi: 'Hải sản có vỏ (tôm, cua, sò)' },
    { en: 'a major food allergen; can flare eczema in sensitised people (AAAAI)', vi: 'chất gây dị ứng chính; có thể làm chàm bùng phát ở người nhạy cảm (AAAAI)' },
    ['shrimp', 'prawn', 'crab', 'lobster', 'crayfish', 'crustacean', 'shellfish', 'oyster', 'clam', 'mussel', 'scallop', 'krill', 'crevette', 'homard', 'moule', 'tôm', 'cua', 'ghẹ', 'sò', 'hến', 'nghêu', 'hàu', 'mắm tôm'],
    { allergens: ['en:crustaceans', 'en:molluscs'] }),
  E('sesame', 'high', { en: 'Sesame', vi: 'Mè (vừng)' },
    { en: 'a major food allergen (US 9th major allergen since 2023); eczema raises sesame-allergy risk (AAAAI)', vi: 'chất gây dị ứng chính (từ 2023 là chất thứ 9 ở Mỹ); người bị chàm dễ dị ứng mè hơn (AAAAI)' },
    ['sesame', 'tahini', 'sésame', 'mè', 'vừng', 'dầu mè'],
    { allergens: ['en:sesame-seeds'] }),
  // --- MEDIUM ---
  E('azodyes', 'medium', { en: 'Artificial (azo) colours', vi: 'Phẩm màu nhân tạo (azo)' },
    { en: 'tartrazine and similar dyes worsened eczema in some patients on double-blind challenge (Van Bever 1989, Worm 2000)', vi: 'tartrazine và phẩm màu tương tự làm chàm nặng hơn ở một số bệnh nhân khi thử mù đôi (Van Bever 1989, Worm 2000)' },
    ['tartrazine', 'yellow 5', 'yellow #5', 'yellow no. 5', 'sunset yellow', 'yellow 6', 'yellow #6', 'yellow no. 6', 'red 40', 'red #40', 'red no. 40', 'allura red', 'carmoisine', 'azorubine', 'ponceau', 'quinoline yellow'],
    { additives: ['e102', 'e104', 'e110', 'e122', 'e123', 'e124', 'e129', 'e151', 'e155', 'e180'] }),
  E('benzoates', 'medium', { en: 'Benzoate preservatives', vi: 'Chất bảo quản benzoat' },
    { en: 'sodium benzoate worsened eczema in some patients on double-blind challenge (Van Bever 1989, Worm 2001)', vi: 'natri benzoat làm chàm nặng hơn ở một số bệnh nhân khi thử mù đôi (Van Bever 1989, Worm 2001)' },
    ['benzoic acid', 'sodium benzoate', 'potassium benzoate', 'calcium benzoate', 'natri benzoat'],
    { additives: ['e210', 'e211', 'e212', 'e213'] }),
  E('sulphites', 'medium', { en: 'Sulphites', vi: 'Sulfit' },
    { en: 'sodium metabisulfite triggered reactions in children with severe eczema (Van Bever 1989)', vi: 'natri metabisulfit gây phản ứng ở trẻ bị chàm nặng (Van Bever 1989)' },
    ['sulfite', 'sulphite', 'bisulfite', 'bisulphite', 'metabisulfite', 'metabisulphite', 'sulfur dioxide', 'sulphur dioxide'],
    { allergens: ['en:sulphur-dioxide-and-sulphites'], additives: ['e220', 'e221', 'e222', 'e223', 'e224', 'e225', 'e226', 'e227', 'e228'] }),
  E('msg', 'medium', { en: 'MSG (glutamate)', vi: 'Bột ngọt (glutamat)' },
    { en: 'sodium glutamate triggered reactions in children with severe eczema (Van Bever 1989)', vi: 'natri glutamat gây phản ứng ở trẻ bị chàm nặng (Van Bever 1989)' },
    ['monosodium glutamate', 'msg', 'bột ngọt', 'mì chính', 'glutamate monosodique'],
    { additives: ['e621'] }),
  E('cocoa', 'medium', { en: 'Cocoa / chocolate (nickel)', vi: 'Ca cao / sô-cô-la (niken)' },
    { en: 'high in nickel, which can flare eczema (especially hand eczema) in nickel-sensitive people (NEA); also balsam-related (Salam & Fowler 2001)', vi: 'nhiều niken, có thể làm chàm bùng phát (nhất là chàm tay) ở người nhạy cảm niken (NEA); cũng liên quan balsam Peru (Salam & Fowler 2001)' },
    ['cocoa', 'cacao', 'chocolate', 'chocolat', 'ca cao', 'cacao', 'sô cô la', 'sô-cô-la', 'socola'],
    { not: ['cocoa butter', 'beurre de cacao', 'bơ ca cao', 'white chocolate'] }),
  E('citrus', 'medium', { en: 'Citrus fruit', vi: 'Trái cây họ cam quýt' },
    { en: 'balsam-of-Peru-related food; avoiding it helped balsam-sensitive eczema (Salam & Fowler 2001)', vi: 'thực phẩm liên quan balsam Peru; tránh nó giúp chàm ở người nhạy cảm balsam (Salam & Fowler 2001)' },
    ['citrus', 'orange', 'lemon', 'lime', 'grapefruit', 'tangerine', 'mandarin', 'clementine', 'yuzu', 'citron', 'agrumes', 'cam', 'chanh', 'quýt', 'bưởi'],
    { not: ['citric acid', 'acide citrique', 'axit citric', 'orange color', 'orange colour', 'lime green', 'chanh dây'] }),
  E('tomato', 'medium', { en: 'Tomato', vi: 'Cà chua' },
    { en: 'balsam-of-Peru-related food; avoiding it helped balsam-sensitive eczema (Salam & Fowler 2001)', vi: 'thực phẩm liên quan balsam Peru; tránh nó giúp chàm ở người nhạy cảm balsam (Salam & Fowler 2001)' },
    ['tomato', 'tomatoes', 'ketchup', 'tomate', 'cà chua']),
  E('balsam', 'medium', { en: 'Cinnamon / cloves / vanilla (balsam-related)', vi: 'Quế / đinh hương / vani (liên quan balsam)' },
    { en: 'balsam-of-Peru-related flavourings; avoiding them helped balsam-sensitive eczema (Salam & Fowler 2001)', vi: 'hương liệu liên quan balsam Peru; tránh chúng giúp chàm ở người nhạy cảm balsam (Salam & Fowler 2001)' },
    ['cinnamon', 'cinnamaldehyde', 'clove', 'cloves', 'vanilla', 'vanillin', 'vanille', 'vanilline', 'cannelle', 'girofle', 'balsam', 'quế', 'đinh hương', 'vani']),
  // --- LOW ---
  E('sugar', 'low', { en: 'Added sugar', vi: 'Đường thêm vào' },
    { en: 'weak, indirect evidence: sugar-derived AGEs are raised in eczema skin (Hong 2020)', vi: 'bằng chứng yếu, gián tiếp: chất AGE từ đường tăng trong da bị chàm (Hong 2020)' },
    ['sugar', 'cane sugar', 'glucose syrup', 'corn syrup', 'dextrose', 'sucrose', 'fructose', 'invert sugar', 'syrup', 'sucre', 'sirop', 'đường', 'mạch nha'],
    { not: ['sugar free', 'sugar-free', 'no added sugar', 'sans sucre', 'không đường', 'sugar alcohol', 'sugar snap'] }),
  E('fried', 'low', { en: 'Fried / high-AGE food', vi: 'Đồ chiên rán (nhiều AGE)' },
    { en: 'weak, indirect evidence: dietary AGEs from frying may add to skin inflammation (Hong 2020)', vi: 'bằng chứng yếu, gián tiếp: AGE từ đồ chiên có thể góp phần gây viêm da (Hong 2020)' },
    ['fried', 'frit', 'frite', 'chiên', 'rán']),
];
// ---------------------------------------------------------------------------------------------
// ECZEMA (skin-contact) table — used for cosmetics / personal care / household products. For things that
// touch the skin the eczema question is contact IRRITATION or contact ALLERGY, not food allergy.
// Sources:
//  [NACDG]  North American Contact Dermatitis Group patch-test series (DeKoven et al., Dermatitis 2023):
//           fragrance mix, MI, formaldehyde + releasers, PPD, lanolin, CAPB, propylene glycol are on it.
//  [ACDS]   American Contact Dermatitis Society "Allergen of the Year": MI 2013, CAPB 2004, PPD 2006,
//           formaldehyde 2015, propylene glycol 2018, parabens 2019 (picked to show they are RARE allergens:
//           the "paraben paradox"), lanolin 2023.
//  [SCCS59] EU SCCS/1459/11 opinion on fragrance allergens (isoeugenol, cinnamal, HICC = established
//           allergens; oxidised limonene/linalool are allergens).
//  [NEA]    US National Eczema Association — avoid fragrance, harsh surfactants (SLS), bleach/ammonia cleaners;
//           wear gloves for household cleaning (hand eczema).
//  [TTO]    EU SCCP/1155/08 opinion on tea tree oil (oxidised oil is a sensitiser).
// ---------------------------------------------------------------------------------------------
export const ECZEMA_CONTACT = [
  E('c_fragrance', 'high', { en: 'Fragrance / parfum', vi: 'Hương liệu / nước hoa (parfum)' },
    { en: 'the most common cause of allergic contact eczema from products (NACDG, NEA) — "fragrance" can hide dozens of chemicals', vi: 'nguyên nhân hay gặp nhất gây chàm tiếp xúc dị ứng từ mỹ phẩm (NACDG, NEA) — chữ “fragrance” có thể che hàng chục hoá chất' },
    ['fragrance', 'parfum', 'perfume', 'hương liệu', 'nước hoa', 'masking fragrance'],
    { not: ['fragrance free', 'fragrance-free', 'without fragrance', 'unscented', 'không hương liệu', 'không mùi', 'sans parfum'] }),
  E('c_mi', 'high', { en: 'Methylisothiazolinone (MI / MCI)', vi: 'Methylisothiazolinone (MI / MCI)' },
    { en: 'preservative behind an epidemic of contact eczema; Allergen of the Year 2013 (ACDS); banned in EU leave-on products (EU 2016/1198, 2017/1224)', vi: 'chất bảo quản gây “dịch” chàm tiếp xúc; Chất gây dị ứng của năm 2013 (ACDS); bị cấm trong sản phẩm để lại trên da ở EU (EU 2016/1198, 2017/1224)' },
    ['methylisothiazolinone', 'methylchloroisothiazolinone', 'kathon', 'benzisothiazolinone', 'octylisothiazolinone', 'isothiazolinone']),
  E('c_formaldehyde', 'high', { en: 'Formaldehyde / formaldehyde-releasing preservative', vi: 'Formaldehyde / chất bảo quản giải phóng formaldehyde' },
    { en: 'a top patch-test allergen (NACDG; ACDS Allergen of the Year 2015 for formaldehyde)', vi: 'chất gây dị ứng hàng đầu khi thử áp da (NACDG; ACDS 2015)' },
    ['formaldehyde', 'formalin', 'dmdm hydantoin', 'quaternium-15', 'quaternium 15', 'imidazolidinyl urea', 'diazolidinyl urea', 'bronopol', '2-bromo-2-nitropropane-1,3-diol', 'sodium hydroxymethylglycinate', 'methenamine']),
  E('c_ppd', 'high', { en: 'Hair dye PPD (p-phenylenediamine)', vi: 'Thuốc nhuộm tóc PPD' },
    { en: 'strong contact allergen in hair dyes (ACDS Allergen of the Year 2006)', vi: 'chất gây dị ứng tiếp xúc mạnh trong thuốc nhuộm tóc (ACDS 2006)' },
    ['p-phenylenediamine', 'paraphenylenediamine', 'phenylenediamine', 'toluene-2,5-diamine', 'ppd']),
  E('c_bleach', 'high', { en: 'Bleach (sodium hypochlorite)', vi: 'Thuốc tẩy (natri hypoclorit)' },
    { en: 'strong skin irritant — use gloves; harsh cleaners are a classic cause of hand eczema (NEA)', vi: 'gây kích ứng da mạnh — hãy đeo găng; chất tẩy rửa mạnh là nguyên nhân kinh điển của chàm tay (NEA)' },
    ['sodium hypochlorite', 'hypochlorite', 'chlorine bleach', 'bleach', 'javel', 'nước tẩy javel'],
    { not: ['non-chlorine bleach', 'non chlorine bleach', 'oxygen bleach', 'chlorine-free', 'bleach-free', 'bleach free'] }),
  E('c_fragallergen', 'medium', { en: 'Named fragrance allergen', vi: 'Chất gây dị ứng trong hương liệu' },
    { en: 'one of the fragrance allergens the EU requires on the label (EU 1223/2009 Annex III; SCCS/1459/11)', vi: 'một trong các chất gây dị ứng hương liệu mà EU bắt buộc ghi trên nhãn (EU 1223/2009 Phụ lục III; SCCS/1459/11)' },
    ['limonene', 'linalool', 'citronellol', 'geraniol', 'citral', 'eugenol', 'isoeugenol', 'cinnamal', 'cinnamyl alcohol', 'hydroxycitronellal', 'coumarin', 'benzyl salicylate', 'benzyl benzoate', 'benzyl cinnamate', 'benzyl alcohol', 'farnesol', 'alpha-isomethyl ionone', 'amyl cinnamal', 'hexyl cinnamal', 'anise alcohol', 'evernia prunastri', 'evernia furfuracea', 'hydroxyisohexyl 3-cyclohexene carboxaldehyde', 'butylphenyl methylpropional']),
  E('c_essentialoil', 'medium', { en: 'Essential oil (tea tree, lavender, peppermint, citrus…)', vi: 'Tinh dầu (tràm trà, oải hương, bạc hà, cam chanh…)' },
    { en: '"natural" oils are fragrance chemicals too; oxidised tea tree oil is a sensitiser (SCCP/1155/08)', vi: 'tinh dầu “tự nhiên” cũng là hoá chất hương liệu; tinh dầu tràm trà bị ôxy hoá gây mẫn cảm (SCCP/1155/08)' },
    ['tea tree oil', 'melaleuca alternifolia', 'lavender oil', 'lavandula angustifolia oil', 'peppermint oil', 'mentha piperita oil', 'eucalyptus oil', 'eucalyptus globulus leaf oil', 'citrus aurantium dulcis peel oil', 'citrus limon peel oil', 'orange peel oil', 'lemon peel oil', 'rosemary oil', 'rosmarinus officinalis leaf oil', 'ylang ylang', 'cananga odorata', 'clove oil', 'cinnamon oil', 'essential oil', 'tinh dầu']),
  E('c_capb', 'medium', { en: 'Cocamidopropyl betaine', vi: 'Cocamidopropyl betaine' },
    { en: 'foaming agent in "gentle" washes; contact allergen (ACDS Allergen of the Year 2004)', vi: 'chất tạo bọt trong sữa tắm “dịu nhẹ”; gây dị ứng tiếp xúc (ACDS 2004)' },
    ['cocamidopropyl betaine', 'cocamidopropyl dimethylamine', 'amidoamine']),
  E('c_sls', 'medium', { en: 'Harsh surfactant (sodium lauryl sulfate)', vi: 'Chất tạo bọt mạnh (sodium lauryl sulfate)' },
    { en: 'strips the skin barrier — the standard irritant used to test skin irritation; avoid with eczema (NEA)', vi: 'làm mất lớp bảo vệ da — là chất kích ứng chuẩn dùng để thử kích ứng da; người bị chàm nên tránh (NEA)' },
    ['sodium lauryl sulfate', 'sodium dodecyl sulfate', 'ammonium lauryl sulfate', 'sls']),
  E('c_pg', 'medium', { en: 'Propylene glycol', vi: 'Propylene glycol' },
    { en: 'can irritate and sensitise eczema skin (ACDS Allergen of the Year 2018)', vi: 'có thể kích ứng và gây mẫn cảm da bị chàm (ACDS 2018)' },
    ['propylene glycol']),
  E('c_lanolin', 'medium', { en: 'Lanolin (wool fat)', vi: 'Lanolin (mỡ lông cừu)' },
    { en: 'contact allergen, more often on broken eczema skin (ACDS Allergen of the Year 2023)', vi: 'chất gây dị ứng tiếp xúc, hay gặp hơn trên da chàm bị tổn thương (ACDS 2023)' },
    ['lanolin', 'lanolin alcohol', 'wool alcohol', 'wool wax', 'adeps lanae', 'eucerit']),
  E('c_quats', 'medium', { en: 'Quaternary ammonium disinfectant (benzalkonium…)', vi: 'Chất khử khuẩn amoni bậc bốn (benzalkonium…)' },
    { en: 'skin irritant and occasional allergen in disinfectant sprays/wipes', vi: 'gây kích ứng da, đôi khi gây dị ứng, trong xịt/khăn khử khuẩn' },
    ['benzalkonium chloride', 'benzethonium chloride', 'didecyldimethylammonium chloride', 'alkyl dimethyl benzyl ammonium chloride', 'quaternary ammonium', 'cetrimonium chloride', 'dimethyl benzyl ammonium', 'dimethylbenzyl ammonium', 'dimethylbenzylammonium', 'dimethyl ethylbenzyl ammonium', 'didecyl dimethyl ammonium', 'dioctyl dimethyl ammonium', 'octyl decyl dimethyl ammonium']),
  E('c_ammonia', 'medium', { en: 'Ammonia', vi: 'Amoniac' },
    { en: 'irritates skin and airways; harsh cleaners worsen hand eczema (NEA)', vi: 'kích ứng da và đường thở; chất tẩy rửa mạnh làm chàm tay nặng hơn (NEA)' },
    ['ammonia', 'ammonium hydroxide', 'amoniac']),
  E('c_oxybenzone', 'low', { en: 'Oxybenzone (benzophenone-3)', vi: 'Oxybenzone (benzophenone-3)' },
    { en: 'sunscreen filter that can cause (photo)allergic contact reactions', vi: 'chất chống nắng có thể gây phản ứng dị ứng (với ánh sáng) khi tiếp xúc' },
    ['oxybenzone', 'benzophenone-3', 'benzophenone 3']),
  E('c_parabens', 'low', { en: 'Parabens', vi: 'Paraben' },
    { en: 'rarely cause allergy on healthy skin ("paraben paradox", ACDS 2019) — a low risk on broken skin only', vi: 'hiếm khi gây dị ứng trên da lành (“nghịch lý paraben”, ACDS 2019) — chỉ rủi ro thấp trên da tổn thương' },
    ['methylparaben', 'ethylparaben', 'propylparaben', 'butylparaben', 'isobutylparaben', 'isopropylparaben', 'paraben', 'parabens']),
  E('c_dyes', 'low', { en: 'Colour / dye', vi: 'Phẩm màu' },
    { en: 'dyes are occasional contact allergens', vi: 'phẩm màu đôi khi gây dị ứng tiếp xúc' },
    ['fd&c', 'd&c', 'coal tar', 'acid yellow', 'acid red', 'acid blue']),
  E('c_brightener', 'low', { en: 'Optical brightener (laundry)', vi: 'Chất làm trắng quang học (giặt)' },
    { en: 'stays on fabric that touches skin; an occasional irritant', vi: 'bám lại trên vải tiếp xúc với da; đôi khi gây kích ứng' },
    ['optical brightener', 'optical brighteners', 'fluorescent whitening agent', 'distyrylbiphenyl', 'stilbene']),
];
const ECZ_BY_ID = Object.fromEntries([...ECZEMA, ...ECZEMA_CONTACT].map((e) => [e.id, e]));
const SEV_RANK = { high: 3, medium: 2, low: 1, none: 0 };
const LOWER = { high: 'medium', medium: 'low', low: 'low' };

// table: ECZEMA (food triggers) or ECZEMA_CONTACT (skin products) — picked by product type
function eczemaHitsInText(text, parentText = '', table = ECZEMA) {
  const t = norm(text);
  const hits = [];
  for (const e of table) {
    if (!e.words.length) continue;
    const w = matchesAny(t, e.words, e.not);
    if (w) hits.push(e.id);
  }
  for (const code of eNumbersInText(t)) {
    for (const e of table) if (e.additives.includes(code) && !hits.includes(e.id)) hits.push(e.id);
  }
  // soy inside a lecithin ingredient = soy lecithin (much weaker trigger)
  const ctx = norm(text + ' ' + parentText);
  if (hits.includes('soy') && /lecithin|lécithine|lecithine|lexithin|lexitin/.test(ctx)) {
    hits.splice(hits.indexOf('soy'), 1, 'soylecithin');
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// Ingredient parsing (text) and OFF ingredient tree
// ---------------------------------------------------------------------------------------------
// parenthetical purpose notes such as "(to protect taste)" are not ingredients
const NOTE_RE = /^(to |for |as an? |added |used |pour |để |(?:preservatives?|antioxidants?|colou?rs?|colou?ring|acidulants?)$)/i;
const CLAIM_RE = /^(gluten[- ]free|sans gluten|no gluten|không chứa gluten|vegan|organic|non[- ]gmo|kosher|halal)\b/i;
// "CONTAINS LESS THAN 2% OF:" — OCR often garbles LESS ("LSS", "L=$S"), so that word is matched loosely.
const PREFIX_RE = /^(ingredients?|ingrédients?|thành phần|contains (?:2|two) ?% or less of|(?:contains )?l\S{0,4}s than (?:2|two) ?% of|(?:and )?(?:2|two) ?% or less of)\s*[:.]?\s*/i;
// a footnote key printed after the list ("†POWDERED", "*ORGANIC") is not an ingredient
const FOOTNOTE_RE = /^[†‡*]|^(?:powdered|dried|dehydrated|organic|ingredients? not in regular \w+)$/i;
function cleanToken(s) {
  return s.replace(/\s+/g, ' ').trim().replace(PREFIX_RE, '').replace(PREFIX_RE, '')
    .replace(/^[\s*:;.,\-–]+|[\s*:;.,\-–]+$/g, '').replace(/^(and|et|và)\s+/i, '').trim();
}
// "Sugar, palm oil, HAZELNUTS 13%, emulsifiers: lecithins [SOY), vanillin. Gluten free."
export function parseIngredientsText(text) {
  const src = String(text || '').replace(/\r/g, '')
    .replace(/-[ \t]*\n[ \t]*(?=(?:and|or|&|et|và)\b)/gi, '- ')   // "MONO-⏎AND DIGLYCERIDES" keeps its hyphen
    .replace(/-\n/g, '').replace(/\n/g, ' ')                        // "MALTO-⏎DEXTRIN" -> "MALTODEXTRIN"
    .replace(/[†‡]/g, '')                                           // dagger footnote marks ("GARLIC†")
    .trim();
  if (!src) return [];
  // split into top-level tokens (commas/semicolons, or ". " sentence breaks) at bracket depth 0
  const parse = (s) => {
    const items = [];
    let depth = 0, cur = '', sub = '', closed = false;
    const push = () => {
      const name = cleanToken(cur);
      const children = sub ? parse(sub) : [];
      if (name && !CLAIM_RE.test(name) && !NOTE_RE.test(name) && !/^(may contain|peut contenir|có thể chứa)/i.test(name)) items.push({ text: name, children });
      else if (!name && children.length) items.push(...children);
      cur = ''; sub = '';
    };
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if ('([{'.includes(ch)) { if (depth > 0) sub += ch; depth++; continue; }
      if (')]}'.includes(ch)) { depth = Math.max(0, depth - 1); if (depth > 0) sub += ch; else closed = true; continue; }
      if (depth > 0) { sub += ch; continue; }
      // "...D-XYLOSE)] TOCOPHEROLS (ANTIOXIDANT)": a word right after a closed bracket with no comma between
      // (lost by OCR or the printer) starts a new ingredient instead of extending the previous one
      if (closed && /\S/.test(ch)) { closed = false; if (/\p{L}/u.test(ch) && sub) push(); }
      const prev = s[i - 1] || '', next = s[i + 1] || '';
      if ((ch === ',' && !(/\d/.test(prev) && /\d/.test(next))) || ch === ';' || (ch === '.' && (next === ' ' || next === '') && !/\d/.test(prev) && !/\b(no|st|approx|incl)$/i.test(cur))) { push(); continue; }
      cur += ch;
    }
    push();
    return items;
  };
  const top = parse(src);
  while (top.length && !top[top.length - 1].children.length && FOOTNOTE_RE.test(top[top.length - 1].text)) top.pop();
  return top;
}
// OFF `ingredients` array -> same {text, id, children} shape
function offTree(list) {
  return (list || []).map((i) => ({ text: String(i.text || i.id || '').trim(), id: i.id || '', children: offTree(i.ingredients) }))
    .filter((i) => i.text && !NOTE_RE.test(i.text));
}
function idWords(id) {
  return id && /^en:/.test(id) ? id.slice(3).replace(/-/g, ' ') : '';
}

// ---------------------------------------------------------------------------------------------
// Per-ingredient HEALTH rating: good | neutral | caution | bad | unrated
// ---------------------------------------------------------------------------------------------
const R = (rating, why, words, not = []) => ({ rating, why, words, not });
const ING_RULES = [
  R('bad', { en: 'processed meat by-product', vi: 'phụ phẩm thịt chế biến' }, ['mechanically separated', 'mechanically deboned']),
  R('caution', { en: 'fruit juice concentrate — concentrated sugar', vi: 'nước ép cô đặc — đường cô đặc' }, ['juice concentrate', 'concentrated juice', 'jus concentré']),
  R('good', { en: 'whole grain — fibre', vi: 'ngũ cốc nguyên hạt — nhiều chất xơ' }, ['whole grain', 'wholegrain', 'whole wheat', 'whole oat', 'whole meal', 'wholemeal', 'whole rye', 'oat', 'oats', 'rolled oats', 'oatmeal', 'oat flakes', 'flocons d\'avoine', 'avoine', 'yến mạch', 'brown rice', 'quinoa', 'buckwheat', 'millet', 'bran', 'complet', 'gạo lứt', 'nguyên cám'], ['oat milk', 'oat syrup']),
  R('bad', { en: 'added sugar', vi: 'đường thêm vào' }, ['sugar', 'cane sugar', 'brown sugar', 'cane juice', 'evaporated cane juice', 'glucose syrup', 'corn syrup', 'glucose', 'dextrose', 'fructose', 'sucrose', 'invert sugar', 'syrup', 'maltose', 'molasses', 'honey', 'agave', 'caramel', 'treacle', 'sucre', 'sirop', 'miel', 'đường', 'mạch nha', 'mật ong'], ['sugar free', 'sugar-free', 'no added sugar', 'sugar alcohol', 'sans sucre', 'không đường', 'caramel color', 'caramel colour', 'caramel coloring']),
  R('bad', { en: 'palm/hardened fat — high in saturated fat', vi: 'dầu cọ/mỡ cứng — nhiều chất béo bão hoà' }, ['palm oil', 'palm kernel', 'palm fat', 'palmolein', 'palm olein', 'shortening', 'margarine', 'cottonseed oil', 'huile de palme', 'graisse de palme', 'dầu cọ', 'shortening']),
  R('good', { en: 'olive oil — healthy fat', vi: 'dầu ô liu — chất béo tốt' }, ['olive oil', 'extra virgin', "huile d'olive", 'dầu ô liu', 'dầu oliu']),
  R('caution', { en: 'refined vegetable oil — fine in small amounts', vi: 'dầu thực vật tinh luyện — ổn nếu ít' }, ['vegetable oil', 'soybean oil', 'soya oil', 'canola oil', 'rapeseed oil', 'sunflower oil', 'corn oil', 'safflower oil', 'palm', 'oil', 'huile', 'dầu thực vật', 'dầu đậu nành', 'dầu']),
  R('caution', { en: 'salt — fine in small amounts', vi: 'muối — ổn nếu ít' }, ['salt', 'sea salt', 'sodium chloride', 'sel', 'muối'], ['salted']),
  R('caution', { en: 'refined white flour', vi: 'bột mì trắng tinh luyện' }, ['enriched flour', 'white flour', 'bleached flour', 'wheat flour', 'all-purpose flour', 'refined flour', 'farine de blé', 'farine', 'bột mì', 'flour']),
  R('caution', { en: 'highly processed starch — raises blood sugar fast', vi: 'tinh bột chế biến sâu — làm tăng đường huyết nhanh' }, ['maltodextrin', 'maltodextrine']),
  R('caution', { en: 'artificial flavouring', vi: 'hương liệu nhân tạo' }, ['artificial flavor', 'artificial flavour', 'artificial flavoring', 'artificial flavouring', 'hương liệu nhân tạo']),
  R('caution', { en: 'high in saturated fat', vi: 'nhiều chất béo bão hoà' }, ['butter', 'cream', 'lard', 'tallow', 'beurre', 'crème', 'bơ sữa', 'mỡ'], ['cocoa butter', 'peanut butter', 'nut butter', 'beurre de cacao', 'cream of tartar']),
  R('caution', { en: 'processed meat', vi: 'thịt chế biến' }, ['bacon', 'ham', 'salami', 'pepperoni', 'sausage', 'hot dog', 'frankfurter', 'jambon', 'xúc xích', 'giăm bông', 'thịt xông khói']),
  R('caution', { en: 'chocolate / sweet composite — contains sugar', vi: 'sô-cô-la / thành phần ngọt — có đường' }, ['chocolate', 'chocolat', 'candy', 'sô cô la', 'socola'], ['dark chocolate 85']),
  R('good', { en: 'fruit', vi: 'trái cây' }, ['fruit', 'apple', 'banana', 'strawberry', 'strawberries', 'blueberry', 'blueberries', 'raspberry', 'raspberries', 'berry', 'berries', 'cherry', 'cherries', 'orange', 'lemon', 'lime', 'mango', 'pineapple', 'grape', 'peach', 'pear', 'apricot', 'plum', 'raisin', 'date', 'fig', 'kiwi', 'pomegranate', 'cranberry', 'cranberries', 'coconut', 'pomme', 'fraise', 'banane', 'trái cây', 'táo', 'chuối', 'xoài', 'dứa', 'thơm'], ['flavor', 'flavour', 'flavored', 'flavoured', 'arôme', 'hương']),
  R('good', { en: 'vegetable', vi: 'rau củ' }, ['vegetable', 'vegetables', 'tomato', 'carrot', 'onion', 'garlic', 'spinach', 'kale', 'broccoli', 'cabbage', 'celery', 'cucumber', 'pumpkin', 'squash', 'zucchini', 'beet', 'beetroot', 'mushroom', 'pepper', 'bell pepper', 'sweet potato', 'leek', 'lettuce', 'ginger', 'légumes', 'tomate', 'carotte', 'oignon', 'ail', 'rau', 'cà chua', 'cà rốt', 'hành', 'tỏi', 'gừng', 'nấm'], ['flavor', 'flavour', 'powder', 'extract', 'black pepper', 'white pepper']),
  R('good', { en: 'legume — fibre and protein', vi: 'họ đậu — chất xơ và đạm' }, ['bean', 'beans', 'lentil', 'lentils', 'chickpea', 'chickpeas', 'pea', 'peas', 'black beans', 'kidney beans', 'pois', 'lentilles', 'pois chiches', 'đậu xanh', 'đậu đen', 'đậu đỏ'], ['vanilla bean', 'coffee bean', 'cocoa bean', 'pea protein isolate', 'jelly bean']),
  R('good', { en: 'nuts/seeds — healthy fats and fibre', vi: 'hạt — chất béo tốt và chất xơ' }, ['almond', 'hazelnut', 'walnut', 'cashew', 'pecan', 'pistachio', 'macadamia', 'peanut', 'peanuts', 'seed', 'seeds', 'flaxseed', 'linseed', 'chia', 'sesame', 'noisette', 'amande', 'noix', 'hạt', 'đậu phộng', 'mè', 'vừng'], ['peanut oil', 'seed oil', 'sunflower oil', 'grapeseed oil', 'sesame oil', 'nut oil']),
  R('neutral', { en: 'basic food', vi: 'thực phẩm cơ bản' }, ['water', 'eau', 'nước', 'carbonated water', 'mineral water', 'milk', 'skimmed milk', 'skim milk', 'whole milk', 'milk powder', 'whey', 'lactose', 'casein', 'cheese', 'yogurt', 'yoghurt', 'egg', 'eggs', 'yeast', 'vinegar', 'rice', 'corn', 'maize', 'potato', 'potatoes', 'starch', 'corn starch', 'cornstarch', 'modified starch', 'gelatin', 'gelatine', 'pectin', 'cocoa', 'cacao', 'coffee', 'tea', 'chicken', 'beef', 'pork', 'turkey', 'lamb', 'fish', 'tuna', 'salmon', 'shrimp', 'lait', 'lactosérum', 'oeuf', 'œuf', 'levure', 'vinaigre', 'riz', 'amidon', 'sữa', 'trứng', 'gạo', 'thịt', 'cá', 'tôm', 'tinh bột', 'giấm', 'men', 'soy', 'soybean', 'soybeans', 'tofu', 'đậu nành', 'wheat gluten', 'protein', 'pea protein', 'soy protein', 'whey protein', 'inulin', 'chicory root', 'fiber', 'fibre']),
  R('caution', { en: 'caffeine — a stimulant', vi: 'caffeine — chất kích thích' }, ['caffeine', 'cafeína', 'caféine', 'cafein']),
  R('neutral', { en: 'herb/spice/flavouring', vi: 'gia vị/thảo mộc/hương liệu' }, ['spice', 'spices', 'herb', 'herbs', 'black pepper', 'paprika', 'cinnamon', 'nutmeg', 'cumin', 'turmeric', 'oregano', 'basil', 'parsley', 'thyme', 'rosemary', 'mustard', 'vanilla', 'vanillin', 'vanilline', 'natural flavor', 'natural flavour', 'natural flavors', 'natural flavouring', 'flavor', 'flavour', 'flavouring', 'flavoring', 'arôme', 'arômes', 'aroma', 'smoke flavor', 'epices', 'épices', 'gia vị', 'hương liệu', 'tiêu', 'quế', 'garlic powder', 'onion powder', 'cocoa powder']),
  R('neutral', { en: 'added vitamin/mineral', vi: 'vitamin/khoáng chất bổ sung' }, ['vitamin', 'vitamins', 'iron', 'reduced iron', 'zinc', 'niacin', 'niacinamide', 'thiamin', 'thiamine', 'riboflavin', 'folic acid', 'calcium carbonate', 'potassium chloride', 'magnesium', 'calcium', 'mineral', 'minerals', 'ascorbic acid', 'tocopherol', 'tocopherols', 'cholecalciferol', 'pyridoxine', 'biotin', 'iodide', 'iodate']),
  R('neutral', SAFE_ADDITIVES, ['lecithin', 'lecithins', 'lécithine', 'lécithines', 'citric acid', 'emulsifier', 'emulsifiers', 'émulsifiant', 'émulsifiants', 'xanthan gum', 'guar gum', 'locust bean gum', 'gum arabic', 'acacia gum', 'gellan gum', 'baking soda', 'sodium bicarbonate', 'leavening', 'raising agent', 'lactic acid', 'malic acid', 'acetic acid', 'sodium citrate', 'beta-carotene', 'paprika extract', 'annatto', 'turmeric extract', 'beet juice', 'carbon dioxide', 'acidity regulator', 'antioxidant', 'stabilizer', 'stabiliser', 'thickener', 'chất nhũ hoá', 'chất nhũ hóa', 'chất ổn định', 'chất điều chỉnh độ axit']),
];
const RATING_RANK = { bad: 4, caution: 3, unrated: 2, neutral: 1, good: 0 };
const NOT_RATED = { en: 'not rated — not in our list yet', vi: 'chưa đánh giá — chưa có trong danh sách' };

export function rateIngredient(text, id = '', tagCodes = []) {
  const key = norm(`${text} ${idWords(id)}`);
  let adds = additivesInText(key);
  const specific = tagCodes.find((c) => c === 'e150c' || c === 'e150d');
  if (specific && adds.some((a) => a.codes[0] === 'x-car')) adds = adds.map((a) => (a.codes[0] === 'x-car' ? ADDITIVE_BY_CODE.get(specific) : a));
  if (adds.length) {
    const worst = adds.sort((a, b) => RISK_POINTS[b.risk] - RISK_POINTS[a.risk])[0];
    const rating = worst.risk === 'high' ? 'bad' : worst.risk === 'moderate' ? 'caution' : 'neutral';
    return { rating, why: { en: `${worst.label.en}: ${worst.why.en}`, vi: `${worst.label.vi}: ${worst.why.vi}` }, additive: worst };
  }
  const codes = eNumbersInText(key);
  if (codes.some((c) => SAFE_CODES.has(c) || SAFE_CODES.has(c.replace(/[a-f]$/, '')))) return { rating: 'neutral', why: SAFE_ADDITIVES };
  for (const r of ING_RULES) {
    if (matchesAny(key, r.words, r.not)) return { rating: r.rating, why: r.why };
  }
  return { rating: 'unrated', why: NOT_RATED };
}

// Rate a whole tree; returns a flat list in LABEL order with depth for indentation.
// opts.rate / opts.table switch between food (default) and skin/household products
export function rateIngredientTree(tree, tagCodes = [], opts = {}) {
  const rate = opts.rate || ((text, id) => rateIngredient(text, id, tagCodes));
  const table = opts.table || ECZEMA;
  const out = [];
  const walk = (items, depth, parentText) => {
    for (const it of items) {
      const health = rate(it.text, it.id);
      const ecz = eczemaHitsInText(`${it.text} ${idWords(it.id)}`, parentText, table);
      const sev = ecz.reduce((m, id) => (SEV_RANK[ECZ_BY_ID[id].sev] > SEV_RANK[m] ? ECZ_BY_ID[id].sev : m), 'none');
      out.push({ text: it.text, id: it.id || '', depth, order: out.length, health, eczema: { sev, ids: ecz } });
      if (it.children && it.children.length) walk(it.children, depth + 1, it.text);
    }
  };
  walk(tree || [], 0, '');
  return out;
}
export function sortWorstFirst(list) {
  return [...list].sort((a, b) => (RATING_RANK[b.health.rating] - RATING_RANK[a.health.rating])
    || (SEV_RANK[b.eczema.sev] - SEV_RANK[a.eczema.sev]) || (a.order - b.order));
}

// ---------------------------------------------------------------------------------------------
// ECZEMA check for a whole product
// ---------------------------------------------------------------------------------------------
export function eczemaCheck({ ingredients = [], hasIngredientText = false, allergens = [], traces = [], additiveCodes = [], containsText = '', mayContainText = '', table = ECZEMA }) {
  const found = new Map(); // id -> {id, sev, traces, via:Set}
  const add = (id, via, isTrace = false) => {
    const e = ECZ_BY_ID[id];
    if (!e) return;
    const sev = isTrace ? LOWER[e.sev] : e.sev;
    const cur = found.get(id);
    if (!cur) found.set(id, { id, sev, traces: isTrace, via: new Set([via]) });
    else {
      cur.via.add(via);
      if (!isTrace && cur.traces) { cur.traces = false; cur.sev = e.sev; }
    }
  };
  for (const ing of ingredients) for (const id of ing.eczema.ids) add(id, ing.text);
  for (const id of eczemaHitsInText(containsText, '', table)) add(id, containsText);
  const tagIds = (tags) => ECZEMA.filter((e) => e.allergens.some((a) => (tags || []).includes(a))).map((e) => e.id);
  for (const id of tagIds(allergens)) {
    if (id === 'soy' && found.has('soylecithin') && !found.has('soy')) continue; // the allergen tag is explained by the lecithin
    add(id, 'allergen list');
  }
  for (const code of additiveCodes) for (const e of ECZEMA) if (e.additives.includes(code)) add(e.id, code.toUpperCase());
  for (const id of tagIds(traces)) if (!found.has(id)) add(id, 'may contain', true);
  for (const id of eczemaHitsInText(mayContainText, '', table)) if (!found.has(id)) add(id, 'may contain', true);

  const triggers = [...found.values()].map((f) => {
    const e = ECZ_BY_ID[f.id];
    return { id: f.id, sev: f.sev, traces: f.traces, name: e.name, why: e.why, via: [...f.via].slice(0, 4) };
  }).sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev] || Number(a.traces) - Number(b.traces));
  const canCheck = hasIngredientText || ingredients.length > 0;
  let status;
  if (triggers.length) status = canCheck ? 'found' : 'found_partial';
  else status = canCheck ? 'none' : 'unknown';
  const overall = triggers.reduce((m, t) => (SEV_RANK[t.sev] > SEV_RANK[m] ? t.sev : m), 'none');
  return { status, overall: status === 'unknown' ? 'unknown' : overall, count: triggers.length, triggers };
}

// ---------------------------------------------------------------------------------------------
// NUTRI-SCORE 2023 (computed here from nutrients; OFF's own score is only used to cross-check in tests)
// ---------------------------------------------------------------------------------------------
const steps = (v, thresholds) => { let p = 0; for (const t of thresholds) if (v > t) p++; return p; };
const T = {
  energy: [335, 670, 1005, 1340, 1675, 2010, 2345, 2680, 3015, 3350],
  sugars: [3.4, 6.8, 10, 14, 17, 20, 24, 27, 31, 34, 37, 41, 44, 48, 51],
  satfat: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  salt: [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.4, 2.6, 2.8, 3, 3.2, 3.4, 3.6, 3.8, 4],
  protein: [2.4, 4.8, 7.2, 9.6, 12, 14, 17],
  fiber: [3.0, 4.1, 5.2, 6.3, 7.4],
  energySat: [120, 240, 360, 480, 600, 720, 840, 960, 1080, 1200],
  bevEnergy: [30, 90, 150, 210, 240, 270, 300, 330, 360, 390],
  bevSugars: [0.5, 2, 3.5, 5, 6, 7, 8, 9, 10, 11],
  bevProtein: [1.2, 1.5, 1.8, 2.1, 2.4, 2.7, 3.0],
};
const fvlPoints = (pct, bev) => (bev ? (pct > 80 ? 6 : pct > 60 ? 4 : pct > 40 ? 2 : 0) : (pct > 80 ? 5 : pct > 60 ? 2 : pct > 40 ? 1 : 0));
const satRatioPoints = (r) => { const t = [10, 16, 22, 28, 34, 40, 46, 52, 58, 64]; let p = 0; for (const x of t) if (r >= x) p++; return p; };

export function categoryOf({ categories = [], offFlags = {} } = {}) {
  const has = (re) => categories.some((c) => re.test(c));
  const f = offFlags || {};
  if (f.is_water || (has(/^en:(waters|mineral-waters|spring-waters|natural-mineral-waters|unsweetened-sparkling-waters)$/) && !has(/flavou?red|sweetened-beverages|sodas|juices|teas/))) return 'water';
  if (has(/^en:alcoholic-beverages$/)) return 'alcohol';
  if (f.is_beverage === 1 || (f.is_beverage == null && has(/^en:beverages$/) && !has(/^en:(milks|dairies|yogurts|beverage-preparations|plant-based-foods)$/) && !has(/preparation|powder/))) return 'beverage';
  if (f.is_cheese === 1 || (f.is_cheese == null && has(/^en:cheeses$/))) return 'cheese';
  if (f.is_fat_oil_nuts_seeds === 1 || (f.is_fat_oil_nuts_seeds == null && has(/^en:(fats|vegetable-oils|nuts|seeds|nut-butters|olive-oils|butters|margarines)$/))) return 'fats';
  if (f.is_red_meat_product === 1 || (f.is_red_meat_product == null && has(/^en:(beef|pork|lamb|red-meats|bacon|beef-products|pork-and-its-products)$/))) return 'redmeat';
  return 'general';
}

// n: per-100g {energy_kj, sugars, satfat, fat, salt, fiber, protein, fvl, sweeteners(bool)}; value null = MISSING
export function nutriScore2023(n, cat) {
  if (cat === 'water') return { ok: true, score: null, grade: 'a', cat, components: [], notes: [], water: true };
  if (cat === 'alcohol') return { ok: false, cat, missing: ['alcohol'], notes: [] };
  const bev = cat === 'beverage', fats = cat === 'fats';
  const need = ['energy_kj', 'sugars', 'satfat', 'salt'];
  if (fats) need.push('fat');
  const missing = need.filter((k) => n[k] == null || Number.isNaN(n[k]));
  if (missing.length) return { ok: false, cat, missing, notes: [] };
  const notes = [];
  const C = [];
  const neg = (id, pts, max, value, unit) => { C.push({ id, kind: 'neg', pts, max, value, unit }); return pts; };
  const pos = (id, pts, max, value, unit) => { C.push({ id, kind: 'pos', pts, max, value, unit }); return pts; };
  let N = 0;
  if (fats) {
    const eSat = n.satfat * 37;
    N += neg('energy_from_saturated_fat', steps(eSat, T.energySat), 10, eSat, 'kJ');
  } else N += neg('energy', steps(n.energy_kj, bev ? T.bevEnergy : T.energy), 10, n.energy_kj, 'kJ');
  N += neg('sugars', steps(n.sugars, bev ? T.bevSugars : T.sugars), bev ? 10 : 15, n.sugars, 'g');
  if (fats) {
    const ratio = n.fat > 0 ? (n.satfat / n.fat) * 100 : 0;
    N += neg('saturated_fat_ratio', satRatioPoints(ratio), 10, ratio, '%');
  } else N += neg('saturated_fat', steps(n.satfat, T.satfat), 10, n.satfat, 'g');
  N += neg('salt', steps(n.salt, T.salt), 20, n.salt, 'g');
  if (bev) N += neg('non_nutritive_sweeteners', n.sweeteners ? 4 : 0, 4, n.sweeteners ? 1 : 0, '');

  const fiber = n.fiber == null ? (notes.push('fiber'), 0) : n.fiber;
  const protein = n.protein == null ? (notes.push('protein'), 0) : n.protein;
  const fvl = n.fvl == null ? (notes.push('fvl'), 0) : n.fvl;
  const fvlP = pos('fruits_vegetables_legumes', fvlPoints(fvl, bev), bev ? 6 : 5, fvl, '%');
  const fiberP = pos('fiber', steps(fiber, T.fiber), 5, fiber, 'g');
  let protP = steps(protein, bev ? T.bevProtein : T.protein);
  if (cat === 'redmeat') protP = Math.min(protP, 2);
  let countProtein = true;
  if (!bev && cat !== 'cheese') countProtein = N < (fats ? 7 : 11);
  pos('proteins', countProtein ? protP : 0, cat === 'redmeat' ? 2 : 7, protein, 'g');
  const P = fvlP + fiberP + (countProtein ? protP : 0);
  const score = N - P;
  let grade;
  if (bev) grade = score <= 2 ? 'b' : score <= 6 ? 'c' : score <= 9 ? 'd' : 'e';
  else if (fats) grade = score <= -6 ? 'a' : score <= 2 ? 'b' : score <= 10 ? 'c' : score <= 18 ? 'd' : 'e';
  else grade = score <= 0 ? 'a' : score <= 2 ? 'b' : score <= 10 ? 'c' : score <= 18 ? 'd' : 'e';
  return { ok: true, score, grade, cat, N, P, components: C, notes };
}

// Continuous mapping of the Nutri-Score onto 0-60 (anchored on the grade boundaries).
const ANCHORS = {
  general: [[-10, 60], [0, 48], [2, 40], [10, 27], [18, 12], [30, 0]],
  fats: [[-15, 60], [-6, 48], [2, 40], [10, 27], [18, 12], [30, 0]],
  beverage: [[-4, 48], [2, 40], [6, 27], [9, 12], [20, 0]],
};
export function nutritionPoints(ns) {
  if (!ns.ok) return null;
  if (ns.water) return 60;
  const a = ANCHORS[ns.cat === 'fats' ? 'fats' : ns.cat === 'beverage' ? 'beverage' : 'general'];
  const s = ns.score;
  if (s <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) {
    if (s <= a[i][0]) {
      const [x0, y0] = a[i - 1], [x1, y1] = a[i];
      return y0 + ((s - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// NOVA estimate from ingredients (photo path, or OFF product without NOVA). Always labelled an estimate.
// ---------------------------------------------------------------------------------------------
const UPF_MARKERS = ['flavor', 'flavour', 'flavoring', 'flavouring', 'arôme', 'hương liệu', 'color', 'colour', 'coloring', 'dye',
  'emulsifier', 'émulsifiant', 'nhũ hoá', 'nhũ hóa', 'sweetener', 'édulcorant', 'modified starch', 'amidon modifié', 'maltodextrin', 'dextrose',
  'invert sugar', 'corn syrup', 'glucose syrup', 'glucose-fructose', 'hydrogenated', 'interesterified', 'protein isolate', 'hydrolyzed',
  'hydrolysed', 'mechanically separated', 'thickener', 'gum', 'lecithin', 'lécithine', 'carrageenan', 'polysorbate', 'mono- and diglycerides',
  'whey powder', 'lactosérum', 'milk solids'];
const CULINARY = ['sugar', 'salt', 'oil', 'butter', 'vinegar', 'honey', 'syrup', 'sucre', 'sel', 'huile', 'đường', 'muối', 'dầu'];
export function estimateNova(flatIngredients) {
  const top = flatIngredients.filter((i) => i.depth === 0);
  if (!top.length) return null;
  const all = flatIngredients.map((i) => norm(`${i.text} ${idWords(i.id)}`));
  const anyAdditive = flatIngredients.some((i) => i.health.additive) || all.some((t) => eNumbersInText(t).length);
  if (anyAdditive || all.some((t) => matchesAny(t, UPF_MARKERS))) return 4;
  const culinary = all.filter((t) => matchesAny(t, CULINARY)).length;
  if (top.length === 1) return culinary ? 2 : 1;
  if (culinary) return 3;
  return top.length <= 3 ? 1 : 3;
}

// ---------------------------------------------------------------------------------------------
// The ONE scoring function (barcode and photo paths both end here)
// ---------------------------------------------------------------------------------------------
export const BANDS = [
  { min: 75, key: 'excellent', color: '#1e9e4a', label: { en: 'Excellent', vi: 'Tuyệt vời' } },
  { min: 50, key: 'good', color: '#7cc142', label: { en: 'Good', vi: 'Tốt' } },
  { min: 25, key: 'poor', color: '#f08c00', label: { en: 'Poor', vi: 'Kém' } },
  { min: 0, key: 'bad', color: '#d93025', label: { en: 'Bad', vi: 'Xấu' } },
];
export const bandFor = (score) => BANDS.find((b) => score >= b.min) || BANDS[BANDS.length - 1];

const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString();

function nutritionReasons(n, cat, isWater) {
  const r = [];
  if (isWater) { r.push({ kind: 'good', en: 'Plain water — the healthiest drink', vi: 'Nước lọc — thức uống lành mạnh nhất' }); return r; }
  const bev = cat === 'beverage';
  const per = bev ? { en: 'per 100ml', vi: 'mỗi 100ml' } : { en: 'per 100g', vi: 'mỗi 100g' };
  if (n.sugars != null) {
    const hi = bev ? 11.25 : 22.5, mid = bev ? 5 : 12.5, lo = bev ? 2.5 : 5;
    if (n.sugars > hi) r.push({ kind: 'bad', en: `Lots of sugar (${fmt(n.sugars)}g ${per.en})`, vi: `Rất nhiều đường (${fmt(n.sugars)}g ${per.vi})` });
    else if (n.sugars > mid) r.push({ kind: 'bad', en: `Quite a lot of sugar (${fmt(n.sugars)}g ${per.en})`, vi: `Khá nhiều đường (${fmt(n.sugars)}g ${per.vi})` });
    else if (n.sugars <= lo) r.push({ kind: 'good', en: `Low sugar (${fmt(n.sugars)}g ${per.en})`, vi: `Ít đường (${fmt(n.sugars)}g ${per.vi})` });
  }
  if (n.satfat != null) {
    if (n.satfat > 5) r.push({ kind: 'bad', en: `Lots of saturated fat (${fmt(n.satfat)}g ${per.en})`, vi: `Nhiều chất béo bão hoà (${fmt(n.satfat)}g ${per.vi})` });
    else if (n.satfat <= 1.5 && !bev) r.push({ kind: 'good', en: 'Low saturated fat', vi: 'Ít chất béo bão hoà' });
  }
  if (n.salt != null) {
    if (n.salt > 1.5) r.push({ kind: 'bad', en: `Very salty (${fmt(n.salt, 2)}g salt ${per.en})`, vi: `Rất mặn (${fmt(n.salt, 2)}g muối ${per.vi})` });
    else if (n.salt > 0.9) r.push({ kind: 'bad', en: `Quite salty (${fmt(n.salt, 2)}g salt ${per.en})`, vi: `Khá mặn (${fmt(n.salt, 2)}g muối ${per.vi})` });
    else if (n.salt <= 0.3 && !bev) r.push({ kind: 'good', en: 'Low salt', vi: 'Ít muối' });
  }
  if (n.energy_kj != null) {
    const kcal = n.energy_kj / 4.184;
    if (!bev && kcal > 450) r.push({ kind: 'bad', en: `Very high in calories (${Math.round(kcal)} kcal ${per.en})`, vi: `Rất nhiều calo (${Math.round(kcal)} kcal ${per.vi})` });
    if (bev && kcal > 30) r.push({ kind: 'bad', en: `Sugary/caloric drink (${Math.round(kcal)} kcal ${per.en})`, vi: `Đồ uống nhiều calo (${Math.round(kcal)} kcal ${per.vi})` });
  }
  if (n.fiber != null) {
    if (n.fiber >= 6) r.push({ kind: 'good', en: `Good fiber (${fmt(n.fiber)}g ${per.en})`, vi: `Nhiều chất xơ (${fmt(n.fiber)}g ${per.vi})` });
    else if (n.fiber >= 3) r.push({ kind: 'good', en: `Some fiber (${fmt(n.fiber)}g ${per.en})`, vi: `Có chất xơ (${fmt(n.fiber)}g ${per.vi})` });
  }
  if (n.protein != null && n.energy_kj > 0 && (n.protein * 17) / n.energy_kj >= 0.2 && !bev) r.push({ kind: 'good', en: `Good protein (${fmt(n.protein)}g ${per.en})`, vi: `Nhiều đạm (${fmt(n.protein)}g ${per.vi})` });
  if (n.fvl != null && n.fvl >= 40) r.push({ kind: 'good', en: `Lots of fruit/veg/legumes (${Math.round(n.fvl)}%)`, vi: `Nhiều trái cây/rau/đậu (${Math.round(n.fvl)}%)` });
  return r;
}

/**
 * input: {
 *   source: 'off' | 'photo', nutrients: {energy_kj,sugars,satfat,fat,salt,fiber,protein,fvl} (per 100g, null = missing),
 *   categories, offFlags, nova (1-4|null), ingredientTree, ingredientsText, allergens, traces, additiveTags,
 *   containsText, mayContainText
 * }
 */
export function analyze(input) {
  const type = input.productType || 'food';
  if (type !== 'food') return analyzeNonFood(input, type);
  const tree = input.ingredientTree && input.ingredientTree.length ? input.ingredientTree : parseIngredientsText(input.ingredientsText);
  const hasIngredientText = !!(input.ingredientsText && input.ingredientsText.trim()) || tree.length > 0;
  const tagCodes = codesFromTags(input.additiveTags);
  const ingredients = rateIngredientTree(tree, tagCodes);

  // ---- additives (tags from OFF + anything we find in the text) ----
  const additiveSet = new Map();
  for (const c of tagCodes) { const a = additiveForCode(c); if (a) additiveSet.set(a.codes[0], { a, code: c }); }
  for (const ing of ingredients) for (const a of additivesInText(`${ing.text} ${idWords(ing.id)}`)) if (!additiveSet.has(a.codes[0])) additiveSet.set(a.codes[0], { a, code: a.codes[0] });
  if (!tree.length && input.ingredientsText) for (const a of additivesInText(input.ingredientsText)) if (!additiveSet.has(a.codes[0])) additiveSet.set(a.codes[0], { a, code: a.codes[0] });
  // a caramel colour of known type supersedes the generic "type not stated" entry
  if (additiveSet.has('e150c') || additiveSet.has('e150d')) additiveSet.delete('x-car');
  if (additiveSet.has('x-pho')) additiveSet.delete('x-hyd');
  const additives = [...additiveSet.values()].map(({ a, code }) => ({ code: /^x-/.test(code) ? '' : code.toUpperCase(), risk: a.risk, label: a.label, why: a.why }))
    .sort((x, y) => RISK_POINTS[y.risk] - RISK_POINTS[x.risk]);
  const additivesKnown = hasIngredientText || tagCodes.length > 0;
  const addPoints = additivesKnown ? Math.max(0, 30 - additives.reduce((s, a) => s + RISK_POINTS[a.risk], 0)) : null;
  const allCodes = [...new Set([...tagCodes, ...ingredients.flatMap((i) => eNumbersInText(norm(i.text)))])];
  const sweeteners = allCodes.some((c) => NON_NUTRITIVE_SWEETENERS.has(c)) || additives.some((a) => ['Aspartame', 'Sucralose', 'Acesulfame K', 'Saccharin', 'Cyclamate', 'Neotame'].includes(a.label.en));

  // ---- nutrition ----
  const cat = categoryOf({ categories: input.categories || [], offFlags: input.offFlags || {} });
  let nutrients = { ...(input.nutrients || {}) };
  nutrients.sweeteners = sweeteners;
  let isWater = cat === 'water';
  if (isWater) {
    // a "water" with sugar or sweeteners is not plain water
    const sugary = (nutrients.sugars != null && nutrients.sugars > 0.5) || sweeteners || ingredients.some((i) => i.health.rating === 'bad');
    if (sugary) isWater = false;
  }
  const ns = nutriScore2023(nutrients, isWater ? 'water' : cat === 'water' ? 'beverage' : cat);
  const nutPoints = nutritionPoints(ns);

  // ---- processing ----
  let nova = [1, 2, 3, 4].includes(Number(input.nova)) ? Number(input.nova) : null;
  let novaEstimated = false;
  if (nova == null) { nova = estimateNova(ingredients); novaEstimated = nova != null; }
  const procPoints = nova == null ? null : { 1: 10, 2: 8, 3: 5, 4: 0 }[nova];

  // ---- total ----
  const missing = [];
  if (nutPoints == null) missing.push('nutrition');
  if (addPoints == null) missing.push('additives');
  if (procPoints == null) missing.push('processing');
  let score = null, partial = false;
  const anyHigh = additives.some((a) => a.risk === 'high');
  if (nutPoints != null) {
    const got = nutPoints + (addPoints ?? 0) + (procPoints ?? 0);
    const max = 60 + (addPoints != null ? 30 : 0) + (procPoints != null ? 10 : 0);
    score = Math.round((got / max) * 100);
    partial = max < 100;
  }
  const capped = score != null && anyHigh && score > 49;
  if (capped) score = 49;

  // ---- plain-English reasons ----
  const reasons = [];
  if (ns.ok) reasons.push(...nutritionReasons(nutrients, ns.cat, isWater));
  for (const a of additives) {
    const code = a.code && !a.label.en.toUpperCase().includes(a.code) ? ` (${a.code})` : '';
    reasons.push({ kind: a.risk === 'low' ? 'info' : 'bad', en: `Contains ${a.label.en}${code} — ${a.why.en}`, vi: `Có ${a.label.vi}${code} — ${a.why.vi}` });
  }
  if (additivesKnown && !additives.length) reasons.push({ kind: 'good', en: 'No risky additives found', vi: 'Không thấy phụ gia đáng lo' });
  if (nova === 4) reasons.push({ kind: 'bad', en: `Ultra-processed food${novaEstimated ? ' (estimate)' : ''}`, vi: `Thực phẩm siêu chế biến${novaEstimated ? ' (ước tính)' : ''}` });
  if (nova === 1) reasons.push({ kind: 'good', en: `Unprocessed or minimally processed${novaEstimated ? ' (estimate)' : ''}`, vi: `Chưa chế biến hoặc chế biến tối thiểu${novaEstimated ? ' (ước tính)' : ''}` });
  if (capped) reasons.unshift({ kind: 'bad', en: 'Has a high-risk additive, so the score is capped at 49', vi: 'Có phụ gia nguy cơ cao nên điểm bị giới hạn ở 49' });
  if (ns.ok && ns.notes.includes('fiber') && !isWater && ns.cat !== 'beverage') reasons.push({ kind: 'info', en: 'Fiber not listed — counted as none', vi: 'Không ghi chất xơ — tính là không có' });

  const eczema = eczemaCheck({
    ingredients, hasIngredientText, allergens: input.allergens || [], traces: input.traces || [],
    additiveCodes: allCodes, containsText: input.containsText || '', mayContainText: input.mayContainText || '',
  });

  const allergens = findAllergens({ ingredients, ingredientsText: input.ingredientsText || '', containsText: input.containsText || '', mayContainText: input.mayContainText || '',
    allergenTags: input.allergens || [], traceTags: input.traces || [], additiveCodes: tagCodes });
  const cancer = cancerCheck({ ingredients, ingredientsText: input.ingredientsText || '', categories: input.categories || [], additiveCodes: tagCodes,
    productType: 'food', beverage: ns.cat === 'beverage' || cat === 'beverage' });
  return {
    score, partial, capped, missing, band: score == null ? null : bandFor(score), allergens, cancer,
    parts: {
      nutrition: { points: nutPoints == null ? null : Math.round(nutPoints * 10) / 10, max: 60, nutriscore: ns },
      additives: { points: addPoints, max: 30, list: additives },
      processing: { points: procPoints, max: 10, nova, estimated: novaEstimated },
    },
    reasons, eczema, eczemaScore: eczemaScore(eczema), ingredients, nutrients, category: isWater ? 'water' : cat, type: 'food',
  };
}

// ---------------------------------------------------------------------------------------------
// ECZEMA SCORE 0-100 (every product type). 100 = no known trigger found in the listed ingredients.
// Transparent rule (shown on screen as a breakdown):
//   start at 100; each trigger costs HIGH 35 / MEDIUM 15 / LOW 5 points;
//   "may contain / traces" costs half of its normal weight;
//   triggers are taken worst first and each further one counts 70% of the one before (diminishing:
//   the 6th sugar mention should not sink a product the way a second allergen does);
//   any HIGH trigger (not just traces) caps the score at 49 — the same cap rule as the health score;
//   floor 0. No ingredient list = NO score ("can't check"), never 100.
// ---------------------------------------------------------------------------------------------
export const ECZEMA_SCORE_RULE = { weights: { high: 35, medium: 15, low: 5 }, traceFactor: 0.5, decay: 0.7, highCap: 49 };
export function eczemaScore(ec) {
  if (!ec || ec.status === 'unknown') return null;
  const R = ECZEMA_SCORE_RULE;
  const items = ec.triggers.map((tr) => {
    const base = R.weights[ECZ_BY_ID[tr.id].sev] || 0;          // weight of the trigger itself (traces: halved below)
    return { id: tr.id, name: tr.name, sev: tr.sev, traces: tr.traces, base: tr.traces ? base * R.traceFactor : base };
  }).sort((a, b) => b.base - a.base);
  let total = 0;
  items.forEach((it, k) => { it.penalty = Math.round(it.base * R.decay ** k * 10) / 10; total += it.penalty; });
  let score = Math.max(0, Math.round(100 - total));
  const capped = items.some((it) => it.sev === 'high' && !it.traces) && score > R.highCap;
  if (capped) score = R.highCap;
  return { score, band: bandFor(score), capped, items, total: Math.round(total * 10) / 10 };
}

// ---------------------------------------------------------------------------------------------
// PRODUCT TYPE + the three open databases (same API, same barcode candidates, same 3 states)
// ---------------------------------------------------------------------------------------------
export const DATABASES = [
  { id: 'food', name: 'Open Food Facts', host: 'world.openfoodfacts.org' },
  { id: 'beauty', name: 'Open Beauty Facts', host: 'world.openbeautyfacts.org' },
  { id: 'products', name: 'Open Products Facts', host: 'world.openproductsfacts.org' },
];
const PERSONAL_CARE_RE = /cosmetic|beauty|hygiene|personal-care|toilet|shampoo|soap|shower|bath|deodorant|toothpaste|dental|skin|hair|lotion|cream|sun|make-up|makeup|baby-care|diaper/;
// food | cosmetic (personal care: skin, hair, body) | household (cleaners, laundry, other non-food)
// Products filed on the FOOD site by mistake (Clorox wipes "en:disinfectant-wipes", Method "en:all-purpose-cleaner"):
// a category that can only be non-food overrides the site. Matched on whole tag starts so "en:dishes",
// "en:ice-creams" or "en:sunflower-oils" can never trip it.
const MISFILED_HOUSEHOLD = /^[a-z]{2}:(disinfect|all-purpose-clean|cleaning|cleaners?\b|surface-clean|glass-clean|detergents?\b|laundry|dish-?(?:soaps?|washing|liquids?|detergents?)|dishwasher-(?:tablets|detergents?)|bleach|household)/;
const MISFILED_COSMETIC = /^[a-z]{2}:(cosmetics?\b|body-wash|shower-gels?|shampoos?|hair-conditioners?|deodorants?|antiperspirants?|toothpastes?|sunscreens?|skin-care|body-lotions?|moisturi[sz]ers?|hand-soaps?|liquid-soaps?)/;
export function productTypeOf(db, categories = []) {
  if (db === 'fda') return 'cosmetic';        // OTC drug labels here are personal care (sunscreen, antiperspirant, ...)
  if (db === 'food') {
    if (categories.some((c) => MISFILED_HOUSEHOLD.test(String(c)))) return 'household';
    if (categories.some((c) => MISFILED_COSMETIC.test(String(c)))) return 'cosmetic';
    return 'food';
  }
  if (db === 'beauty') return 'cosmetic';
  if (db === 'products') return categories.some((c) => PERSONAL_CARE_RE.test(String(c))) ? 'cosmetic' : 'household';
  return 'food';
}
// Combine the per-database answers (in DATABASES order). Found anywhere wins (food first);
// otherwise any failure means "failed" (never claim "not found" when a database did not answer).
export function combineLookups(results) {
  const hit = results.find((r) => r.state === 'found');
  if (hit) return hit;
  return { state: results.some((r) => r.state === 'failed') ? 'failed' : 'notfound' };
}
// A photo has no database to say what it is: an INCI-style list (aqua, parfum, cetearyl alcohol...) is a
// skin product; bleach / surfactant / disinfectant words make it household; anything else is food.
const INCI_MARKERS = ['aqua', 'parfum', 'fragrance', 'cetearyl alcohol', 'cetyl alcohol', 'stearyl alcohol', 'glyceryl stearate', 'dimethicone',
  'sodium laureth sulfate', 'sodium lauryl sulfate', 'cocamidopropyl betaine', 'phenoxyethanol', 'methylparaben', 'propylparaben', 'methylisothiazolinone',
  'tocopheryl acetate', 'butyrospermum parkii', 'caprylic/capric triglyceride', 'paraffinum liquidum', 'petrolatum', 'carbomer', 'disodium edta',
  'tetrasodium edta', 'ci 77891', 'polysorbate 20', 'peg-', 'ceteareth', 'steareth', 'laureth', 'limonene', 'linalool', 'panthenol', 'allantoin'];
const HOUSEHOLD_MARKERS = ['sodium hypochlorite', 'hypochlorite', 'bleach', 'benzalkonium chloride', 'quaternary ammonium', 'ammonium hydroxide', 'ammonia',
  'surfactant', 'surfactants', 'anionic surfactants', 'nonionic surfactants', 'non-ionic surfactants', 'optical brighteners', 'enzymes', 'zeolites', 'phosphonates',
  'polycarboxylates', 'disinfectant', 'detergent'];
export function guessProductTypeFromText(text) {
  const t = norm(text);
  if (!t) return 'food';
  const count = (list) => list.filter((w) => (w.endsWith('-') ? t.includes(w) : wordRe(w).test(t))).length;
  const house = count(HOUSEHOLD_MARKERS), inci = count(INCI_MARKERS);
  if (house >= 2) return 'household';
  if (inci >= 2) return 'cosmetic';
  return 'food';
}

// ---------------------------------------------------------------------------------------------
// HARMFUL-INGREDIENT table for non-food products (cosmetics, personal care, household cleaners).
// level: high | medium | low.  Primary sources only (EWG Skin Deep is NOT used — it is not a primary source):
//  [EU-II]   EU Cosmetics Regulation 1223/2009 Annex II (prohibited) / III (restricted) / V (preservatives), with
//            amendments: 2016/1198 + 2017/1224 (MI/MCI), 358/2014 (parabens), 2017/1410 (HICC, atranol),
//            2019/831 (formaldehyde -> Annex II), 2021/1902 (lilial -> Annex II), 2022/1176 (benzophenone-3),
//            2022/1181 ("releases formaldehyde" warning for releasers).
//  [SCCS]    EU Scientific Committee on Consumer Safety opinions: SCCS/1514/13 (parabens), SCCS/1625/20
//            (benzophenone-3), SCCS/1636/21 (BHT), SCCS/1575/16 (phenoxyethanol), SCCS/1414/11 (triclosan),
//            SCCS/1459/11 (fragrance allergens).
//  [IARC]    IARC Monographs: formaldehyde Group 1 (vol. 100F), coal tar Group 1 (100F), BHA 2B (vol. 40),
//            diethanolamine 2B (vol. 101), coconut-oil diethanolamine condensate 2B (vol. 101), 1,4-dioxane 2B (vol. 71).
//  [ECHA]    ECHA Candidate List of Substances of Very High Concern (SVHC): DBP, DEHP, BBP (toxic for reproduction),
//            musk xylene (vPvB), triclosan (assessed as PBT-concern under biocides).
//  [FDA16]   US FDA final rule 2016 (81 FR 61106): triclosan + 18 other antiseptics removed from consumer washes.
//  [EPA-SC]  US EPA Safer Choice criteria (chlorine bleach and ammonia are not "safer chemical" ingredients;
//            quats are respiratory/skin irritants — AOEC lists benzalkonium chloride as an asthmagen).
//  [ACDS]    American Contact Dermatitis Society Allergen of the Year (see the skin-contact eczema table above).
// Points off the 100-point "harmful ingredients" score: high 30, medium 15, low 5; any HIGH caps at 49.
// ---------------------------------------------------------------------------------------------
const Hz = (id, level, label, why, words, opts = {}) => ({ id, level, label, why, words, not: opts.not || [], re: opts.re || null });
export const HAZARDS = [
  // --- HIGH ---
  Hz('mi', 'high', { en: 'Methylisothiazolinone / MCI', vi: 'Methylisothiazolinone / MCI' },
    { en: 'strong skin sensitiser — banned in EU leave-on cosmetics, tightly limited in rinse-off (EU 2016/1198, 2017/1224)', vi: 'chất gây mẫn cảm da mạnh — bị cấm trong mỹ phẩm để lại trên da ở EU, bị giới hạn chặt trong sản phẩm rửa trôi (EU 2016/1198, 2017/1224)' },
    ['methylisothiazolinone', 'methylchloroisothiazolinone', 'kathon cg']),
  Hz('formaldehyde', 'high', { en: 'Formaldehyde', vi: 'Formaldehyde' },
    { en: 'known human carcinogen (IARC Group 1) and skin allergen; prohibited in EU cosmetics (EU 2019/831)', vi: 'chất gây ung thư ở người (IARC nhóm 1) và gây dị ứng da; bị cấm trong mỹ phẩm ở EU (EU 2019/831)' },
    ['formaldehyde', 'formalin', 'methylene glycol', 'paraformaldehyde']),
  Hz('fa-releaser', 'high', { en: 'Formaldehyde-releasing preservative', vi: 'Chất bảo quản giải phóng formaldehyde' },
    { en: 'slowly releases formaldehyde (IARC Group 1 carcinogen); EU requires a "releases formaldehyde" warning (EU 2022/1181); common skin allergen (ACDS)', vi: 'giải phóng dần formaldehyde (chất gây ung thư IARC nhóm 1); EU bắt buộc cảnh báo “giải phóng formaldehyde” (EU 2022/1181); hay gây dị ứng da (ACDS)' },
    ['dmdm hydantoin', 'quaternium-15', 'quaternium 15', 'imidazolidinyl urea', 'diazolidinyl urea', 'bronopol', '2-bromo-2-nitropropane-1,3-diol', 'sodium hydroxymethylglycinate', 'methenamine']),
  Hz('banned-fragrance', 'high', { en: 'Fragrance chemical banned in the EU', vi: 'Hương liệu bị cấm ở EU' },
    { en: 'lilial (toxic for reproduction, EU 2021/1902), HICC/lyral and atranol (strong allergens, EU 2017/1410), musk ambrette', vi: 'lilial (độc cho sinh sản, EU 2021/1902), HICC/lyral và atranol (gây dị ứng mạnh, EU 2017/1410), musk ambrette' },
    ['butylphenyl methylpropional', 'lilial', 'hydroxyisohexyl 3-cyclohexene carboxaldehyde', 'lyral', 'atranol', 'chloroatranol', 'musk ambrette']),
  Hz('triclosan', 'high', { en: 'Triclosan / triclocarban', vi: 'Triclosan / triclocarban' },
    { en: 'antibacterial removed from US consumer soaps (FDA 2016 rule) — no benefit shown, hormone and resistance concerns (SCCS/1414/11)', vi: 'chất kháng khuẩn bị loại khỏi xà phòng tiêu dùng ở Mỹ (FDA 2016) — không chứng minh được lợi ích, lo ngại nội tiết và kháng thuốc (SCCS/1414/11)' },
    ['triclosan', 'triclocarban']),
  Hz('phthalate-svhc', 'high', { en: 'Phthalate (DBP / DEHP / BBP)', vi: 'Phthalate (DBP / DEHP / BBP)' },
    { en: 'toxic for reproduction — EU Substance of Very High Concern (ECHA SVHC) and prohibited in EU cosmetics (Annex II)', vi: 'độc cho sinh sản — chất rất đáng lo ngại ở EU (ECHA SVHC), bị cấm trong mỹ phẩm EU (Phụ lục II)' },
    ['dibutyl phthalate', 'dbp', 'diethylhexyl phthalate', 'di(2-ethylhexyl) phthalate', 'dehp', 'benzyl butyl phthalate', 'butyl benzyl phthalate', 'bbp']),
  Hz('banned-parabens', 'high', { en: 'Paraben banned in the EU (isopropyl/isobutyl/phenyl/benzyl/pentyl)', vi: 'Paraben bị cấm ở EU (isopropyl/isobutyl/phenyl/benzyl/pentyl)' },
    { en: 'not enough safety data — prohibited in EU cosmetics since 2014 (EU 358/2014)', vi: 'thiếu dữ liệu an toàn — bị cấm trong mỹ phẩm EU từ 2014 (EU 358/2014)' },
    ['isopropylparaben', 'isobutylparaben', 'phenylparaben', 'benzylparaben', 'pentylparaben']),
  Hz('coal-tar', 'high', { en: 'Coal tar', vi: 'Hắc ín than đá (coal tar)' },
    { en: 'known human carcinogen (IARC Group 1); prohibited in EU cosmetics (Annex II)', vi: 'chất gây ung thư ở người (IARC nhóm 1); bị cấm trong mỹ phẩm EU (Phụ lục II)' },
    ['coal tar', 'coal-tar']),
  Hz('dea', 'high', { en: 'Diethanolamine (DEA) / cocamide DEA', vi: 'Diethanolamine (DEA) / cocamide DEA' },
    { en: 'possible carcinogen (IARC 2B, vol. 101); DEA itself is prohibited in EU cosmetics (Annex II)', vi: 'có thể gây ung thư (IARC 2B); bản thân DEA bị cấm trong mỹ phẩm EU (Phụ lục II)' },
    ['diethanolamine', 'cocamide dea', 'lauramide dea', 'oleamide dea', 'linoleamide dea'], { re: /(?<![\p{L}\p{N}])dea(?![\p{L}\p{N}-])/u }),
  Hz('musk-xylene', 'high', { en: 'Nitro musk (musk xylene)', vi: 'Xạ hương nitro (musk xylene)' },
    { en: 'very persistent and bioaccumulative — EU Substance of Very High Concern (ECHA SVHC, vPvB)', vi: 'rất khó phân huỷ và tích tụ sinh học — chất rất đáng lo ngại ở EU (ECHA SVHC)' },
    ['musk xylene']),
  Hz('bha', 'high', { en: 'BHA', vi: 'BHA' },
    { en: 'possible carcinogen (IARC 2B)', vi: 'có thể gây ung thư (IARC 2B)' },
    ['butylated hydroxyanisole']),
  // --- MEDIUM ---
  Hz('fragrance', 'medium', { en: 'Fragrance / parfum (undisclosed mix)', vi: 'Hương liệu / parfum (hỗn hợp không công bố)' },
    { en: 'can hide dozens of chemicals; the leading cause of cosmetic skin allergy — EU requires the main allergens to be named (EU 1223/2009 Annex III, SCCS/1459/11)', vi: 'có thể che hàng chục hoá chất; nguyên nhân hàng đầu gây dị ứng da do mỹ phẩm — EU bắt buộc ghi tên các chất gây dị ứng chính (EU 1223/2009, SCCS/1459/11)' },
    ['fragrance', 'parfum', 'perfume', 'masking fragrance', 'hương liệu'],
    { not: ['fragrance free', 'fragrance-free', 'without fragrance', 'unscented', 'sans parfum', 'không hương liệu'] }),
  Hz('strong-frag-allergen', 'medium', { en: 'Strong fragrance allergen (isoeugenol, cinnamal, hydroxycitronellal…)', vi: 'Chất hương liệu gây dị ứng mạnh (isoeugenol, cinnamal, hydroxycitronellal…)' },
    { en: 'established human contact allergen with EU concentration limits (SCCS/1459/11; EU Annex III)', vi: 'chất gây dị ứng tiếp xúc đã được xác nhận, bị EU giới hạn nồng độ (SCCS/1459/11; Phụ lục III)' },
    ['isoeugenol', 'cinnamal', 'cinnamyl alcohol', 'hydroxycitronellal', 'evernia prunastri', 'oakmoss', 'evernia furfuracea', 'treemoss', 'musk ketone']),
  Hz('pb-parabens', 'medium', { en: 'Propylparaben / butylparaben', vi: 'Propylparaben / butylparaben' },
    { en: 'weak hormone-like activity — EU limits them to 0.14% and bans them in leave-on nappy-area products for under-3s (EU 358/2014, SCCS/1514/13)', vi: 'hoạt tính giống hormone yếu — EU giới hạn 0,14% và cấm trong sản phẩm vùng tã cho trẻ dưới 3 tuổi (EU 358/2014, SCCS/1514/13)' },
    ['propylparaben', 'butylparaben', 'sodium propylparaben', 'sodium butylparaben']),
  Hz('oxybenzone', 'medium', { en: 'Oxybenzone (benzophenone-3)', vi: 'Oxybenzone (benzophenone-3)' },
    { en: 'possible hormone disruptor — EU cut the allowed amount (SCCS/1625/20; EU 2022/1176)', vi: 'có thể gây rối loạn nội tiết — EU đã giảm mức cho phép (SCCS/1625/20; EU 2022/1176)' },
    ['oxybenzone', 'benzophenone-3', 'benzophenone 3']),
  Hz('ppd', 'medium', { en: 'Hair dye PPD (p-phenylenediamine)', vi: 'Thuốc nhuộm PPD' },
    { en: 'strong contact allergen; restricted in EU hair dyes (Annex III; ACDS 2006)', vi: 'gây dị ứng tiếp xúc mạnh; bị giới hạn trong thuốc nhuộm tóc ở EU (Phụ lục III; ACDS 2006)' },
    ['p-phenylenediamine', 'paraphenylenediamine', 'phenylenediamine', 'toluene-2,5-diamine']),
  Hz('bleach', 'medium', { en: 'Chlorine bleach (sodium hypochlorite)', vi: 'Thuốc tẩy clo (natri hypoclorit)' },
    { en: 'corrosive to skin and eyes; NEVER mix with ammonia or acids (toxic gas); not a Safer Choice ingredient (US EPA)', vi: 'ăn mòn da và mắt; KHÔNG BAO GIỜ trộn với amoniac hay axit (sinh khí độc); không thuộc danh sách an toàn hơn của EPA Mỹ' },
    ['sodium hypochlorite', 'hypochlorite', 'chlorine bleach', 'javel'], { not: ['non-chlorine bleach', 'chlorine-free'] }),
  Hz('ammonia', 'medium', { en: 'Ammonia', vi: 'Amoniac' },
    { en: 'irritates skin, eyes and lungs; never mix with bleach (US EPA Safer Choice criteria)', vi: 'kích ứng da, mắt và phổi; không bao giờ trộn với thuốc tẩy (tiêu chí Safer Choice của EPA Mỹ)' },
    ['ammonia', 'ammonium hydroxide']),
  Hz('quats', 'medium', { en: 'Quat disinfectant (benzalkonium chloride…)', vi: 'Chất khử khuẩn “quat” (benzalkonium chloride…)' },
    { en: 'skin irritant and recognised asthma trigger (AOEC asthmagen list)', vi: 'gây kích ứng da và là tác nhân gây hen đã được ghi nhận (danh sách AOEC)' },
    ['benzalkonium chloride', 'benzethonium chloride', 'didecyldimethylammonium chloride', 'alkyl dimethyl benzyl ammonium chloride', 'quaternary ammonium', 'dimethyl benzyl ammonium', 'dimethylbenzyl ammonium', 'dimethylbenzylammonium', 'dimethyl ethylbenzyl ammonium', 'didecyl dimethyl ammonium', 'dioctyl dimethyl ammonium', 'octyl decyl dimethyl ammonium']),
  // --- LOW ---
  Hz('frag-allergen', 'low', { en: 'Labelled fragrance allergen (limonene, linalool…)', vi: 'Chất gây dị ứng hương liệu có ghi (limonene, linalool…)' },
    { en: 'allergenic mainly once oxidised by air; EU requires them on the label above a small amount (SCCS/1459/11)', vi: 'gây dị ứng chủ yếu khi bị ôxy hoá; EU bắt buộc ghi nhãn khi vượt mức nhỏ (SCCS/1459/11)' },
    ['limonene', 'linalool', 'citronellol', 'geraniol', 'citral', 'eugenol', 'coumarin', 'benzyl salicylate', 'benzyl benzoate', 'benzyl cinnamate', 'farnesol', 'alpha-isomethyl ionone', 'amyl cinnamal', 'hexyl cinnamal', 'anise alcohol', 'benzyl alcohol']),
  Hz('dep', 'low', { en: 'Diethyl phthalate (DEP)', vi: 'Diethyl phthalate (DEP)' },
    { en: 'fragrance solvent; considered safe at cosmetic levels by the SCCS — unlike DBP/DEHP it is not an SVHC', vi: 'dung môi hương liệu; SCCS coi là an toàn ở mức trong mỹ phẩm — khác DBP/DEHP, không phải SVHC' },
    ['diethyl phthalate', 'dep']),
  Hz('me-parabens', 'low', { en: 'Methylparaben / ethylparaben', vi: 'Methylparaben / ethylparaben' },
    { en: 'judged safe at permitted levels (SCCS/1514/13) — far less concern than propyl/butyl', vi: 'được đánh giá an toàn ở mức cho phép (SCCS/1514/13) — ít đáng lo hơn nhiều so với propyl/butyl' },
    ['methylparaben', 'ethylparaben', 'sodium methylparaben', 'sodium ethylparaben']),
  Hz('bht', 'low', { en: 'BHT', vi: 'BHT' },
    { en: 'antioxidant judged safe in cosmetics up to 0.8% (SCCS/1636/21)', vi: 'chất chống ôxy hoá được đánh giá an toàn trong mỹ phẩm tới 0,8% (SCCS/1636/21)' },
    ['bht', 'butylated hydroxytoluene']),
  Hz('sls', 'low', { en: 'Sodium lauryl sulfate', vi: 'Sodium lauryl sulfate' },
    { en: 'harsh foaming agent — a skin irritant, not a toxic one', vi: 'chất tạo bọt mạnh — gây kích ứng da, không độc' },
    ['sodium lauryl sulfate', 'ammonium lauryl sulfate', 'sodium dodecyl sulfate']),
  Hz('capb', 'low', { en: 'Cocamidopropyl betaine', vi: 'Cocamidopropyl betaine' },
    { en: 'mild foaming agent; occasional skin allergen (ACDS 2004)', vi: 'chất tạo bọt nhẹ; đôi khi gây dị ứng da (ACDS 2004)' },
    ['cocamidopropyl betaine']),
  Hz('pg', 'low', { en: 'Propylene glycol', vi: 'Propylene glycol' },
    { en: 'low toxicity; an occasional skin irritant/allergen (ACDS 2018)', vi: 'độc tính thấp; đôi khi gây kích ứng/dị ứng da (ACDS 2018)' },
    ['propylene glycol']),
  Hz('lanolin', 'low', { en: 'Lanolin', vi: 'Lanolin' },
    { en: 'safe moisturiser for most; occasional allergen (ACDS 2023)', vi: 'chất dưỡng ẩm an toàn với đa số; đôi khi gây dị ứng (ACDS 2023)' },
    ['lanolin', 'lanolin alcohol', 'wool alcohol', 'adeps lanae']),
  Hz('essential-oil', 'low', { en: 'Essential oil', vi: 'Tinh dầu' },
    { en: 'natural fragrance chemicals — can sensitise skin, especially once oxidised (SCCP/1155/08 on tea tree oil)', vi: 'hoá chất hương liệu tự nhiên — có thể gây mẫn cảm da, nhất là khi bị ôxy hoá (SCCP/1155/08)' },
    ['tea tree oil', 'melaleuca alternifolia', 'lavender oil', 'lavandula angustifolia oil', 'peppermint oil', 'mentha piperita oil', 'eucalyptus oil', 'eucalyptus globulus leaf oil', 'citrus aurantium dulcis peel oil', 'citrus limon peel oil', 'rosmarinus officinalis leaf oil', 'cananga odorata', 'essential oil']),
  Hz('tea', 'low', { en: 'Triethanolamine (TEA)', vi: 'Triethanolamine (TEA)' },
    { en: 'pH adjuster; restricted in EU (Annex III) because it can form nitrosamines with some ingredients', vi: 'chất điều chỉnh pH; bị giới hạn ở EU (Phụ lục III) vì có thể tạo nitrosamin với một số thành phần' },
    ['triethanolamine', 'tea-lauryl sulfate'], { re: /(?<![\p{L}\p{N}])tea(?=[- ](?:lauryl|laureth|cocoyl|dodecylbenzenesulfonate))/u }),
  Hz('ethoxylated', 'low', { en: 'Ethoxylated ingredient (PEG / "-eth")', vi: 'Thành phần ethoxyl hoá (PEG / “-eth”)' },
    { en: 'safe itself, but the process can leave traces of 1,4-dioxane (IARC 2B) — a contamination risk, not an ingredient risk', vi: 'bản thân an toàn, nhưng quá trình sản xuất có thể để lại vết 1,4-dioxane (IARC 2B) — rủi ro tạp nhiễm, không phải của thành phần' },
    ['sodium laureth sulfate', 'ammonium laureth sulfate', 'laureth', 'ceteareth', 'steareth', 'oleth', 'pareth', 'ceteth', 'polysorbate', '1,4-dioxane'],
    { re: /(?<![\p{L}\p{N}])peg-\d|(?<![\p{L}\p{N}])\w+eth-\d/u }),
  Hz('brightener', 'low', { en: 'Optical brightener', vi: 'Chất làm trắng quang học' },
    { en: 'stays on fabric to look "whiter"; poorly biodegradable, occasional skin irritant', vi: 'bám trên vải để trông “trắng hơn”; khó phân huỷ, đôi khi kích ứng da' },
    ['optical brightener', 'optical brighteners', 'fluorescent whitening agent', 'distyrylbiphenyl', 'stilbene']),
  Hz('dyes', 'low', { en: 'Synthetic colour (FD&C / D&C)', vi: 'Phẩm màu tổng hợp (FD&C / D&C)' },
    { en: 'coal-tar-derived dyes, purified for cosmetic use; occasional skin allergen', vi: 'phẩm màu gốc hắc ín, đã tinh chế cho mỹ phẩm; đôi khi gây dị ứng da' },
    ['fd&c', 'd&c']),
  Hz('phenoxyethanol', 'low', { en: 'Phenoxyethanol', vi: 'Phenoxyethanol' },
    { en: 'preservative judged safe up to 1% (SCCS/1575/16)', vi: 'chất bảo quản được đánh giá an toàn tới 1% (SCCS/1575/16)' },
    ['phenoxyethanol']),
];
const HAZARD_POINTS = { high: 30, medium: 15, low: 5 };
const LEVEL_RATING = { high: 'bad', medium: 'caution', low: 'neutral' };
// common harmless INCI / cleaner bases, so they show "neutral" instead of "not rated"
const NONFOOD_SAFE = ['aqua', 'water', 'eau', 'glycerin', 'glycerine', 'cetearyl alcohol', 'cetyl alcohol', 'stearyl alcohol', 'myristyl alcohol', 'stearic acid',
  'glyceryl stearate', 'dimethicone', 'tocopherol', 'tocopheryl acetate', 'panthenol', 'niacinamide', 'allantoin', 'sodium chloride', 'citric acid', 'sodium citrate',
  'xanthan gum', 'butyrospermum parkii', 'shea butter', 'caprylic/capric triglyceride', 'paraffinum liquidum', 'paraffin', 'petrolatum', 'mineral oil', 'cera microcristallina',
  'squalane', 'hyaluronic acid', 'sodium hyaluronate', 'carbomer', 'sodium hydroxide', 'potassium hydroxide', 'disodium edta', 'tetrasodium edta', 'sodium benzoate',
  'potassium sorbate', 'sodium carbonate', 'sodium bicarbonate', 'sodium percarbonate', 'zinc oxide', 'titanium dioxide', 'ci 77891', 'helianthus annuus seed oil',
  'magnesium sulfate', 'decyl glucoside', 'coco-glucoside', 'lauryl glucoside', 'sodium lauroyl glycinate', 'sodium lauroyl isethionate', 'lauric acid', 'zeolite', 'enzymes', 'protease', 'amylase'];
const NONFOOD_SAFE_WHY = { en: 'common base ingredient, low concern', vi: 'thành phần nền phổ biến, ít đáng lo' };
export function hazardsInText(text) {
  const t = norm(text);
  return HAZARDS.filter((h) => matchesAny(t, h.words, h.not) || (h.re && h.re.test(stripPhrases(t, h.not))));
}
function rateNonFoodIngredient(text) {
  const hz = hazardsInText(text).sort((a, b) => HAZARD_POINTS[b.level] - HAZARD_POINTS[a.level]);
  if (hz.length) return { rating: LEVEL_RATING[hz[0].level], why: { en: `${hz[0].label.en}: ${hz[0].why.en}`, vi: `${hz[0].label.vi}: ${hz[0].why.vi}` }, hazard: hz[0] };
  if (matchesAny(norm(text), NONFOOD_SAFE)) return { rating: 'neutral', why: NONFOOD_SAFE_WHY };
  return { rating: 'unrated', why: NOT_RATED };
}

// Cosmetics / personal care / household: "harmful ingredients" score 0-100 (100 = nothing concerning found)
// instead of the nutrition score; contact-eczema table instead of the food-trigger table.
function analyzeNonFood(input, type) {
  const tree = input.ingredientTree && input.ingredientTree.length ? input.ingredientTree : parseIngredientsText(input.ingredientsText);
  const hasText = !!(input.ingredientsText && input.ingredientsText.trim()) || tree.length > 0;
  const ingredients = rateIngredientTree(tree, [], { rate: (text) => rateNonFoodIngredient(text), table: ECZEMA_CONTACT });
  const found = new Map();
  for (const ing of ingredients) for (const hz of hazardsInText(ing.text)) if (!found.has(hz.id)) found.set(hz.id, { hz, via: ing.text });
  if (!tree.length && input.ingredientsText) for (const hz of hazardsInText(input.ingredientsText)) if (!found.has(hz.id)) found.set(hz.id, { hz, via: '' });
  const list = [...found.values()].map(({ hz, via }) => ({ id: hz.id, code: '', risk: hz.level === 'medium' ? 'moderate' : hz.level, label: hz.label, why: hz.why, via }))
    .sort((a, b) => RISK_POINTS[b.risk] - RISK_POINTS[a.risk]);
  let score = null, capped = false;
  if (hasText) {
    score = Math.max(0, 100 - list.reduce((s, x) => s + HAZARD_POINTS[x.risk === 'moderate' ? 'medium' : x.risk], 0));
    if (list.some((x) => x.risk === 'high') && score > 49) { score = 49; capped = true; }
  }
  const reasons = [];
  if (capped) reasons.push({ kind: 'bad', en: 'Has a high-concern ingredient, so the score is capped at 49', vi: 'Có thành phần đáng lo ngại cao nên điểm bị giới hạn ở 49' });
  for (const x of list) reasons.push({ kind: x.risk === 'low' ? 'info' : 'bad', en: `Contains ${x.label.en} — ${x.why.en}`, vi: `Có ${x.label.vi} — ${x.why.vi}` });
  if (hasText && !list.length) reasons.push({ kind: 'good', en: 'No concerning ingredients found in our list', vi: 'Không thấy thành phần đáng lo trong danh sách của chúng tôi' });
  const eczema = eczemaCheck({ ingredients, hasIngredientText: hasText, containsText: input.containsText || '', mayContainText: '', table: ECZEMA_CONTACT });
  const allergens = findAllergens({ ingredients, ingredientsText: input.ingredientsText || '', containsText: input.containsText || '', mayContainText: input.mayContainText || '',
    allergenTags: input.allergens || [], traceTags: input.traces || [], productType: type });
  return {
    type, score, partial: false, capped, missing: hasText ? [] : ['ingredients'], band: score == null ? null : bandFor(score), allergens,
    cancer: cancerCheck({ ingredients, ingredientsText: input.ingredientsText || '', categories: input.categories || [], productType: type }),
    parts: { harm: { points: score, list } },
    reasons, eczema, eczemaScore: eczemaScore(eczema), ingredients, nutrients: {}, category: type,
  };
}


// ---------------------------------------------------------------------------------------------
// MY ALLERGIES — the user ticks their own allergens; every scan checks them FIRST.
// This is a WORD check of the printed / database ingredient text, not a lab test: it can only find what is
// written. It never says "safe" — a "none found" result always tells the user to read the package.
// Synonym lists REUSE the eczema / contact-eczema / hazard tables above (syn() merges them) and add
// allergen-only names: INCI botanical names for food allergens in cosmetics, and the Open Food Facts
// allergen tag ids (en:milk, en:gluten ...). Sources for the food list: US FALCPA + FASTER Act (9 major
// allergens) and EU Regulation 1169/2011 Annex II (14 allergens incl. celery, mustard, lupin, molluscs,
// sulphites >10 mg/kg); FDA 2025 food-allergen guidance (coconut no longer listed as a tree nut).
// Skin list: NACDG / ACDS patch-test allergens (see ECZEMA_CONTACT) + EU 1223/2009 Annex III fragrance
// allergens (the "26" that must be named on the label).
//   source of a hit: 'ingredients' (in the ingredient list) | 'contains' (the CONTAINS line) |
//                    'traces' (may contain / traces) | 'maybe' (cross-contact risk, e.g. oats -> gluten) |
//                    'tag' (only in the database's allergen tags — crowd data can be wrong, e.g. Shin Ramyun
//                    tagged milk/egg — so it is shown as "listed by database, not in ingredient text").
// ---------------------------------------------------------------------------------------------
const uniq = (a) => [...new Set(a)];
const syn = (...lists) => uniq(lists.flat());
const ecw = (id) => ECZ_BY_ID[id].words;
const ecn = (id) => ECZ_BY_ID[id].not;
const hzw = (id) => HAZARDS.find((x) => x.id === id).words;
const Al = (id, group, name, words, opts = {}) => ({ id, group, name, words, not: opts.not || [], tags: opts.tags || [], additives: opts.additives || [],
  maybe: opts.maybe || [], maybeWhy: opts.maybeWhy || null, note: opts.note || null, cosmeticWords: opts.cosmeticWords || [] });
// plant "butters" are not dairy (shea, cocoa, mango, nut butters ...)
const NOT_DAIRY_BUTTER = ['seed butter', 'kernel butter', 'parkii butter', 'shea) butter', 'nut butter', 'fruit butter', 'cacao butter', 'mango butter', 'kokum butter', 'murumuru butter', 'body butter'];
export const ALLERGENS = [
  // ---------------- FOOD ----------------
  Al('milk', 'food', { en: 'Milk', vi: 'Sữa' },
    syn(ecw('milk'), ['casein', 'caseinate', 'sodium caseinate', 'calcium caseinate', 'whey', 'whey protein', 'lactose', 'lactalbumin', 'lactoglobulin', 'ghee', 'butter', 'butterfat', 'butter oil', 'cream', 'sour cream', 'cheese', 'curds', 'milk solids', 'milk powder', 'skimmed milk', 'milk protein', 'hydrolyzed milk protein', 'lactis proteinum', 'lait', 'lactosérum', 'lactoserum', 'kefir', 'paneer']),
    { not: syn(ecn('milk'), NOT_DAIRY_BUTTER, ['lactic acid', 'calcium lactate', 'sodium lactate', 'cream of coconut', 'dairy free']), tags: ['en:milk'] }),
  Al('egg', 'food', { en: 'Egg', vi: 'Trứng' },
    syn(ecw('egg'), ['egg powder', 'dried egg', 'albumin', 'albumen', 'ovalbumin', 'ovomucoid', 'ovotransferrin', 'ovovitellin', 'livetin', 'lysozyme', 'mayonnaise', 'meringue', 'ovum', 'ovum extract']),
    { not: syn(ecn('egg'), ['egg-free', 'egg free']), tags: ['en:eggs'], additives: ['e1105'] }),
  Al('peanut', 'food', { en: 'Peanut', vi: 'Đậu phộng (lạc)' },
    syn(ecw('peanut'), ['arachis hypogaea', 'arachis oil', 'peanut oil', 'monkey nut', 'monkey nuts']),
    { not: ['peanut-free', 'peanut free'], tags: ['en:peanuts'] }),
  Al('treenuts', 'food', { en: 'Tree nuts', vi: 'Các loại hạt cây' },
    syn(ecw('treenuts'), ['brazil nut', 'pine nut', 'pinyon', 'pignoli', 'marzipan', 'nougat', 'gianduja', 'frangipane', 'prunus amygdalus dulcis', 'prunus dulcis', 'sweet almond oil', 'juglans regia', 'corylus avellana', 'macadamia ternifolia', 'macadamia integrifolia', 'anacardium occidentale', 'pistacia vera', 'carya illinoinensis', 'bertholletia excelsa']),
    { not: syn(ecn('treenuts'), ['tree nut-free', 'tree nut free']), tags: ['en:nuts'] }),
  Al('coconut', 'food', { en: 'Coconut', vi: 'Dừa' },
    ['coconut', 'coconut oil', 'coconut milk', 'coconut cream', 'cocos nucifera', 'copra', 'noix de coco', 'dừa', 'sữa dừa', 'nước cốt dừa'],
    { not: ['coconut-free', 'coconut free'],
      note: { en: 'Coconut is a separate, uncommon allergy — the US FDA no longer counts it as a tree nut (2025 guidance). Coconut-derived soap ingredients (coco-glucoside, cocamide…) are not flagged.', vi: 'Dị ứng dừa là loại riêng, ít gặp — FDA Mỹ không còn xếp dừa vào hạt cây (hướng dẫn 2025). Các chất tạo bọt gốc dừa (coco-glucoside, cocamide…) không bị đánh dấu.' } }),
  Al('wheat', 'food', { en: 'Wheat', vi: 'Lúa mì' },
    ['wheat', 'wheat flour', 'whole wheat', 'wheat starch', 'wheat germ', 'wheat gluten', 'wheat protein', 'hydrolyzed wheat protein', 'triticum', 'triticum vulgare', 'triticum aestivum', 'triticum durum', 'semolina', 'durum', 'spelt', 'farina', 'couscous', 'bulgur', 'seitan', 'einkorn', 'emmer', 'kamut', 'farro', 'enriched flour', 'bleached flour', 'all-purpose flour', 'blé', 'froment', 'épeautre', 'lúa mì', 'bột mì'],
    { not: ['buckwheat', 'wheat-free', 'wheat free', 'blé noir'], tags: ['en:wheat'] }),
  Al('gluten', 'food', { en: 'Gluten (wheat, barley, rye…)', vi: 'Gluten (lúa mì, lúa mạch, lúa mạch đen…)' },
    syn(ecw('wheat'), ['triticale', 'farro', 'kamut', 'einkorn', 'emmer', 'malt', 'malt extract', 'malt flavoring', 'malt flavouring', 'malted barley', 'malted', 'barley malt', 'malt vinegar', "brewer's yeast", 'hordeum vulgare', 'secale cereale', 'triticum', 'triticum vulgare', 'hydrolyzed wheat protein', 'wheat starch']),
    { not: ['buckwheat', 'gluten free', 'gluten-free', 'sans gluten', 'no gluten', 'không chứa gluten', 'không gluten', 'blé noir'], tags: ['en:gluten'],
      maybe: ['oat', 'oats', 'oatmeal', 'oat flour', 'oat bran', 'rolled oats', 'avena sativa', 'avoine', 'yến mạch'],
      maybeWhy: { en: 'oats — often cross-contaminated with wheat unless labelled gluten-free', vi: 'yến mạch — hay bị lẫn lúa mì nếu không ghi “không gluten”' } }),
  Al('oats', 'food', { en: 'Oats', vi: 'Yến mạch' },
    ['oat', 'oats', 'oatmeal', 'oat flour', 'oat bran', 'rolled oats', 'oat fibre', 'oat fiber', 'avena sativa', 'colloidal oatmeal', 'avoine', 'yến mạch'],
    { not: ['oat-free', 'oat free'] }),
  Al('soy', 'food', { en: 'Soy', vi: 'Đậu nành' },
    ['soy', 'soya', 'soybean', 'soybeans', 'soy lecithin', 'soya lecithin', 'soy protein', 'soy sauce', 'edamame', 'tofu', 'miso', 'tempeh', 'natto', 'shoyu', 'tamari', 'yuba', 'okara', 'kinako', 'glycine soja', 'glycine max', 'soja', 'đậu nành', 'đậu tương', 'đậu hũ', 'nước tương'],
    { not: ['soy-free', 'soy free'], tags: ['en:soybeans'] }),
  Al('fish', 'food', { en: 'Fish', vi: 'Cá' },
    syn(ecw('fish'), ['fish oil', 'fish gelatin', 'surimi', 'bonito', 'cá ngừ', 'cá hồi']),
    { not: syn(ecn('fish'), ['fish-free']), tags: ['en:fish'] }),
  Al('crustaceans', 'food', { en: 'Shellfish (crustaceans: shrimp, crab, lobster)', vi: 'Giáp xác (tôm, cua, tôm hùm)' },
    ['shrimp', 'prawn', 'crab', 'lobster', 'crayfish', 'crawfish', 'langoustine', 'scampi', 'krill', 'crustacean', 'crustaceans', 'shellfish', 'crevette', 'homard', 'tôm', 'cua', 'ghẹ', 'mắm tôm'],
    { not: ['shellfish-free', 'imitation crab-free'], tags: ['en:crustaceans'] }),
  Al('molluscs', 'food', { en: 'Molluscs (squid, oyster, clam, mussel)', vi: 'Nhuyễn thể (mực, hàu, nghêu, sò)' },
    ['mollusc', 'molluscs', 'mollusk', 'mollusks', 'oyster', 'oyster sauce', 'clam', 'mussel', 'scallop', 'squid', 'calamari', 'octopus', 'cuttlefish', 'snail', 'escargot', 'abalone', 'whelk', 'cockle', 'shellfish', 'moule', 'sò', 'hến', 'nghêu', 'hàu', 'mực', 'bạch tuộc', 'ốc'],
    { not: ['shellfish-free'], tags: ['en:molluscs'] }),
  Al('sesame', 'food', { en: 'Sesame', vi: 'Mè (vừng)' },
    syn(ecw('sesame'), ['sesame oil', 'sesame seed', 'sesamum indicum', 'gingelly', 'benne seed']),
    { not: ['sesame-free', 'sesame free'], tags: ['en:sesame-seeds'] }),
  Al('corn', 'food', { en: 'Corn (maize)', vi: 'Bắp (ngô)' },
    ['corn', 'maize', 'cornstarch', 'corn starch', 'cornmeal', 'corn flour', 'cornflour', 'corn syrup', 'corn oil', 'high fructose corn syrup', 'popcorn', 'polenta', 'grits', 'hominy', 'masa', 'zea mays', 'maïs', 'bắp', 'ngô'],
    { not: ['peppercorn', 'peppercorns', 'corned', 'corn-free', 'corn free'],
      note: { en: 'Only corn named on the label is found — dextrose, maltodextrin, xanthan gum and citric acid are often made from corn but are not flagged.', vi: 'Chỉ tìm thấy bắp khi được ghi tên — dextrose, maltodextrin, xanthan, axit citric thường làm từ bắp nhưng không bị đánh dấu.' } }),
  Al('mustard', 'food', { en: 'Mustard', vi: 'Mù tạt' },
    ['mustard', 'mustard seed', 'mustard oil', 'mustard flour', 'sinapis', 'sinapis alba', 'brassica juncea', 'brassica nigra', 'moutarde', 'mù tạt'],
    { not: ['mustard-free'], tags: ['en:mustard'] }),
  Al('celery', 'food', { en: 'Celery', vi: 'Cần tây' },
    ['celery', 'celeriac', 'celery seed', 'celery salt', 'celery powder', 'apium graveolens', 'céleri', 'cần tây'],
    { tags: ['en:celery'] }),
  Al('lupin', 'food', { en: 'Lupin', vi: 'Đậu lupin' },
    ['lupin', 'lupine', 'lupini', 'lupinus', 'lupin flour', 'lupinus albus'],
    { tags: ['en:lupin'] }),
  Al('sulfites', 'food', { en: 'Sulfites', vi: 'Sulfit' },
    syn(ecw('sulphites'), ['sodium metabisulfite', 'potassium metabisulfite', 'sodium bisulfite', 'sodium sulfite', 'potassium bisulfite', 'sulfiting agents']),
    { not: ['sulfite-free', 'sulfite free', 'no sulfites added'], tags: ['en:sulphur-dioxide-and-sulphites'], additives: ECZ_BY_ID.sulphites.additives }),
  // ---------------- SKIN & HOUSEHOLD ----------------
  Al('fragrance', 'skin', { en: 'Fragrance / parfum', vi: 'Hương liệu / nước hoa' },
    ecw('c_fragrance'),
    // INCI "Aroma" = a fragrance/flavour additive in cosmetics; on FOOD labels "aroma(s)" just means flavouring
    { not: ecn('c_fragrance'), cosmeticWords: ['aroma', 'arôme'] }),
  Al('fragallergens', 'skin', { en: 'Named fragrance allergens (EU list of 26)', vi: 'Chất gây dị ứng hương liệu có tên (26 chất theo EU)' },
    syn(ecw('c_fragallergen'), ['amylcinnamyl alcohol', 'anisyl alcohol', 'methyl 2-octynoate', 'methyl heptine carbonate', 'oakmoss', 'oak moss', 'treemoss', 'tree moss', 'lyral', 'lilial']),
    { note: { en: 'EU law requires these 26 to be named on cosmetics above 0.001% (leave-on) / 0.01% (rinse-off); products sold elsewhere may hide them inside "fragrance".', vi: 'Luật EU bắt buộc ghi tên 26 chất này trên mỹ phẩm; sản phẩm bán nơi khác có thể giấu chúng trong chữ “fragrance”.' } }),
  Al('balsam', 'skin', { en: 'Balsam of Peru (Myroxylon pereirae)', vi: 'Balsam Peru (Myroxylon pereirae)' },
    ['balsam of peru', 'peru balsam', 'balsam peru', 'myroxylon pereirae', 'myroxylon balsamum', 'balsamum peruvianum', 'tolu balsam'],
    { note: { en: 'Often hidden inside "fragrance"; people allergic to it may also react to cinnamon, vanilla, cloves and citrus peel.', vi: 'Thường nằm ẩn trong “fragrance”; người dị ứng có thể phản ứng với quế, vani, đinh hương, vỏ cam chanh.' } }),
  Al('essentialoils', 'skin', { en: 'Essential oils (tea tree, lavender…)', vi: 'Tinh dầu (tràm trà, oải hương…)' },
    syn(ecw('c_essentialoil'), hzw('essential-oil'), ['lavandula angustifolia oil', 'citrus aurantium bergamia', 'bergamot oil', 'lemongrass oil', 'cymbopogon', 'ylang-ylang', 'geranium oil', 'pelargonium graveolens oil', 'patchouli oil', 'sandalwood oil', 'chamomile oil'])),
  Al('mi', 'skin', { en: 'Methylisothiazolinone (MI / MCI)', vi: 'Methylisothiazolinone (MI / MCI)' }, syn(ecw('c_mi'), hzw('mi'))),
  Al('formaldehyde', 'skin', { en: 'Formaldehyde & formaldehyde releasers', vi: 'Formaldehyde & chất giải phóng formaldehyde' },
    syn(ecw('c_formaldehyde'), hzw('formaldehyde'), hzw('fa-releaser'), ['polyoxymethylene urea', 'benzylhemiformal'])),
  Al('parabens', 'skin', { en: 'Parabens', vi: 'Paraben' },
    syn(ecw('c_parabens'), hzw('pb-parabens'), hzw('me-parabens'), hzw('banned-parabens')), { additives: ['e214', 'e215', 'e216', 'e217', 'e218', 'e219'] }),
  Al('pg', 'skin', { en: 'Propylene glycol', vi: 'Propylene glycol' }, ['propylene glycol', '1,2-propanediol', 'propane-1,2-diol'], { additives: ['e1520'] }),
  Al('lanolin', 'skin', { en: 'Lanolin (wool wax)', vi: 'Lanolin (sáp lông cừu)' }, syn(ecw('c_lanolin'), ['lanolin oil', 'hydrogenated lanolin', 'lanolin acid', 'lanolin wax'])),
  Al('capb', 'skin', { en: 'Cocamidopropyl betaine', vi: 'Cocamidopropyl betaine' }, ecw('c_capb')),
  Al('ppd', 'skin', { en: 'Hair dye PPD (p-phenylenediamine)', vi: 'Thuốc nhuộm tóc PPD' }, syn(ecw('c_ppd'), ['toluene-2,5-diamine sulfate', 'black henna'])),
  Al('nickel', 'skin', { en: 'Nickel', vi: 'Niken' }, ['nickel', 'nickel sulfate', 'nickel sulphate', 'ci 77775'],
    { note: { en: 'Ingredient lists and databases almost never list nickel (it comes from metal parts, tools and some pigments) — "not found" here tells you nothing.', vi: 'Danh sách thành phần và cơ sở dữ liệu gần như không bao giờ ghi niken (đến từ kim loại, dụng cụ, một số chất màu) — “không thấy” ở đây không có ý nghĩa gì.' } }),
  Al('latex', 'skin', { en: 'Latex (natural rubber)', vi: 'Latex (cao su tự nhiên)' }, ['latex', 'natural rubber', 'natural rubber latex', 'hevea brasiliensis', 'rubber latex'],
    { not: ['latex-free', 'latex free', 'synthetic latex', 'no latex'],
      note: { en: 'Gloves, sponges, balloons and some adhesives contain latex but databases rarely list it — read the package.', vi: 'Găng tay, mút, bóng bay, một số keo dán có latex nhưng cơ sở dữ liệu hiếm khi ghi — hãy đọc bao bì.' } }),
  Al('shea', 'skin', { en: 'Shea butter (Butyrospermum parkii)', vi: 'Bơ hạt mỡ (Butyrospermum parkii)' }, ['butyrospermum parkii', 'shea butter', 'shea', 'vitellaria paradoxa'],
    { note: { en: 'Low evidence: refined shea butter carries almost no nut protein and reactions are very rare — only tick this if a doctor told you to.', vi: 'Bằng chứng yếu: bơ hạt mỡ tinh luyện gần như không có đạm hạt, phản ứng rất hiếm — chỉ chọn nếu bác sĩ dặn.' } }),
];
export const ALLERGEN_BY_ID = Object.fromEntries(ALLERGENS.map((a) => [a.id, a]));
const ALG_SOURCE_RANK = { ingredients: 0, contains: 1, tag: 2, traces: 3, maybe: 4 };
// Every allergen found in a product (independent of anyone's profile). Returns { hasList, hits: [{id, source, matched}] }.
export function findAllergens({ ingredients = [], ingredientsText = '', containsText = '', mayContainText = '', allergenTags = [], traceTags = [], additiveCodes = [], productType = 'food' } = {}) {
  const hits = [];
  const seen = new Set();
  const add = (id, source, matched) => { const k = `${id}|${source}|${matched}`; if (!seen.has(k)) { seen.add(k); hits.push({ id, source, matched }); } };
  const scan = (text, source, label) => {
    const t = norm(text);
    if (!t) return;
    for (const a of ALLERGENS) {
      const w = matchesAny(t, a.words, a.not) || (productType !== 'food' && a.cosmeticWords.length ? matchesAny(t, a.cosmeticWords, a.not) : null);
      if (w) add(a.id, source, label || w);
    }
    for (const code of eNumbersInText(t)) for (const a of ALLERGENS) if (a.additives.includes(code)) add(a.id, source, code.toUpperCase());
  };
  const allText = norm([ingredientsText, ...ingredients.map((i) => i.text)].join(' '));
  if (ingredients.length) {
    // The parser can split "Butyrospermum Parkii (Shea) Butter" into "... (Shea)" + "Butter". A hit found in an
    // ingredient's OWN words must therefore also stand on the whole label text, where "(shea) butter" is intact
    // and removed by the not-phrases. Hits that come only from the database's English id are kept as they are.
    const full = norm(ingredientsText);
    for (const ing of ingredients) {
      const own = norm(ing.text), viaId = norm(idWords(ing.id));
      for (const a of ALLERGENS) {
        const words = productType !== 'food' ? [...a.words, ...a.cosmeticWords] : a.words;
        let w = matchesAny(own, words, a.not);
        if (w && full && !matchesAny(full, [w], a.not)) w = null;
        if (!w && viaId) w = matchesAny(viaId, words, a.not);
        if (w) add(a.id, 'ingredients', ing.text);
      }
      for (const code of eNumbersInText(own)) for (const a of ALLERGENS) if (a.additives.includes(code)) add(a.id, 'ingredients', code.toUpperCase());
    }
  } else scan(ingredientsText, 'ingredients');
  scan(containsText, 'contains');
  // cross-contact risk words (oats -> gluten) unless the product says gluten-free
  for (const a of ALLERGENS) {
    if (!a.maybe.length || hits.some((h) => h.id === a.id)) continue;
    if (/gluten[- ]free|sans gluten|không (?:chứa )?gluten/.test(allText) && a.id === 'gluten') continue;
    const w = matchesAny(allText, a.maybe);
    if (w) add(a.id, 'maybe', w);
  }
  const textIds = new Set(hits.map((h) => h.id));
  for (const a of ALLERGENS) {
    const tag = a.tags.find((tg) => allergenTags.includes(tg));
    if (tag && !textIds.has(a.id)) add(a.id, 'tag', tag);
  }
  for (const code of additiveCodes) for (const a of ALLERGENS) if (a.additives.includes(code) && !textIds.has(a.id)) add(a.id, 'tag', code.toUpperCase());
  // "may contain" / traces only count when the allergen is not already IN the product
  const inIds = new Set(hits.filter((h) => h.source !== 'maybe').map((h) => h.id));
  const tr = norm(mayContainText);
  if (tr) for (const a of ALLERGENS) { const w = matchesAny(tr, a.words, a.not); if (w && !inIds.has(a.id)) add(a.id, 'traces', w); }
  for (const a of ALLERGENS) { const tag = a.tags.find((tg) => traceTags.includes(tg)); if (tag && !inIds.has(a.id)) add(a.id, 'traces', tag); }
  hits.sort((x, y) => ALG_SOURCE_RANK[x.source] - ALG_SOURCE_RANK[y.source]);
  const hasList = !!(String(ingredientsText || '').trim() || ingredients.length || String(containsText || '').trim());
  return { hasList, hits };
}
// The user's view: which of THEIR allergens are in it. status: off (no profile) | red | amber | unknown | none.
//   red    = in the ingredients / CONTAINS line / database tags (tag-only ones are marked tagOnly)
//   amber  = only "may contain" / traces / cross-contact
//   unknown= no ingredient list to check (never "safe")
//   none   = none of the ticked allergens in the listed ingredients (still: read the package)
export function allergyReport(found, profile = []) {
  const ids = (profile || []).filter((id) => ALLERGEN_BY_ID[id]);
  if (!ids.length) return { status: 'off', red: [], amber: [], unknown: false, notes: [] };
  const hits = (found && found.hits) || [];
  const group = (pred) => ids.map((id) => {
    const hs = hits.filter((h) => h.id === id && pred(h));
    if (!hs.length) return null;
    const a = ALLERGEN_BY_ID[id];
    return { id, name: a.name, matched: uniq(hs.map((h) => h.matched)), sources: uniq(hs.map((h) => h.source)), tagOnly: hs.every((h) => h.source === 'tag'), maybeWhy: a.maybeWhy };
  }).filter(Boolean);
  const red = group((h) => ['ingredients', 'contains', 'tag'].includes(h.source));
  const redIds = new Set(red.map((r) => r.id));
  const amber = group((h) => ['traces', 'maybe'].includes(h.source)).filter((x) => !redIds.has(x.id));
  const unknown = !(found && found.hasList);
  const status = red.length ? 'red' : amber.length ? 'amber' : unknown ? 'unknown' : 'none';
  const notes = ids.map((id) => ALLERGEN_BY_ID[id]).filter((a) => a.note && !redIds.has(a.id)).map((a) => ({ id: a.id, name: a.name, note: a.note }));
  return { status, red, amber, unknown, notes };
}
// compact form kept in "My products" history so the ranking can show a ⚠️ chip for whatever the profile is today
export const allergenSummary = (found) => ({
  c: uniq(found.hits.filter((h) => ['ingredients', 'contains', 'tag'].includes(h.source)).map((h) => h.id)),
  t: uniq(found.hits.filter((h) => ['traces', 'maybe'].includes(h.source)).map((h) => h.id)),
  u: !found.hasList,
});

// ---------------------------------------------------------------------------------------------
// CANCER-RISK SCORE 0-100 (food AND household / personal care). 100 = no cancer-linked ingredient FOUND.
// It shows ingredients that an authority has CLASSIFIED as cancer-linked — it does NOT say the product causes
// cancer: amount, how often, and how you are exposed (eaten / on skin / breathed in) all matter.
// Authoritative classifications only (checked 2026-10-10):
//  [IARC]  IARC Monographs: Group 1 = carcinogenic to humans, 2A = probably, 2B = possibly.
//          processed meat 1 + red meat 2A (vol. 114, 2015); alcoholic beverages / ethanol in them 1 (vol. 96, 100E);
//          Chinese-style salted fish 1 (vol. 56, 100E); ingested nitrate/nitrite under nitrosating conditions 2A
//          (vol. 94); aspartame 2B (vol. 134, 2023 — JECFA kept the ADI of 40 mg/kg bw/day the same week);
//          BHA 2B (vol. 40); potassium bromate 2B (vol. 73); 4-methylimidazole 2B (vol. 101, forms in caramel
//          colours III/IV = E150c/E150d); titanium dioxide 2B (vol. 93 — for INHALED dust); acrylamide 2A (vol. 60);
//          formaldehyde 1 (vol. 100F); coal tar 1 (100F); 1,4-dioxane 2B (vol. 71); talc 2A (vol. 136, 2024);
//          benzophenone 2B (vol. 101); diethanolamine + coconut-oil DEA condensate 2B (vol. 101); crystalline
//          silica 1 when inhaled (100C); benzene 1 (120); trichloroethylene 1 (106); tetrachloroethylene 2A (106);
//          dichloromethane 2A (110); naphthalene 2B (82); 1,4-dichlorobenzene 2B (73); glyphosate 2A (112);
//          methyleugenol 2B (101); safrole 2B (Suppl. 7); Citrus Red No. 2 2B (Suppl. 7).
//  [P65]   California Proposition 65 list (4-MEI, acrylamide, DEA condensates, benzophenone ...).
//  [NTP]   US NTP Report on Carcinogens, 15th ed. (formaldehyde, BHA, crystalline silica, trichloroethylene ...).
//  [EFSA]  EFSA 2021 (EFSA Journal 19:6585): E171 titanium dioxide no longer considered safe as a FOOD additive —
//          genotoxicity could not be ruled out (EU ban 2022/63). That is a food-only concern.
//  LEFT OUT on purpose: food-grade carrageenan (NOT classified; only degraded "poligeenan" is IARC 2B and it is not
//  a food additive); coffee (IARC Group 3; California exempted it 2019); saccharin (IARC Group 3); sucralose;
//  FD&C / D&C dyes (made from petrochemicals, not classified like coal tar itself); palm-oil glycidyl esters
//  (a processing contaminant, level unknown per product); titanium dioxide in creams (not inhaled).
// Weight (points off 100): STRONG (IARC 1 / known) 40 and caps the score at 49; MODERATE (2A / probable) 20;
// MILD (2B / possible / Prop 65 only) 8. Worst first, each further hit counts 70% of the one before (like the
// eczema score). No ingredient list = NO score ("?"), never 100.
// ---------------------------------------------------------------------------------------------
export const CANCER_SCORE_RULE = { weights: { strong: 40, moderate: 20, mild: 8 }, decay: 0.7, strongCap: 49 };
const Cx = (id, level, scope, name, why, words, opts = {}) => ({ id, level, scope, name, why, words, not: opts.not || [], re: opts.re || null,
  additives: opts.additives || [], cats: opts.cats || [], beverageOnly: !!opts.beverageOnly, note: opts.note || null });
const PROCESSED_MEAT_CATS = ['en:processed-meats', 'en:prepared-meats', 'en:bacon', 'en:bacons', 'en:smoked-bacon', 'en:hams', 'en:sausages', 'en:hot-dogs',
  'en:frankfurters', 'en:salamis', 'en:cured-meats', 'en:charcuteries', 'en:dried-meats', 'en:jerky', 'en:corned-beef', 'en:pepperoni', 'en:chorizos'];
const PROCESSED_MEAT_WORDS = ['bacon', 'ham', 'hams', 'salami', 'pepperoni', 'sausage', 'hot dog', 'frankfurter', 'wiener', 'bologna', 'chorizo', 'prosciutto',
  'pastrami', 'corned beef', 'jerky', 'luncheon meat', 'spam', 'cured meat', 'smoked meat', 'lap cheong', 'xúc xích', 'giăm bông', 'thịt xông khói', 'lạp xưởng', 'chả lụa'];
const NOT_REAL_MEAT = ['bacon flavor', 'bacon flavour', 'bacon flavored', 'bacon flavoured', 'imitation bacon', 'ham flavor', 'ham flavour', 'meatless', 'plant-based', 'vegetarian', 'vegan', 'meat-free', 'meat free'];
const NITRITE_CODES = ['e249', 'e250', 'e251', 'e252'];
const NITRITE_WORDS = ['sodium nitrite', 'potassium nitrite', 'sodium nitrate', 'potassium nitrate', 'nitrite', 'nitrate'];
const MEAT_WORDS = ['pork', 'beef', 'chicken', 'turkey', 'meat', 'lamb', 'veal', 'mutton', 'thịt'];
const RED_MEAT_WORDS = ['beef', 'pork', 'lamb', 'mutton', 'veal', 'goat meat', 'venison', 'thịt bò', 'thịt heo', 'thịt lợn', 'thịt cừu'];
const NOT_RED_MEAT = ['beef extract', 'beef bone extract', 'beef fat', 'beef flavor', 'beef flavour', 'beef broth', 'beef stock', 'beef tallow', 'beef gelatin',
  'pork fat', 'pork gelatin', 'pork lard', 'pork rind', 'beef bouillon'];
const hz = (id) => HAZARDS.find((x) => x.id === id);
export const CARCINOGENS = [
  // ---- food ----
  Cx('processed_meat', 'strong', 'food', { en: 'Processed meat (bacon, ham, sausage, hot dog…)', vi: 'Thịt chế biến (thịt xông khói, giăm bông, xúc xích…)' },
    { en: 'IARC Group 1 — known to cause colorectal cancer; risk rises with the amount eaten (about 18% per 50 g a day)', vi: 'IARC nhóm 1 — đã xác định gây ung thư đại trực tràng; nguy cơ tăng theo lượng ăn (khoảng 18% mỗi 50 g/ngày)' },
    PROCESSED_MEAT_WORDS, { not: NOT_REAL_MEAT, cats: PROCESSED_MEAT_CATS }),
  Cx('nitrite', 'moderate', 'food', { en: 'Nitrite / nitrate curing salt (E249–E252)', vi: 'Muối nitrit / nitrat (E249–E252)' },
    { en: 'IARC 2A — ingested nitrite/nitrate that forms nitrosamines in the body is a probable carcinogen', vi: 'IARC 2A — nitrit/nitrat ăn vào tạo nitrosamin trong cơ thể là chất có thể gây ung thư' },
    ['sodium nitrite', 'potassium nitrite', 'sodium nitrate', 'potassium nitrate'], { additives: NITRITE_CODES }),
  Cx('red_meat', 'moderate', 'food', { en: 'Red meat (beef, pork, lamb)', vi: 'Thịt đỏ (bò, heo, cừu)' },
    { en: 'IARC 2A — probably causes colorectal cancer; the amount eaten matters', vi: 'IARC 2A — có thể gây ung thư đại trực tràng; lượng ăn là quan trọng' },
    RED_MEAT_WORDS, { not: syn(NOT_RED_MEAT, NOT_REAL_MEAT) }),
  Cx('alcohol', 'strong', 'food', { en: 'Alcohol (alcoholic drink)', vi: 'Rượu bia (đồ uống có cồn)' },
    { en: 'IARC Group 1 — ethanol in alcoholic drinks causes several cancers; no safe level has been set', vi: 'IARC nhóm 1 — cồn trong đồ uống gây nhiều loại ung thư; chưa có mức an toàn' },
    ['alcohol', 'ethanol', 'ethyl alcohol', 'beer', 'wine', 'vodka', 'rum', 'whisky', 'whiskey', 'gin', 'brandy', 'liqueur', 'sake', 'cider', 'rượu', 'bia'],
    { not: ['alcohol-free', 'alcohol free', 'non-alcoholic', 'dealcoholised', 'dealcoholized', '0.0%', 'sugar alcohol', 'wine vinegar', 'ginger', 'ginseng'], beverageOnly: true,
      cats: ['en:alcoholic-beverages', 'en:beers', 'en:wines', 'en:spirits', 'en:liqueurs', 'en:ciders'] }),
  Cx('salted_fish', 'strong', 'food', { en: 'Chinese-style salted fish', vi: 'Cá muối kiểu Trung Hoa' },
    { en: 'IARC Group 1 — causes nasopharyngeal cancer', vi: 'IARC nhóm 1 — gây ung thư vòm họng' },
    ['chinese-style salted fish', 'salted fish', 'cá muối']),
  Cx('aspartame', 'mild', 'food', { en: 'Aspartame (E951)', vi: 'Aspartame (E951)' },
    { en: 'IARC 2B (2023, limited evidence); JECFA kept the acceptable daily intake (40 mg/kg) unchanged', vi: 'IARC 2B (2023, bằng chứng hạn chế); JECFA giữ nguyên mức ăn hằng ngày chấp nhận được (40 mg/kg)' },
    ['aspartame', 'aspartam'], { additives: ['e951', 'e962'] }),
  Cx('bha', 'mild', 'both', { en: 'BHA (butylated hydroxyanisole, E320)', vi: 'BHA (E320)' },
    { en: 'IARC 2B; "reasonably anticipated" human carcinogen (US NTP); on the Prop 65 list', vi: 'IARC 2B; NTP Mỹ xếp “có thể dự đoán” gây ung thư; có trong danh sách Prop 65' },
    ['butylated hydroxyanisole', 'bha'], { additives: ['e320'], not: ['bha (salicylic acid)', 'beta hydroxy acid'] }),
  Cx('bromate', 'mild', 'food', { en: 'Potassium bromate (bromated flour)', vi: 'Kali bromat (bột mì có bromat)' },
    { en: 'IARC 2B; on the Prop 65 list; banned in the EU, UK, Canada', vi: 'IARC 2B; trong danh sách Prop 65; bị cấm ở EU, Anh, Canada' },
    ['potassium bromate', 'bromated flour', 'bromated'], { additives: ['e924'] }),
  Cx('caramel_4mei', 'mild', 'food', { en: 'Caramel colour III/IV (E150c / E150d) — 4-MEI', vi: 'Màu caramel III/IV (E150c / E150d) — 4-MEI' },
    { en: 'made with ammonia, which leaves 4-methylimidazole (IARC 2B; Prop 65 list); plain caramel (E150a) does not', vi: 'làm bằng amoniac, để lại 4-methylimidazole (IARC 2B; danh sách Prop 65); caramel thường (E150a) thì không' },
    ['ammonia caramel', 'sulphite ammonia caramel', 'sulfite ammonia caramel', 'caramel color iii', 'caramel color iv', 'caramel colour iii', 'caramel colour iv', '4-methylimidazole', '4-mei'],
    { additives: ['e150c', 'e150d'] }),
  Cx('tio2', 'mild', 'food', { en: 'Titanium dioxide in food (E171)', vi: 'Titan dioxit trong thực phẩm (E171)' },
    { en: 'EFSA 2021: no longer considered safe as a food additive — DNA damage could not be ruled out (banned in the EU since 2022); IARC 2B is for breathing in the dust', vi: 'EFSA 2021: không còn được coi là an toàn làm phụ gia — không loại trừ được tổn thương ADN (EU cấm từ 2022); IARC 2B là khi hít bụi' },
    ['titanium dioxide'], { additives: ['e171'] }),
  Cx('acrylamide', 'moderate', 'food', { en: 'Acrylamide (may form during frying / baking)', vi: 'Acrylamide (có thể sinh ra khi chiên / nướng)' },
    { en: 'IARC 2A, Prop 65 — NOT an ingredient: forms in starchy foods cooked very hot (chips, fries); the amount varies', vi: 'IARC 2A, Prop 65 — KHÔNG phải thành phần: sinh ra khi tinh bột được nấu rất nóng (khoai chiên, snack); lượng thay đổi' },
    [], { cats: ['en:crisps', 'en:potato-crisps', 'en:chips', 'en:potato-chips', 'en:chips-and-fries', 'en:french-fries', 'en:fries', 'en:frozen-fried-potatoes'] }),
  Cx('citrus_red2', 'mild', 'food', { en: 'Citrus Red No. 2 (orange peel dye)', vi: 'Phẩm màu Citrus Red 2 (nhuộm vỏ cam)' },
    { en: 'IARC 2B', vi: 'IARC 2B' }, ['citrus red 2', 'citrus red no. 2', 'citrus red no 2']),
  Cx('safrole', 'mild', 'both', { en: 'Safrole / sassafras', vi: 'Safrole / xá xị (sassafras)' }, { en: 'IARC 2B; banned as a food flavour in the US and EU', vi: 'IARC 2B; bị cấm làm hương liệu ở Mỹ và EU' }, ['safrole', 'sassafras oil', 'sassafras']),
  Cx('methyleugenol', 'mild', 'both', { en: 'Methyleugenol', vi: 'Methyleugenol' }, { en: 'IARC 2B; restricted in EU fragrances (Annex III)', vi: 'IARC 2B; bị giới hạn trong hương liệu ở EU' }, ['methyleugenol', 'methyl eugenol']),
  // ---- household / personal care ----
  Cx('formaldehyde', 'strong', 'nonfood', { en: 'Formaldehyde', vi: 'Formaldehyde' },
    { en: 'IARC Group 1 and a known human carcinogen (US NTP) — mainly when breathed in; prohibited in EU cosmetics', vi: 'IARC nhóm 1, NTP Mỹ xác định gây ung thư — chủ yếu khi hít phải; bị cấm trong mỹ phẩm EU' },
    hz('formaldehyde').words),
  Cx('fa_releaser', 'strong', 'nonfood', { en: 'Formaldehyde-releasing preservative', vi: 'Chất bảo quản giải phóng formaldehyde' },
    { en: 'slowly releases formaldehyde (IARC Group 1); the EU requires a "releases formaldehyde" warning (EU 2022/1181) — the amount released is small', vi: 'giải phóng dần formaldehyde (IARC nhóm 1); EU bắt buộc cảnh báo (EU 2022/1181) — lượng giải phóng nhỏ' },
    hz('fa-releaser').words),
  Cx('coal_tar', 'strong', 'nonfood', { en: 'Coal tar', vi: 'Hắc ín than đá (coal tar)' },
    { en: 'IARC Group 1; prohibited in EU cosmetics; still in some US dandruff shampoos', vi: 'IARC nhóm 1; bị cấm trong mỹ phẩm EU; vẫn có trong vài dầu gội trị gàu ở Mỹ' }, ['coal tar', 'coal-tar', 'pix carbonis']),
  Cx('silica', 'strong', 'nonfood', { en: 'Crystalline silica / quartz (abrasive cleaners)', vi: 'Silica tinh thể / thạch anh (bột cọ rửa)' },
    { en: 'IARC Group 1 WHEN BREATHED IN as dust — avoid making dust; not a risk on the skin. ("Hydrated silica" in toothpaste is a different, amorphous form)', vi: 'IARC nhóm 1 KHI HÍT bụi — tránh tạo bụi; không nguy hiểm trên da. (“Hydrated silica” trong kem đánh răng là dạng khác)' },
    ['crystalline silica', 'silica crystalline', 'silica, crystalline', 'quartz', 'cristobalite']),
  Cx('benzene', 'strong', 'nonfood', { en: 'Benzene', vi: 'Benzen' }, { en: 'IARC Group 1 (leukaemia)', vi: 'IARC nhóm 1 (bệnh bạch cầu)' }, ['benzene'], { not: ['benzene sulfonate', 'benzene sulphonate', 'benzenesulfonate'] }),
  Cx('tce', 'strong', 'nonfood', { en: 'Trichloroethylene (solvent)', vi: 'Trichloroethylene (dung môi)' }, { en: 'IARC Group 1 (kidney cancer)', vi: 'IARC nhóm 1 (ung thư thận)' }, ['trichloroethylene', 'trichloroethene']),
  Cx('talc', 'moderate', 'nonfood', { en: 'Talc', vi: 'Bột talc' }, { en: 'IARC 2A (2024) — mainly from long-term genital use and breathing the powder', vi: 'IARC 2A (2024) — chủ yếu khi dùng lâu ở vùng kín và khi hít bột' }, ['talc', 'talcum', 'talcum powder']),
  Cx('perc', 'moderate', 'nonfood', { en: 'Tetrachloroethylene (perc, spot removers)', vi: 'Tetrachloroethylene (perc, tẩy vết bẩn)' }, { en: 'IARC 2A', vi: 'IARC 2A' }, ['tetrachloroethylene', 'perchloroethylene', 'tetrachloroethene']),
  Cx('dcm', 'moderate', 'nonfood', { en: 'Dichloromethane (methylene chloride, paint stripper)', vi: 'Dichloromethane (methylene chloride, tẩy sơn)' }, { en: 'IARC 2A', vi: 'IARC 2A' }, ['dichloromethane', 'methylene chloride']),
  Cx('glyphosate', 'moderate', 'nonfood', { en: 'Glyphosate (weed killer)', vi: 'Glyphosate (thuốc diệt cỏ)' }, { en: 'IARC 2A (2015); the US EPA and EFSA disagree — evidence is contested', vi: 'IARC 2A (2015); EPA Mỹ và EFSA không đồng ý — bằng chứng còn tranh cãi' }, ['glyphosate']),
  Cx('dioxane', 'mild', 'nonfood', { en: 'Ethoxylated ingredient (PEG / "-eth") — possible 1,4-dioxane traces', vi: 'Thành phần ethoxyl hoá (PEG / “-eth”) — có thể có vết 1,4-dioxane' },
    { en: '1,4-dioxane is IARC 2B; it is a manufacturing CONTAMINANT that can be left in "-eth"/PEG ingredients, not the ingredient itself', vi: '1,4-dioxane là IARC 2B; là TẠP CHẤT có thể còn sót trong thành phần “-eth”/PEG, không phải bản thân thành phần' },
    hz('ethoxylated').words, { re: hz('ethoxylated').re }),
  Cx('dea', 'mild', 'nonfood', { en: 'Diethanolamine / cocamide DEA', vi: 'Diethanolamine / cocamide DEA' }, { en: 'IARC 2B; cocamide DEA is on the Prop 65 list', vi: 'IARC 2B; cocamide DEA trong danh sách Prop 65' }, hz('dea').words, { re: hz('dea').re }),
  Cx('benzophenone', 'mild', 'nonfood', { en: 'Benzophenone', vi: 'Benzophenone' }, { en: 'IARC 2B; Prop 65 list. (Benzophenone-3 / oxybenzone is a different chemical and is not classified)', vi: 'IARC 2B; danh sách Prop 65. (Benzophenone-3 / oxybenzone là chất khác, chưa được xếp loại)' },
    ['benzophenone'], { not: ['benzophenone-', ...Array.from({ length: 12 }, (_, i) => `benzophenone ${i + 1}`)] }),
  Cx('naphthalene', 'mild', 'nonfood', { en: 'Naphthalene (mothballs)', vi: 'Naphthalene (băng phiến)' }, { en: 'IARC 2B', vi: 'IARC 2B' }, ['naphthalene']),
  Cx('pdcb', 'mild', 'nonfood', { en: 'p-Dichlorobenzene (mothballs, toilet blocks)', vi: 'p-Dichlorobenzene (băng phiến, viên toilet)' }, { en: 'IARC 2B', vi: 'IARC 2B' }, ['p-dichlorobenzene', 'para-dichlorobenzene', '1,4-dichlorobenzene', 'paradichlorobenzene']),
];
const CX_BY_ID = Object.fromEntries(CARCINOGENS.map((c) => [c.id, c]));
// returns null when there is no ingredient list (no score — never 100)
export function cancerCheck({ ingredients = [], ingredientsText = '', categories = [], additiveCodes = [], productType = 'food', beverage = false } = {}) {
  const hasList = !!String(ingredientsText || '').trim() || ingredients.length > 0;
  if (!hasList) return null;
  const isFood = productType === 'food';
  const texts = ingredients.length ? ingredients.map((i) => ({ via: i.text, t: norm(`${i.text} ${idWords(i.id)}`) })) : [{ via: '', t: norm(ingredientsText) }];
  const codes = new Set([...additiveCodes, ...texts.flatMap((x) => eNumbersInText(x.t))]);
  const found = new Map();
  const hit = (id, via) => { if (!found.has(id)) found.set(id, via); };
  for (const c of CARCINOGENS) {
    if (c.scope === 'food' && !isFood) continue;
    if (c.scope === 'nonfood' && isFood) continue;
    const cat = c.cats.find((k) => categories.includes(k));
    if (cat) { hit(c.id, cat.replace(/^en:/, '').replace(/-/g, ' ')); continue; }
    if (c.beverageOnly && !beverage) continue;
    for (const x of texts) {
      const w = (c.words.length && matchesAny(x.t, c.words, c.not)) || (c.re && c.re.test(stripPhrases(x.t, c.not)) ? 'match' : null);
      if (w) { hit(c.id, x.via || w); break; }
    }
    if (!found.has(c.id)) { const code = c.additives.find((k) => codes.has(k)); if (code) hit(c.id, code.toUpperCase()); }
  }
  if (isFood) {
    // nitrite/nitrate curing + meat = processed meat (IARC 1). Then the curing salt is the reason, not a second hit.
    const meat = texts.find((x) => matchesAny(x.t, MEAT_WORDS, NOT_REAL_MEAT)) || categories.some((k) => /^en:(meats|pork|beef|poultry|chicken|turkey)/.test(k));
    const cured = found.has('nitrite') || texts.some((x) => matchesAny(x.t, NITRITE_WORDS, ['nitrite-free', 'no nitrites', 'no added nitrites']));
    if (!found.has('processed_meat') && meat && cured) hit('processed_meat', found.get('nitrite') || 'nitrite / nitrate curing');
    if (found.has('processed_meat')) { found.delete('nitrite'); found.delete('red_meat'); }   // red meat is counted inside processed meat
  }
  const R = CANCER_SCORE_RULE;
  const items = [...found.entries()].map(([id, via]) => { const c = CX_BY_ID[id]; return { id, level: c.level, name: c.name, why: c.why, via, base: R.weights[c.level] }; })
    .sort((a, b) => b.base - a.base);
  let total = 0;
  items.forEach((it, k) => { it.penalty = Math.round(it.base * R.decay ** k * 10) / 10; total += it.penalty; });
  total = Math.round(total * 10) / 10;
  let score = Math.max(0, Math.round(100 - total));
  const capped = items.some((it) => it.level === 'strong') && score > R.strongCap;
  if (capped) score = R.strongCap;
  return { score, band: bandFor(score), capped, items, total };
}

// ---------------------------------------------------------------------------------------------
// Product picture + "Compare prices" (store search links). Nothing is fetched or sent anywhere: these are plain
// https links the user may tap. Name + brand for every store; the barcode where that store's search accepts a
// UPC (Walmart, Google Shopping) and the code is a US/Canada UPC (12 digits, or 13 starting with 0).
// ---------------------------------------------------------------------------------------------
// Pictures always come from the product database by barcode (front of pack first, then any picture) — never from
// the photo the user took of the label.
export const productThumb = (p) => (p && (p.image_front_small_url || p.image_front_url || p.image_front_thumb_url || p.image_small_url || p.image_url)) || '';
export const productPhoto = (p) => (p && (p.image_front_url || p.image_front_small_url || p.image_url || p.image_small_url)) || '';
// Extra picture sources for a barcode the databases have no picture for (our Cloudflare Worker; see web/js/config.js).
// Returns the URLs to ask, in order — none while the worker URL is not set.
export function extraImageSources(code, { workerUrl = '' } = {}) {
  const c = String(code || '').replace(/\D/g, '');
  if (!c || !workerUrl) return [];
  return [`${String(workerUrl).replace(/\/+$/, '')}/product?upc=${c}`];
}
export const workerProductUrl = (base, code) => extraImageSources(code, { workerUrl: base })[0] || '';
// Ask the worker ONLY when the databases left a gap: code in no database, or a product with no ingredient list / no picture.
export const needsWorker = (r) => !!r && (r.state === 'notfound' || (r.state === 'found' && (!pickIngredientText(r.product || {}).trim() || !productThumb(r.product))));
const MAKER_LABEL = { pg_smartlabel: 'P&G SmartLabel', pg: 'P&G SmartLabel', unilever_smartlabel: 'Unilever SmartLabel', reckitt_smartlabel: 'Reckitt SmartLabel' };
// what kind of product a worker-only answer is: retail category first, then the ingredient words, else household
export function workerDbOf(w, ingredientsText = '') {
  const cat = String((w && w.category) || '').toLowerCase();
  if (/\b(food|foods|beverages?|grocery|snacks?|candy|drinks?|coffee|tea)\b/.test(cat)) return 'food';
  if (/health|beauty|personal care|cosmetic|bath|hair|skin|oral care|deodorant|shav|baby/.test(cat)) return 'beauty';
  if (/household|clean|laundry|home|kitchen|dish/.test(cat)) return 'products';
  // no category: the maker's site and the product name decide before the ingredient words (a disinfectant spray
  // lists "fragrance" too). Reckitt's US SmartLabel pages are its household brands (Lysol, Finish, Air Wick...).
  const name = String((w && (w.title || (w.manufacturer && w.manufacturer.product_name))) || '').toLowerCase();
  if (/disinfect|clean|detergent|bleach|laundry|dish|wipes|air freshener|deodori[sz]er spray/.test(name)) return 'products';
  if (/reckitt/.test(String((w && w.manufacturer && w.manufacturer.source) || ''))) return 'products';
  const g = ingredientsText ? guessProductTypeFromText(ingredientsText) : 'food';
  return g === 'cosmetic' ? 'beauty' : 'products';
}
// Fill ONLY the gaps of a lookup result from the worker's /product answer:
//   ingredients: the manufacturer's own label list (SmartLabel, label order) first, else UPCitemdb's description text;
//   picture: the worker's first https image; name / brand: when the databases had none.
// A code no database has becomes a product when the worker knows it. Returns null when nothing was added.
export function mergeWorkerProduct(r, w, code) {
  if (!w || typeof w !== 'object') return null;
  const m = w.manufacturer;
  const mf = m && m.found && Array.isArray(m.ingredients) && m.ingredients.length ? m : null;
  const mfText = mf ? mf.ingredients.map((i) => String((i && (i.name || i)) || '').trim()).filter(Boolean).join(', ') : '';
  const upText = typeof w.ingredients === 'string' ? w.ingredients.trim() : '';
  const img = pickWorkerImage(w);
  const title = (typeof w.title === 'string' && w.title.trim()) || (mf && String(mf.product_name || '').replace(/^\s*smartlabel\s*[-–:]\s*/i, '').replace(/®/g, '').replace(/\b(\w+)\s+\1\b/gi, '$1').trim()) || '';
  const brand = typeof w.brand === 'string' ? w.brand.trim() : '';
  const found = r && r.state === 'found' && r.product;
  const p = found ? { ...r.product } : { code: String(code || '') };
  const used = [];
  if (!pickIngredientText(p).trim() && (mfText || upText)) {
    p.ingredients_text = mfText || upText;
    p.ingredients_source = mfText ? 'manufacturer' : 'upcitemdb';
    p.ingredients_source_name = mfText ? (MAKER_LABEL[mf.source] || 'SmartLabel') : 'UPCitemdb';
    used.push('ingredients');
  }
  if (!productThumb(p) && img) { p.image_front_url = img; p.image_source = 'upcitemdb'; used.push('image'); }
  if (!(p.product_name || p.product_name_en) && title) { p.product_name = title; p.name_source = 'upcitemdb'; used.push('name'); }
  if (!p.brands && brand) p.brands = brand;
  if (!used.length) return null;
  if (found) return { ...r, product: p, worker: used };
  if (!p.ingredients_text && !p.product_name) return null;
  p.worker_only = true;   // in no Open*Facts database: the page must not name one as the source
  return { state: 'found', code: String(code || ''), product: p, db: workerDbOf(w, p.ingredients_text || ''), worker: used, tried: (r && r.tried) || [String(code || '')] };
}
// The worker answers {images: [...], title, brand}: use the first https picture (never http / data: / anything else).
export const pickWorkerImage = (json) => ((json && Array.isArray(json.images) ? json.images : []).find((u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u))) || '';
export const STORES = [
  { id: 'walmart', name: 'Walmart', url: 'https://www.walmart.com/search?q=', upc: true },
  { id: 'target', name: 'Target', url: 'https://www.target.com/s?searchTerm=' },
  { id: 'amazon', name: 'Amazon', url: 'https://www.amazon.com/s?k=' },
  { id: 'kroger', name: 'Kroger', url: 'https://www.kroger.com/search?query=' },
  { id: 'costco', name: 'Costco', url: 'https://www.costco.com/CatalogSearch?dept=All&keyword=' },
  { id: 'heb', name: 'H-E-B', url: 'https://www.heb.com/search/?q=' },
  { id: 'google', name: 'Google Shopping', url: 'https://www.google.com/search?tbm=shop&q=', upc: true },
];
// RFC 3986 strict: also encode ! ' ( ) * (encodeURIComponent leaves them)
export const encodeQuery = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
export function storeQuery(name = '', brand = '') {
  const n = String(name || '').replace(/^📷\s*/u, '').replace(/\s+/g, ' ').trim();
  const b = String(brand || '').split(',')[0].replace(/\s+/g, ' ').trim();     // OFF "brands" can be "Nutella, Ferrero"
  const q = b && !n.toLowerCase().includes(b.toLowerCase()) ? `${b} ${n}` : n;
  return q.trim().slice(0, 120);
}
// -> [{ id, name, url, by: 'name' | 'barcode' }]; [] when there is nothing to search for
export function storeLinks({ name = '', brand = '', code = '' } = {}) {
  const q = storeQuery(name, brand);
  const digits = String(code || '').replace(/\D/g, '');
  const usUpc = digits.length === 12 || (digits.length === 13 && digits.startsWith('0')) ? digits.slice(-12) : '';
  if (!q && !digits) return [];
  return STORES.map((s) => {
    const byCode = (s.upc && usUpc) || (!q && digits);
    const term = byCode ? (s.upc && usUpc ? usUpc : digits) : q;
    return { id: s.id, name: s.name, url: s.url + encodeQuery(term), by: byCode ? 'barcode' : 'name' };
  });
}

// ---------------------------------------------------------------------------------------------
// Adapters: OFF product -> analyze() input; OCR text -> analyze() input
// ---------------------------------------------------------------------------------------------
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
export function nutrientsFromOff(nm = {}) {
  let kj = num(nm['energy-kj_100g']);
  if (kj == null && num(nm['energy-kcal_100g']) != null) kj = num(nm['energy-kcal_100g']) * 4.184;
  if (kj == null) kj = num(nm.energy_100g);
  let salt = num(nm.salt_100g);
  if (salt == null && num(nm.sodium_100g) != null) salt = num(nm.sodium_100g) * 2.5;
  let fvl = num(nm['fruits-vegetables-legumes-estimate-from-ingredients_100g']);
  if (fvl == null) fvl = num(nm['fruits-vegetables-legumes_100g']);
  const out = { energy_kj: kj, sugars: num(nm.sugars_100g), satfat: num(nm['saturated-fat_100g']), fat: num(nm.fat_100g), salt, fiber: num(nm.fiber_100g), protein: num(nm.proteins_100g), fvl, derived: [] };
  // Derived bounds, not guesses: sugars are part of carbohydrates, saturated fat is part of total fat.
  if (out.sugars == null && num(nm.carbohydrates_100g) === 0) { out.sugars = 0; out.derived.push('sugars'); }
  if (out.satfat == null && out.fat === 0) { out.satfat = 0; out.derived.push('satfat'); }
  return out;
}
export function pickIngredientText(p, lang = 'en') {
  return (lang === 'vi' && p.ingredients_text_vi) || p.ingredients_text_en || p.ingredients_text || p.ingredients_text_vi || '';
}
export function inputFromOff(p, db = 'food') {
  const ns23 = p.nutriscore && p.nutriscore['2023'] && p.nutriscore['2023'].data ? p.nutriscore['2023'].data : {};
  const flags = {};
  for (const k of ['is_beverage', 'is_cheese', 'is_fat_oil_nuts_seeds', 'is_red_meat_product', 'is_water']) if (ns23[k] != null) flags[k] = Number(ns23[k]);
  const text = pickIngredientText(p);
  // Use OFF's parsed tree only when it was parsed from the text we show (same language) — it carries English ids.
  const tree = offTree(p.ingredients);
  return {
    source: 'off', nutrients: nutrientsFromOff(p.nutriments), categories: p.categories_tags || [], offFlags: flags,
    nova: p.nova_group, ingredientTree: tree, ingredientsText: text, allergens: p.allergens_tags || [], traces: p.traces_tags || [],
    additiveTags: p.additives_tags || [], productType: productTypeOf(db, p.categories_tags || []),
  };
}

// ---- OCR (US Nutrition Facts panel + ingredient list) ----
// US labels ALWAYS print a unit after an amount. OCR's most common slip is reading the unit "g" as "9"
// ("3.5g" -> "3.59", "(40g)" -> "(409)", "125mg" -> "125m9"). A unitless amount ending in 9 on a gram row is
// therefore repaired to "<amount>g"; every repair is recorded so the page can say what was changed.
const GRAM_ROWS = /(total\s*fat|saturated\s*fat|sat\.?\s*fat|trans\s*fat|total\s*carbohydrates?|dietary\s*fib(?:er|re)|total\s*sugars?|protein)(\s*[:\-]?\s*)(\d+(?:\.\d+)?)(?![\d.]*\s*m?g\b)(?=\s|$)/gi;
function ocrNumbers(t, repairs = []) {
  let s = t.replace(/(\d)\s*[oO](?=\s*m?g\b)/g, '$10').replace(/\b[oO](?=\s*m?g\b)/g, '0').replace(/(\d),(\d)/g, '$1.$2');
  s = s.replace(/(\d)m9\b/gi, (m, d) => { repairs.push(m); return `${d}mg`; });
  s = s.replace(/\((\d+)9\)/g, (m, d) => { repairs.push(m); return `(${d}g)`; });
  s = s.replace(GRAM_ROWS, (m, name, sep, numStr) => {
    if (numStr.length > 1 && numStr.endsWith('9') && !numStr.endsWith('.9')) { repairs.push(m.trim()); return `${name}${sep}${numStr.slice(0, -1)}g`; }
    return m;
  });
  return s;
}
// FDA Daily Values (2020 label) — the printed %DV lets us double-check each amount that was read.
const DV = { fat: [/total\s*fat/, 78], satfat: [/sat(?:urated|\.)?\s*fat/, 20], sodium_mg: [/sodium/, 2300], fiber: [/dietary\s*fib/, 28], addedSugars: [/added\s*sugars/, 50] };
export function parseNutritionFacts(rawText) {
  const repairs = [];
  const t = ocrNumbers(String(rawText || ''), repairs).replace(/\r/g, '');
  const low = t.toLowerCase();
  const val = (re) => { const m = low.match(re); if (!m) return null; return m[1] === '<1' || m[1] === '< 1' ? 0.5 : Number(m[1]); };
  const out = {};
  const sm = low.match(/serving\s*size[\s\S]{0,60}?\(\s*(\d+(?:\.\d+)?)\s*(g|ml)\b/) || low.match(/serving\s*size[\s\S]{0,40}?(\d+(?:\.\d+)?)\s*(g|ml)\b/);
  out.serving = sm ? Number(sm[1]) : null;
  out.servingUnit = sm ? sm[2] : null;
  out.kcal = val(/calories(?!\s*from)\s*[:\-]?\s*(\d{1,4})\b/);
  out.fat = val(/total\s*fat\s*[:\-]?\s*(<\s?1|\d+(?:\.\d+)?)\s*g/);
  out.satfat = val(/sat(?:urated|\.)?\s*fat\s*[:\-]?\s*(<\s?1|\d+(?:\.\d+)?)\s*g/);
  const sod = low.match(/sodium\s*[:\-]?\s*(<\s?\d+|\d+(?:\.\d+)?)\s*(mg|g)\b/);
  out.sodium_mg = sod ? (Number(sod[1].replace(/<\s?/, '')) * (sod[2] === 'g' ? 1000 : 1)) : null;
  out.sugars = val(/total\s*sugars?\s*[:\-]?\s*(<\s?1|\d+(?:\.\d+)?)\s*g/) ?? val(/(?<!added\s)sugars\s*[:\-]?\s*(<\s?1|\d+(?:\.\d+)?)\s*g/);
  out.addedSugars = val(/includes\s*(<\s?1|\d+(?:\.\d+)?)\s*g\s*added\s*sugars/);
  out.fiber = val(/dietary\s*fib(?:er|re)\s*[:\-]?\s*(<\s?1|\d+(?:\.\d+)?)\s*g/);
  out.protein = val(/protein\s*[:\-]?\s*(<\s?1|\d+(?:\.\d+)?)\s*g/);
  const need = ['serving', 'kcal', 'satfat', 'sodium_mg', 'sugars'];
  out.missing = need.filter((k) => out[k] == null || !(out[k] >= 0));
  if (out.serving === 0) out.missing.push('serving');
  out.complete = out.missing.length === 0;
  out.repairs = repairs;
  // %DV cross-check: a read amount that disagrees with its own printed percentage is flagged, not trusted silently
  out.dvMismatch = [];
  for (const [k, [re, dv]] of Object.entries(DV)) {
    if (out[k] == null) continue;
    const line = low.split('\n').find((l) => re.test(l) && (k !== 'satfat' || !/trans/.test(l)) && (k !== 'fat' || !/sat/.test(l)));
    const pm = line && line.match(/(\d{1,3})\s*%/);
    if (!pm) continue;
    const printed = Number(pm[1]), expected = (out[k] / dv) * 100;
    if (Math.abs(expected - printed) > Math.max(2.5, printed * 0.2)) out.dvMismatch.push(k);
  }
  return out;
}
// per-serving label -> per-100g nutrients (done in CODE, never by a model)
export function per100FromServing(f) {
  if (!f.complete) return null;
  const k = 100 / f.serving;
  const r = (v) => (v == null ? null : Math.round(v * k * 1000) / 1000);
  return {
    energy_kj: Math.round(f.kcal * 4.184 * k * 10) / 10, sugars: r(f.sugars), satfat: r(f.satfat), fat: r(f.fat),
    salt: Math.round((f.sodium_mg / 1000) * 2.5 * k * 1000) / 1000, fiber: r(f.fiber), protein: r(f.protein), fvl: null,
  };
}
// "INGREDIENTS:" as OCR really reads it: "INGRED;ENTS:", "INGRED!ENTS:", "INGREDIEN1S:", "Ingredients" (no colon)
const ING_HEAD_RE = /\b(?:ingred\S{0,6}\s*[:;.]|ingred[il1!;|]?e?n[t1]?s?\b|thành phần\s*[:;.]?)\s*/i;
// The allergen statement "CONTAINS WHEAT AND SOY." / "CONTAINS: MILK" — but NOT the in-list
// "CONTAINS LESS THAN 2% OF:" (that line always has a % sign or "less than").
const CONTAINS_RE = /(?<!may\s)\bcontains\b(?![^\n]*%)(?!\s+l\S{0,4}s\s+than)\s*[:;]?\s*([^\n]+)/i;
// OCR turns a dagger footnote mark into ! ' " ’ ” ? (and swallows the comma after it):
// "BEEF EXTRACT" BLEF FAT! BLACK PEPPER! CITRIC ACID" -> "BEEF EXTRACT, BLEF FAT, BLACK PEPPER, CITRIC ACID"
function cleanOcrIngredients(s) {
  return s.replace(/([A-Za-z])[†‡!"'’”?]+\s*([,.;)\]])/g, '$1$2')
    .replace(/([A-Za-z])[†‡!"'’”?]+\s+(?=[(\[])/g, '$1 ')
    .replace(/([A-Za-z])[†‡!"'’”?]+\s+(?=[A-Z])/g, '$1, ')
    .replace(/\b([A-Z]{3,})t\b/g, '$1')                                // "ONIONt" (dagger read as a small t)
    .replace(/\s+/g, ' ').trim();
}
// OCR junk tokens ("ni", "J", "| } 0 |") are not ingredients: keep only items with a real word in them
const realWord = (s) => /[\p{L}]{3,}/u.test(s);
function pruneOcrTree(tree) {
  return tree.filter((i) => realWord(i.text) || i.children.length).map((i) => ({ ...i, children: pruneOcrTree(i.children) }));
}
export function extractLabelText(rawText) {
  const t = String(rawText || '').replace(/\r/g, '');
  const m = t.match(ING_HEAD_RE);
  let ingredients = '';
  if (m) {
    const rest = t.slice(m.index + m[0].length);
    const hard = rest.search(/(?<!may\s)\bcontains\s*[:;]|\n\s*contains\b(?![^\n]*%)(?!\s+l\S{0,4}s\s+than)|may\s+contain|manufactured|distributed|produced\s+(?:by|in)|nutrition\s+facts|allergen/i);
    // A blank line ends the list — unless OCR put it INSIDE the list: a bracket is still open
    // ("DRIED FLAKES [BOK CHOY, ... DEXTROSE)⏎⏎GREEN ONION, ...]") or the text before it ends with a comma.
    let stop = hard;
    const blankRe = /\n\s*\n/g;
    let b;
    while ((b = blankRe.exec(rest)) && (hard < 0 || b.index < hard)) {
      const before = rest.slice(0, b.index);
      const open = (before.match(/[([{]/g) || []).length - (before.match(/[)\]}]/g) || []).length;
      if (open > 0 || /,\s*$/.test(before)) continue;
      stop = b.index; break;
    }
    ingredients = (stop >= 0 ? rest.slice(0, stop) : rest)
      .replace(/-[ \t]*\n[ \t]*(?=(?:and|or|&)\b)/gi, '- ').replace(/-\n/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    ingredients = cleanOcrIngredients(ingredients);
  }
  const c = t.match(CONTAINS_RE);
  const mc = t.match(/may\s+contain[^:\n]*[:]?\s*([^\n]+)/i);
  return { ingredients, contains: c ? c[1].trim() : '', mayContain: mc ? mc[1].trim() : '', foundHeading: !!m };
}

// ---- OCR read quality: used to pick which way up the photo is (0/90/180/270) ----
// score = INGREDIENTS/Nutrition-Facts keyword (30) + mean word confidence / 2 (0-50) + label words recognised (0-40).
// A sideways or upside-down read is gibberish: low confidence and almost no real label words.
const LABEL_KEYWORD_RE = /ingred\S{0,6}|nutrition\s*facts|serving\s*size|thành phần/i;
let LABEL_VOCAB = null;
function labelVocab() {
  if (LABEL_VOCAB) return LABEL_VOCAB;
  const words = new Set(['ingredients', 'contains', 'less', 'than', 'and', 'nutrition', 'facts', 'serving', 'size', 'calories', 'total', 'fat',
    'sodium', 'sugars', 'protein', 'carbohydrate', 'fiber', 'daily', 'value', 'water', 'flour', 'oil', 'acid', 'extract', 'starch', 'powder',
    'natural', 'flavor', 'flavors', 'color', 'enriched', 'modified', 'dried', 'sauce', 'paste', 'protein', 'isolate', 'mixture', 'manufactured',
    'distributed', 'may', 'contain', 'per', 'container', 'amount', 'cholesterol', 'vitamin', 'calcium', 'iron', 'potassium', 'includes', 'added']);
  const addAll = (list) => { for (const w of list) for (const part of norm(w).split(/[^\p{L}]+/u)) if (part.length >= 3) words.add(part); };
  for (const e of ECZEMA) addAll(e.words);
  for (const r of ING_RULES) addAll(r.words);
  for (const a of ADDITIVES) addAll(a.names);
  LABEL_VOCAB = words;
  return words;
}
export function ocrReadScore(text, meanConfidence) {
  const t = String(text || '');
  const vocab = labelVocab();
  const tokens = norm(t).split(/[^\p{L}]+/u).filter((w) => w.length >= 3);
  let dict = 0;
  for (const w of tokens) if (vocab.has(w) || vocab.has(w.replace(/e?s$/, ''))) dict++;
  const keyword = LABEL_KEYWORD_RE.test(t);
  const conf = Math.max(0, Math.min(100, Number(meanConfidence) || 0));
  const score = Math.round((keyword ? 30 : 0) + conf / 2 + Math.min(40, dict));
  return { score, keyword, conf: Math.round(conf), dictWords: dict };
}
// Orientation search plan (the page does the pixel work; these are the rules):
// read a small copy at 0° first; if it is good enough stop, else try 90°, 270°, 180° and keep the best,
// then read the winner at full size. Sizes measured on the real sideways Nongshim photo (4000x3000):
// 1000px probe = clearly separates right/wrong way up; 2000px read = most correct words (159 vs 151 @1600, 156 @2500).
export const OCR_PLAN = { order: [0, 90, 270, 180], probePx: 1000, readPx: 2000, goodEnough: 75 };

// What kind of read did the photo give? Drives the message on the result page.
//   full             nutrition panel + ingredients
//   ingredients_only ingredient list, no Nutrition Facts panel (health score needs the barcode / a panel photo)
//   facts_only       panel but no ingredient list
//   unreadable       nothing usable was read
export function photoOutcome(facts, label) {
  const anyFact = ['kcal', 'fat', 'satfat', 'sodium_mg', 'sugars', 'protein', 'fiber'].some((k) => facts[k] != null);
  const hasIng = !!(label.ingredients && label.ingredients.trim()) || !!label.contains;
  if (hasIng && anyFact) return 'full';
  if (hasIng) return 'ingredients_only';
  if (anyFact) return 'facts_only';
  return 'unreadable';
}
export function inputFromOcr(rawText) {
  const facts = parseNutritionFacts(rawText);
  const label = extractLabelText(rawText);
  const per100 = per100FromServing(facts);
  const bev = facts.servingUnit === 'ml';
  const anyFact = ['kcal', 'satfat', 'sodium_mg', 'sugars'].some((k) => facts[k] != null);
  const productType = anyFact ? 'food' : guessProductTypeFromText(label.ingredients || rawText);
  return {
    input: {
      productType,
      source: 'photo', nutrients: per100 || {}, categories: bev ? ['en:beverages'] : [], offFlags: bev ? { is_beverage: 1 } : {},
      nova: null, ingredientTree: pruneOcrTree(parseIngredientsText(label.ingredients)), ingredientsText: label.ingredients, allergens: [], traces: [], additiveTags: [],
      containsText: label.contains, mayContainText: label.mayContain,
    },
    facts, label, per100, outcome: photoOutcome(facts, label),
  };
}
