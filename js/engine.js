// Food Score engine — the ONE source of truth for scoring, additives, eczema triggers,
// ingredient ratings, barcode handling and OCR label parsing. Pure functions only (no DOM),
// so the very same file runs in the phone browser and in `node --test`.
//
// Every user-facing sentence is a {en, vi} pair; the page picks the language.

// ---------------------------------------------------------------------------------------------
// Open Food Facts
// ---------------------------------------------------------------------------------------------
export const OFF_FIELDS = ['code', 'product_name', 'product_name_en', 'product_name_vi', 'brands', 'quantity',
  'image_front_url', 'image_front_small_url', 'ingredients_text', 'ingredients_text_en', 'ingredients_text_vi',
  'ingredients', 'allergens_tags', 'traces_tags', 'additives_tags', 'nutriments', 'nova_group',
  'nutriscore_score', 'nutriscore_grade', 'nutriscore', 'categories_tags', 'lang'];

export function offUrl(code) {
  return `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS.join(',')}`;
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
function stripPhrases(text, phrases) {
  let t = text;
  for (const p of phrases || []) t = t.replace(new RegExp(esc(p), 'giu'), ' ');
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
const ECZ_BY_ID = Object.fromEntries(ECZEMA.map((e) => [e.id, e]));
const SEV_RANK = { high: 3, medium: 2, low: 1, none: 0 };
const LOWER = { high: 'medium', medium: 'low', low: 'low' };

function eczemaHitsInText(text, parentText = '') {
  const t = norm(text);
  const hits = [];
  for (const e of ECZEMA) {
    if (!e.words.length) continue;
    const w = matchesAny(t, e.words, e.not);
    if (w) hits.push(e.id);
  }
  for (const code of eNumbersInText(t)) {
    for (const e of ECZEMA) if (e.additives.includes(code) && !hits.includes(e.id)) hits.push(e.id);
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
const PREFIX_RE = /^(ingredients?|ingrédients?|thành phần|contains (?:2|two) ?% or less of|contains less than (?:2|two) ?% of|less than (?:2|two) ?% of|(?:and )?(?:2|two) ?% or less of)\s*[:.]?\s*/i;
function cleanToken(s) {
  return s.replace(/\s+/g, ' ').replace(PREFIX_RE, '').replace(PREFIX_RE, '')
    .replace(/^[\s*:;.,\-–]+|[\s*:;.,\-–]+$/g, '').replace(/^(and|et|và)\s+/i, '').trim();
}
// "Sugar, palm oil, HAZELNUTS 13%, emulsifiers: lecithins [SOY), vanillin. Gluten free."
export function parseIngredientsText(text) {
  const src = String(text || '').replace(/\r/g, '').replace(/-\n/g, '').replace(/\n/g, ' ').trim();
  if (!src) return [];
  // split into top-level tokens (commas/semicolons, or ". " sentence breaks) at bracket depth 0
  const parse = (s) => {
    const items = [];
    let depth = 0, cur = '', sub = '';
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
      if (')]}'.includes(ch)) { depth = Math.max(0, depth - 1); if (depth > 0) sub += ch; continue; }
      if (depth > 0) { sub += ch; continue; }
      const prev = s[i - 1] || '', next = s[i + 1] || '';
      if ((ch === ',' && !(/\d/.test(prev) && /\d/.test(next))) || ch === ';' || (ch === '.' && (next === ' ' || next === '') && !/\d/.test(prev) && !/\b(no|st|approx|incl)$/i.test(cur))) { push(); continue; }
      cur += ch;
    }
    push();
    return items;
  };
  return parse(src);
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
export function rateIngredientTree(tree, tagCodes = []) {
  const out = [];
  const walk = (items, depth, parentText) => {
    for (const it of items) {
      const health = rateIngredient(it.text, it.id, tagCodes);
      const ecz = eczemaHitsInText(`${it.text} ${idWords(it.id)}`, parentText);
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
export function eczemaCheck({ ingredients = [], hasIngredientText = false, allergens = [], traces = [], additiveCodes = [], containsText = '', mayContainText = '' }) {
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
  for (const id of eczemaHitsInText(containsText)) add(id, containsText);
  const tagIds = (tags) => ECZEMA.filter((e) => e.allergens.some((a) => (tags || []).includes(a))).map((e) => e.id);
  for (const id of tagIds(allergens)) {
    if (id === 'soy' && found.has('soylecithin') && !found.has('soy')) continue; // the allergen tag is explained by the lecithin
    add(id, 'allergen list');
  }
  for (const code of additiveCodes) for (const e of ECZEMA) if (e.additives.includes(code)) add(e.id, code.toUpperCase());
  for (const id of tagIds(traces)) if (!found.has(id)) add(id, 'may contain', true);
  for (const id of eczemaHitsInText(mayContainText)) if (!found.has(id)) add(id, 'may contain', true);

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

  return {
    score, partial, capped, missing, band: score == null ? null : bandFor(score),
    parts: {
      nutrition: { points: nutPoints == null ? null : Math.round(nutPoints * 10) / 10, max: 60, nutriscore: ns },
      additives: { points: addPoints, max: 30, list: additives },
      processing: { points: procPoints, max: 10, nova, estimated: novaEstimated },
    },
    reasons, eczema, ingredients, nutrients, category: isWater ? 'water' : cat,
  };
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
export function inputFromOff(p) {
  const ns23 = p.nutriscore && p.nutriscore['2023'] && p.nutriscore['2023'].data ? p.nutriscore['2023'].data : {};
  const flags = {};
  for (const k of ['is_beverage', 'is_cheese', 'is_fat_oil_nuts_seeds', 'is_red_meat_product', 'is_water']) if (ns23[k] != null) flags[k] = Number(ns23[k]);
  const text = pickIngredientText(p);
  // Use OFF's parsed tree only when it was parsed from the text we show (same language) — it carries English ids.
  const tree = offTree(p.ingredients);
  return {
    source: 'off', nutrients: nutrientsFromOff(p.nutriments), categories: p.categories_tags || [], offFlags: flags,
    nova: p.nova_group, ingredientTree: tree, ingredientsText: text, allergens: p.allergens_tags || [], traces: p.traces_tags || [],
    additiveTags: p.additives_tags || [],
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
export function extractLabelText(rawText) {
  const t = String(rawText || '').replace(/\r/g, '');
  const m = t.match(/ingred[il1]ents?\s*[:;.]?\s*/i);
  let ingredients = '';
  if (m) {
    const rest = t.slice(m.index + m[0].length);
    const stop = rest.search(/\n\s*\n|contains\s*[:;]|may\s+contain|manufactured|distributed|produced\s+(?:by|in)|nutrition\s+facts|allergen/i);
    ingredients = (stop >= 0 ? rest.slice(0, stop) : rest).replace(/-\n/g, '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const c = t.match(/(?<!may\s)contains\s*[:;]\s*([^\n]+)/i);
  const mc = t.match(/may\s+contain[^:\n]*[:]?\s*([^\n]+)/i);
  return { ingredients, contains: c ? c[1].trim() : '', mayContain: mc ? mc[1].trim() : '' };
}
export function inputFromOcr(rawText) {
  const facts = parseNutritionFacts(rawText);
  const label = extractLabelText(rawText);
  const per100 = per100FromServing(facts);
  const bev = facts.servingUnit === 'ml';
  return {
    input: {
      source: 'photo', nutrients: per100 || {}, categories: bev ? ['en:beverages'] : [], offFlags: bev ? { is_beverage: 1 } : {},
      nova: null, ingredientTree: [], ingredientsText: label.ingredients, allergens: [], traces: [], additiveTags: [],
      containsText: label.contains, mayContainText: label.mayContain,
    },
    facts, label, per100,
  };
}
