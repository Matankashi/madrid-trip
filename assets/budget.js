import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

/* שמירת המחשבון. מקור האמת הוא Firestore, ב-/users/{uid}/state/budget,
   עם גיבוי אופליין ב-localStorage — אותו דפוס כמו dossier.js. שני
   הבדלים מכוונים מול dossier.js, שניהם כדי שעריכה ידנית לעולם לא
   תאבד:
   1. הטעינה הראשונית היא getDoc חד-פעמי ולא onSnapshot מתמשך. עם
      onSnapshot, הד (echo) של כתיבה קודמת עלול לחזור בדיוק כשהמשתמש
      באמצע הקלדה בשדה אחר ולדרוס אותה באמצע התו. במחשבון תקציב, בניגוד
      לצ'קליסט, יש הרבה הקלדה רציפה בשדות מספר — אז חד-פעמי בטוח יותר.
      המשמעות: אין סנכרון חי בין מכשירים פתוחים בו-זמנית לעמוד הזה,
      רק רענון עם כל טעינת דף.
   2. הכתיבה המבוזרת (debounce) קוראת את מצב ה-DOM מחדש ברגע שהיא
      *יורה*, לא ברגע שהיא *נקבעה* — כך שאם לוחצים על רמת תקציב ואז
      עורכים שדה בתוך חלון ה-800ms, הכתיבה שבסוף כוללת גם את העריכה.
   דגל userEdited חוסם את ה-getDoc מלדרוס עריכה שכבר בוצעה בזמן
   שהבקשה עוד באוויר (חלון קצר בטעינת העמוד). */

const FIELD_IDS = ['flight','airport','nightly','daily','barca','ucl','tour','metro','trip','tripCount','museums','misc'];
const CURRENCY_IDS = FIELD_IDS.filter(id => id !== 'tripCount');
const GLOBAL_IDS = ['days','nights'];
const STORE_KEY = 'madrid.budget.v1';
const DEBOUNCE_MS = 800;
const SYMS = {EUR:'€', USD:'$', ILS:'₪'};
/* שני שערי המרה, בכיוון €→X (כמו שדה השער הקיים תמיד עבד): הערך
   אומר "1 יורו שווה X דולר/שקל". המרת סכום בשורה שאינה יורו ליורו
   היא חלוקה בשער. rateValue() תמיד מחזירה מספר תקין (>0) — אם השדה
   ריק, לא-מספרי או אפס, נופלים לברירת המחדל, כדי שסכום לא יהפוך
   ל-NaN/Infinity ויתפשט לכל הסכומים.
   currencyOf() נופלת ל-EUR עבור כל שורה בלי בורר מטבע תקין (למשל
   מסמך ישן שנשמר לפני התכונה) — כך שגם מסמך Firestore ישן, בלי
   currencies בכלל, ממשיך לעבוד כאילו כל השורות ביורו. */

/* אייקוני מנעול כ-SVG מוטבע ולא אימוג'י — 🔒/🔓 נראים כמעט זהים בגודל
   קטן בהרבה פלטפורמות. ההבדל הוויזואלי כאן הוא מיקום ה"ידית": סגורה
   ומקיפה את שני צידי הגוף מול פתוחה ותלויה מצד אחד בלבד. */
const LOCK_ICON_CLOSED = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="1.5"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
const LOCK_ICON_OPEN = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="1.5"></rect><path d="M8 11V7a4 4 0 0 1 7.5-2"></path></svg>';

/* אלה נקודות ייחוס קבועות מהתכנון המקורי — לעולם לא נערכות, לא
   נדרסות, ולא נכתבות ל-Firestore בשום נתיב קוד. עריכה אמיתית קיימת
   רק בשכבת "מותאם אישית" (customValues/customCurrencies), וזו היחידה
   שנשמרת. אם מוסיפים דרך חדשה לשנות תקציב בעתיד — היא לא נוגעת כאן. */
const PRESETS = {
  lean:{flight:230,airport:12,nightly:58,daily:32,barca:140,ucl:45,tour:25,metro:35,trip:30,tripCount:2,museums:55,misc:120},
  mid: {flight:330,airport:12,nightly:95,daily:55,barca:250,ucl:70,tour:25,metro:55,trip:60,tripCount:2,museums:130,misc:200},
  rich:{flight:480,airport:70,nightly:165,daily:95,barca:420,ucl:120,tour:60,metro:130,trip:110,tripCount:2,museums:220,misc:350}
};
const TIER_LABELS = {lean:'חסכוני', mid:'מאוזן', rich:'נוח', custom:'מותאם אישית'};
/* PRESETS הם קבועי קוד בלבד — לעולם לא נקראים/נכתבים ל-Firestore.
   הנתונים ה"אמיתיים" של המשתמש חיים ב-customValues/customCurrencies
   (נשמרים תחת custom.values/custom.currencies), ו-tier קובע אם ה-DOM
   כרגע מציג שכבת מחיר (lean/mid/rich, קריאה בלבד מהקבועים) או custom
   (העריכה החיה). שורה נעולה מתעלמת לגמרי מהחלפת שכבה — תמיד מוצגת
   מ-customValues/currencies, ראו applyValuesForTier. */
let tier = 'mid';
let customValues = {};
let customCurrencies = {};
let showTierRefs = true; // מתג גלוי/מוסתר לשורת הייחוס בכל שורה, נשמר ל-Firestore
const GROUPS = [
  {key:'arrive', label:'הגעה',    color:'#0F1E38', items:['flight','airport']},
  {key:'stay',   label:'לינה',    color:'#C4262E', items:['nightly']},
  {key:'food',   label:'אוכל',    color:'#C9962C', items:['daily']},
  {key:'ball',   label:'כדורגל',  color:'#2F6F4E', items:['barca','ucl','tour']},
  {key:'metro',  label:'תחבורה',  color:'#5B6472', items:['metro']},
  {key:'trips',  label:'טיולי יום',color:'#8C3B4A',items:['trip']},
  {key:'museums',label:'מוזיאונים',color:'#3D6E8C',items:['museums']},
  {key:'misc',   label:'רזרבה',   color:'#A9A497', items:['misc']}
];
const toggles = {ucl:true, tour:false, trip:true};
/* locks: שורות שכבר שולמו וחויבו בפועל. מפתח = id, קיים רק לשורות
   נעולות (חסר = פתוחה, אותו דפוס כמו currencies/rates). כל ערך
   {amount, currency, rate, chargedOn} הוא תמונת מצב קפואה שנלכדת
   ברגע הנעילה: amount הוא הסכום המלא של השורה (כולל כפל לילות/ימים/
   מספר טיולים אם רלוונטי, לא מחיר ליחידה), rate הוא שער ההמרה בו
   השתמשו באותו רגע (1 אם המטבע כבר EUR), ו-chargedOn תאריך שהמשתמש
   יכול לערוך. lineValueNative/lineValueEur קוראות מכאן במקום מהשדות
   החיים כשיש נעילה — כך ששינוי שער או עריכת ימים/לילות אחרי הנעילה
   לא זז את הסכום הנעול אף לא אגורה. */
let locks = {};
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const num = el => { const v = parseFloat(el.value); return isNaN(v) || v < 0 ? 0 : v; };
const fmtMoney = (n, cur) => (SYMS[cur] || '€') + Math.round(n).toLocaleString('en-US');
const eur = n => fmtMoney(n, 'EUR');

const rateMeta = {usd: null, ils: null};

function currencyOf(id){
  const sel = document.querySelector(`[data-cur="${id}"]`);
  const v = sel && sel.value;
  return (v === 'USD' || v === 'ILS') ? v : 'EUR';
}

// tripCount אין לו נעילה משלו — הוא שייך לשורת trip.
function lockOwnerOf(id){
  return id === 'tripCount' ? 'trip' : id;
}

// מספר השכבה תמיד מוגדר ביורו. אם השורה כרגע לא ביורו, ממירים לפי
// השער החי הנוכחי כדי שהמספר המוצג יישאר אומדן סביר במטבע שהמשתמש
// בחר לשורה הזו — לא דורסים את בחירת המטבע שלו סתם כי לחצו על שכבה.
function presetAmountForRow(id, tierName){
  const eurAmount = PRESETS[tierName][id];
  if (!CURRENCY_IDS.includes(id)) return eurAmount; // tripCount - אין לו מטבע
  const cur = currencyOf(id);
  if (cur === 'EUR') return eurAmount;
  const rate = rateValue(cur === 'USD' ? 'usd' : 'ils');
  return Math.round(eurAmount * rate * 100) / 100;
}

function rateValue(key){
  const el = key === 'usd' ? $('#rateUsd') : $('#rateIls');
  const fallback = key === 'usd' ? 1.08 : 4.05;
  const v = el ? num(el) : 0;
  return v > 0 ? v : fallback;
}

function fmtDate(iso){
  if (!iso) return 'טרם עודכן';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return 'טרם עודכן';
  return 'עודכן ' + String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
}

function todayIso(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function setRowLocked(id, isLocked){
  const row = document.querySelector(`[data-item="${id}"]`);
  const amountInput = document.querySelector(`[data-in="${id}"]`);
  const curSelect = document.querySelector(`[data-cur="${id}"]`);
  const lockBtn = document.querySelector(`[data-lockbtn="${id}"]`);
  const dateWrap = document.querySelector(`[data-lockdatewrap="${id}"]`);
  const tripCountInput = id === 'trip' ? document.querySelector('[data-in="tripCount"]') : null;
  if (row) row.classList.toggle('locked', isLocked);
  if (amountInput) amountInput.disabled = isLocked;
  if (curSelect) curSelect.disabled = isLocked;
  if (tripCountInput) tripCountInput.disabled = isLocked;
  if (lockBtn) {
    lockBtn.setAttribute('aria-pressed', String(isLocked));
    lockBtn.innerHTML = isLocked ? LOCK_ICON_CLOSED : LOCK_ICON_OPEN;
  }
  if (dateWrap) dateWrap.hidden = !isLocked;
}

function lineValueNative(id){
  if(id in toggles && !toggles[id]) return 0;
  if(locks[id]) return Number(locks[id].amount) || 0;
  const inp = document.querySelector(`[data-in="${id}"]`);
  if(!inp) return 0;
  const v = num(inp);
  if(id === 'nightly') return v * num($('#nights'));
  if(id === 'daily')   return v * num($('#days'));
  if(id === 'trip')    return v * num(document.querySelector('[data-in="tripCount"]'));
  return v;
}

function lineValueEur(id){
  if(id in toggles && !toggles[id]) return 0;
  if(locks[id]){
    const rate = Number(locks[id].rate) || 1;
    return (Number(locks[id].amount) || 0) / rate;
  }
  const native = lineValueNative(id);
  const cur = currencyOf(id);
  if (cur === 'USD') return native / rateValue('usd');
  if (cur === 'ILS') return native / rateValue('ils');
  return native;
}

function render(){
  const totals = {};
  let grand = 0, paidEur = 0, projEur = 0;
  GROUPS.forEach(g => {
    let sum = 0;
    g.items.forEach(id => {
      const vEur = lineValueEur(id);
      const cell = document.querySelector(`[data-amt="${id}"]`);
      if(cell) cell.textContent = fmtMoney(lineValueNative(id), currencyOf(id));
      sum += vEur;
      if (locks[id]) paidEur += vEur; else projEur += vEur;
    });
    totals[g.key] = sum;
    grand += sum;
  });

  Object.keys(toggles).forEach(id => {
    const row = document.querySelector(`[data-item="${id}"]`);
    if(row) row.classList.toggle('off', !toggles[id]);
  });

  CURRENCY_IDS.forEach(id => {
    const row = document.querySelector(`[data-item="${id}"]`);
    if(row) row.classList.toggle('locked', !!locks[id]);
  });

  // שורת ייחוס לכל שורה: תמיד ביורו (זה המטבע שבו מוגדרים ה-PRESETS),
  // גם אם השורה עצמה בשקל/דולר — לא ממירים, זו נקודת ייחוס קבועה ולא
  // חישוב. תמיד ליחידה (מחיר ללילה/ליום/לטיול, לא מוכפל) כמו שהשדה
  // עצמו מציג. עובדת גם על שורה נעולה — הייחוס לא תלוי בכלל בנעילה.
  const showRefsNow = tier === 'custom' && showTierRefs;
  const refToggleWrap = $('#refToggleWrap');
  if (refToggleWrap) refToggleWrap.hidden = tier !== 'custom';
  CURRENCY_IDS.forEach(id => {
    const refEl = document.querySelector(`[data-tier-ref="${id}"]`);
    if (!refEl) return;
    if (showRefsNow) {
      refEl.hidden = false;
      refEl.textContent = 'ייחוס: ' + ['lean', 'mid', 'rich'].map(t => eur(PRESETS[t][id])).join(' · ');
    } else {
      refEl.hidden = true;
    }
  });

  const ilsRateForSplit = rateValue('ils');
  $('#paidEur').textContent = eur(paidEur);
  $('#projEur').textContent = eur(projEur);
  $('#paidIls').textContent = '₪' + Math.round(paidEur * ilsRateForSplit).toLocaleString('en-US');
  $('#projIls').textContent = '₪' + Math.round(projEur * ilsRateForSplit).toLocaleString('en-US');

  const days = Math.max(1, num($('#days')));
  const core = lineValueEur('nightly') + lineValueEur('daily');

  $('#totEur').textContent  = eur(grand);
  $('#footEur').textContent = eur(grand);
  $('#perDay').textContent  = eur(grand / days);
  $('#coreDay').textContent = eur(core / days);

  const r = rateValue('ils');
  const ils = '≈ ₪' + Math.round(grand * r).toLocaleString('en-US');
  $('#totIls').textContent  = ils;
  $('#footIls').textContent = ils;

  const usdDateEl = $('#rateUsdDate'), ilsDateEl = $('#rateIlsDate');
  if (usdDateEl) usdDateEl.textContent = fmtDate(rateMeta.usd);
  if (ilsDateEl) ilsDateEl.textContent = fmtDate(rateMeta.ils);

  $('#comp').innerHTML = '';
  $('#legend').innerHTML = '';
  GROUPS.forEach(g => {
    const pct = grand ? (totals[g.key] / grand) * 100 : 0;
    const seg = document.createElement('span');
    seg.style.width = pct + '%';
    seg.style.background = g.color;
    seg.title = g.label + ' ' + Math.round(pct) + '%';
    $('#comp').appendChild(seg);

    const pctEl = document.querySelector(`[data-pct="${g.key}"]`);
    if(pctEl) pctEl.textContent = eur(totals[g.key]) + ' · ' + Math.round(pct) + '%';

    if(pct >= 4){
      const li = document.createElement('span');
      li.innerHTML = `<i style="background:${g.color}"></i><em>${g.label}</em> ${Math.round(pct)}%`;
      $('#legend').appendChild(li);
    }
  });

  $$('[data-echo="nights"]').forEach(e => e.textContent = num($('#nights')));
  $$('[data-echo="days"]').forEach(e => e.textContent = num($('#days')));

  const compareEl = $('#tierCompare');
  if (compareEl) {
    if (tier === 'custom') {
      compareEl.hidden = false;
      compareEl.textContent = buildTierCompareText(grand);
    } else {
      compareEl.hidden = true;
    }
  }
}

/* סך "מה היה עולה הטיול הזה בשכבת מחיר X" — לא הסכום השמור של השכבה
   (אין כזה, PRESETS הם קבועים), אלא חישוב על-פי אותם ימים/לילות/
   toggles כמו הסכום האמיתי, כדי שההשוואה תהיה הוגנת: שורה שכובתה
   (toggle כבוי) לא נכנסת גם כאן, ושורה נעולה תורמת את הסכום הקפוא
   האמיתי שלה (זהה בכל שלוש השכבות) ולא את מחיר הייחוס של השכבה —
   אי אפשר "לתמחר מחדש" חיוב שכבר קרה. */
function presetTotalEur(tierName){
  const preset = PRESETS[tierName];
  let total = 0;
  CURRENCY_IDS.forEach(id => {
    if (id in toggles && !toggles[id]) return;
    if (locks[id]) { total += lineValueEur(id); return; }
    let amount = preset[id];
    if (id === 'nightly') amount *= num($('#nights'));
    if (id === 'daily')   amount *= num($('#days'));
    if (id === 'trip')    amount *= preset.tripCount;
    total += amount;
  });
  return total;
}

function buildTierCompareText(grand){
  const totals = ['lean','mid','rich'].map(t => ({t, label: TIER_LABELS[t], total: presetTotalEur(t)}));
  totals.sort((a, b) => a.total - b.total);
  const lo = totals[0], hi = totals[totals.length - 1];

  if (grand < lo.total) {
    return `${eur(grand)} — מתחת ל${lo.label} (${eur(lo.total)}), בפער של ${eur(lo.total - grand)}`;
  }
  if (grand > hi.total) {
    return `${eur(grand)} — מעל ${hi.label} (${eur(hi.total)}), בפער של ${eur(grand - hi.total)}`;
  }
  for (let i = 0; i < totals.length - 1; i++) {
    const a = totals[i], b = totals[i + 1];
    if (grand >= a.total && grand <= b.total) {
      const gapA = grand - a.total, gapB = b.total - grand;
      const nearer = gapA <= gapB ? a : b;
      const gap = Math.round(Math.min(gapA, gapB));
      if (gap === 0) return `${eur(grand)} — בדיוק כמו ${nearer.label} (${eur(nearer.total)})`;
      return `${eur(grand)} — בין ${b.label} (${eur(b.total)}) ל-${a.label} (${eur(a.total)}), קרוב יותר ל${nearer.label} ב-${eur(gap)}`;
    }
  }
  return eur(grand);
}

function renderTierButtons(){
  $$('.tier').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tier === tier)));
}

/* מציגה בכל שדה או את מחיר הייחוס של השכבה t (מומר למטבע שהמשתמש
   כבר בחר לשורה) או את custom — לפי t — אבל שורה נעולה תמיד מציגה
   את custom שלה, בלי קשר ל-t, כי החלפת שכבה לא נוגעת בשורות נעולות
   בכלל. days/nights הם גלובליים ולא חלק מאף שכבה, אז תמיד מ-custom. */
function applyValuesForTier(t){
  FIELD_IDS.forEach(id => {
    const el = document.querySelector(`[data-in="${id}"]`);
    if (!el) return;
    if (locks[lockOwnerOf(id)]) {
      el.value = customValues[id] !== undefined ? customValues[id] : defaults.values[id];
      return;
    }
    if (t === 'custom') {
      el.value = customValues[id] !== undefined ? customValues[id] : defaults.values[id];
    } else if (id in PRESETS[t]) {
      el.value = presetAmountForRow(id, t);
    }
  });
  GLOBAL_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = customValues[id] !== undefined ? customValues[id] : defaults.values[id];
  });
  CURRENCY_IDS.forEach(id => {
    const isLocked = !!locks[id];
    if (isLocked || t === 'custom') {
      const sel = document.querySelector(`[data-cur="${id}"]`);
      if (sel) sel.value = (customCurrencies[id] === 'USD' || customCurrencies[id] === 'ILS') ? customCurrencies[id] : 'EUR';
    }
    // t הוא שכבת מחיר ושורה פתוחה: לא נוגעים בבורר המטבע בכלל —
    // מחיר הייחוס כבר הומר למטבע הקיים ב-presetAmountForRow.
  });
}

function applyTier(target){
  if (target === tier) return;
  if (target !== 'custom' && tier === 'custom') {
    const ok = confirm(`החלפה ל"${TIER_LABELS[target]}" תחליף את הנתונים המותאמים אישית שלך בשורות הפתוחות (לא נעולות). להמשיך?`);
    if (!ok) return;
    FIELD_IDS.forEach(id => {
      if (locks[lockOwnerOf(id)]) return;
      customValues[id] = String(presetAmountForRow(id, target));
    });
  }
  tier = target;
  applyValuesForTier(tier);
  renderTierButtons();
  render();
  scheduleSave();
}

// ברירות המחדל שכבר ב-HTML, נלכדות לפני שכל נתון שמור נטען — הן
// רשת הביטחון כששדה קיים ב-DOM אבל חסר במסמך השמור (data-c חדש
// שנוסף אחרי שהמסמך נכתב בפעם האחרונה).
const defaults = {values: {}, toggles: Object.assign({}, toggles)};
FIELD_IDS.forEach(id => { const el = $(`[data-in="${id}"]`); if (el) defaults.values[id] = el.value; });
GLOBAL_IDS.forEach(id => { const el = $(`#${id}`); if (el) defaults.values[id] = el.value; });

/* מסנכרן את customValues/currencies מה-DOM: תמיד עבור שורה נעולה
   (היא לעולם מציגה custom, בלי קשר לשכבה), ועבור GLOBAL_IDS (ימים/
   לילות אינם שייכים לאף שכבה) — ומעבר לזה, רק כשtier==='custom',
   כי שכבת מחיר אין לה מה "לשמור" (היא קבועה בקוד). זה מה שמבטיח את
   כלל 5: רק custom נשמר, presets לא נכתבים ל-Firestore בכלל. */
function getState(){
  GLOBAL_IDS.forEach(id => { const el = $(`#${id}`); if (el) customValues[id] = el.value; });
  FIELD_IDS.forEach(id => {
    if (tier === 'custom' || locks[lockOwnerOf(id)]) {
      const el = $(`[data-in="${id}"]`);
      if (el) customValues[id] = el.value;
    }
  });
  CURRENCY_IDS.forEach(id => {
    if (tier === 'custom' || locks[id]) customCurrencies[id] = currencyOf(id);
  });
  const locksOut = {};
  Object.keys(locks).forEach(id => { locksOut[id] = Object.assign({}, locks[id]); });
  return {
    tier,
    showTierRefs,
    custom: {values: Object.assign({}, customValues), currencies: Object.assign({}, customCurrencies)},
    toggles: Object.assign({}, toggles), locks: locksOut,
    rates: {
      usd: {value: $('#rateUsd') ? $('#rateUsd').value : '1.08', updatedAt: rateMeta.usd},
      ils: {value: $('#rateIls') ? $('#rateIls').value : '4.05', updatedAt: rateMeta.ils}
    }
  };
}

function applyState(data){
  const savedToggles = (data && data.toggles) || {};
  const savedRates = (data && data.rates) || {};
  const legacyRate = data && data.values && data.values.rate; // גרסה ישנה מאוד: שדה שער יחיד תחת values

  if (data && data.custom) {
    customValues = Object.assign({}, data.custom.values);
    customCurrencies = Object.assign({}, data.custom.currencies);
    tier = ['lean', 'mid', 'rich', 'custom'].includes(data.tier) ? data.tier : 'custom';
  } else if (data && data.values) {
    // מסמך משכבר גרסה (v1.2–v1.4, לפני שכבות): values/currencies ברמה
    // עליונה הם בעצם המספרים המותאמים אישית — אין דרך לדעת אם הם
    // תואמים בטעות לשכבה כלשהי, אז ברירת המחדל הבטוחה היא custom.
    customValues = Object.assign({}, data.values);
    customCurrencies = Object.assign({}, data.currencies || {});
    tier = 'custom';
  } else {
    customValues = Object.assign({}, defaults.values);
    customCurrencies = {};
    tier = 'mid';
  }
  showTierRefs = (data && data.showTierRefs !== undefined) ? !!data.showTierRefs : true;
  const refToggleEl = $('#refToggle');
  if (refToggleEl) refToggleEl.checked = showTierRefs;

  const savedLocks = (data && data.locks) || {};
  locks = {};
  CURRENCY_IDS.forEach(id => {
    const saved = savedLocks[id];
    if (saved && saved.amount !== undefined) {
      locks[id] = {
        amount: saved.amount,
        currency: (saved.currency === 'USD' || saved.currency === 'ILS') ? saved.currency : 'EUR',
        rate: Number(saved.rate) || 1,
        chargedOn: saved.chargedOn || '' // חסר בביטחון — לא שובר את הטעינה, רק מוצג ריק
      };
      setRowLocked(id, true);
      const dateInput = document.querySelector(`[data-lockdate="${id}"]`);
      if (dateInput) dateInput.value = locks[id].chargedOn;
    } else {
      setRowLocked(id, false);
    }
  });

  applyValuesForTier(tier);
  renderTierButtons();

  // שער USD: אין ערך ישן להעביר — ברירת המחדל שכבר ב-HTML (1.08) עם תאריך לא ידוע.
  if (savedRates.usd && savedRates.usd.value !== undefined) {
    $('#rateUsd').value = savedRates.usd.value;
    rateMeta.usd = savedRates.usd.updatedAt || null;
  } else {
    rateMeta.usd = null;
  }
  // שער ILS: מסמך חדש -> savedRates.ils. מסמך ישן (לפני התכונה) -> legacyRate, בלי תאריך ידוע.
  if (savedRates.ils && savedRates.ils.value !== undefined) {
    $('#rateIls').value = savedRates.ils.value;
    rateMeta.ils = savedRates.ils.updatedAt || null;
  } else if (legacyRate !== undefined) {
    $('#rateIls').value = legacyRate;
    rateMeta.ils = null;
  } else {
    rateMeta.ils = null;
  }
  Object.keys(defaults.toggles).forEach(k => {
    toggles[k] = savedToggles[k] !== undefined ? !!savedToggles[k] : defaults.toggles[k];
    const btn = $(`[data-tog="${k}"]`);
    if (btn) btn.setAttribute('aria-pressed', String(toggles[k]));
  });
  render();
}

function loadLocal(){
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); }
  catch (e) { return null; }
}

function saveLocal(state){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { /* אחסון חסום — ממשיכים בלי שמירה מקומית */ }
}

let docRef = null;
let saveTimer = null;
let userEdited = false;

function scheduleSave(){
  userEdited = true;
  saveLocal(getState());
  if (!docRef) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    setDoc(docRef, getState()).catch(function(err){
      // עדיין נשמר ב-localStorage, אבל כשל שקט פה נראה בדיוק כמו הצלחה —
      // בלי הלוג הזה קשה להבחין בין "לא נכתב" ל"נכתב ולא הגיע".
      console.error('madrid-trip: budget setDoc failed', err);
    });
  }, DEBOUNCE_MS);
}

$$('.tier').forEach(b => b.addEventListener('click', () => applyTier(b.dataset.tier)));
const refToggleInput = $('#refToggle');
if (refToggleInput) refToggleInput.addEventListener('change', e => {
  showTierRefs = e.target.checked;
  render();
  scheduleSave();
});
$$('.tog').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.tog;
  toggles[k] = !toggles[k];
  b.setAttribute('aria-pressed', String(toggles[k]));
  render();
  scheduleSave();
}));
document.addEventListener('input', e => {
  if(e.target.id === 'rateUsd') rateMeta.usd = todayIso();
  if(e.target.id === 'rateIls') rateMeta.ils = todayIso();
  // עריכת שדה תקציב/ימים/לילות בזמן ששכבת מחיר פעילה עוברת אוטומטית
  // ל-custom, עם הערכים הנוכחיים (שכבה + העריכה הזו) כנקודת פתיחה —
  // ה-DOM כבר מכיל את הערך החדש ברגע שאירוע ה-input יורה, אז זה
  // בדיוק מה ש-getState/render יתפסו ברגע שtier=='custom'.
  if(e.target.matches('[data-in], #days, #nights') && tier !== 'custom'){
    tier = 'custom';
    renderTierButtons();
  }
  if(e.target.matches('input[type=number]')) { render(); scheduleSave(); }
  if(e.target.matches('[data-lockdate]')){
    const id = e.target.dataset.lockdate;
    if (locks[id]) { locks[id].chargedOn = e.target.value; render(); scheduleSave(); }
  }
});
document.addEventListener('change', e => {
  if(e.target.matches('select.cur')) {
    if (tier !== 'custom') { tier = 'custom'; renderTierButtons(); }
    render();
    scheduleSave();
  }
});
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-lockbtn]');
  if (!btn) return;
  const id = btn.dataset.lockbtn;
  if (locks[id]) {
    delete locks[id];
    setRowLocked(id, false);
  } else {
    const currency = currencyOf(id);
    const amount = lineValueNative(id);
    const rate = currency === 'EUR' ? 1 : rateValue(currency === 'USD' ? 'usd' : 'ils');
    const chargedOn = todayIso();
    locks[id] = {amount: String(amount), currency, rate, chargedOn};
    setRowLocked(id, true);
    const dateInput = document.querySelector(`[data-lockdate="${id}"]`);
    if (dateInput) dateInput.value = chargedOn;
  }
  render();
  scheduleSave();
});

function refreshRate(key){
  const btn = document.querySelector(`[data-refresh="${key}"]`);
  const errEl = document.getElementById(key === 'usd' ? 'rateUsdError' : 'rateIlsError');
  const inputEl = key === 'usd' ? $('#rateUsd') : $('#rateIls');
  if (errEl) errEl.hidden = true;
  if (btn) { btn.disabled = true; btn.textContent = '...מעדכן'; }
  fetch('https://open.er-api.com/v6/latest/EUR')
    .then(res => { if (!res.ok) throw new Error('http ' + res.status); return res.json(); })
    .then(data => {
      if (data.result !== 'success') throw new Error('api result: ' + data.result);
      const rate = key === 'usd' ? data.rates && data.rates.USD : data.rates && data.rates.ILS;
      if (!(rate > 0)) throw new Error('missing rate in response');
      inputEl.value = Math.round(rate * 10000) / 10000;
      rateMeta[key] = todayIso();
      render();
      scheduleSave();
    })
    .catch(err => {
      // השדה והתאריך נשארים כמו שהיו — כשל שקט כאן היה נראה כמו שער עדכני
      console.error('madrid-trip: rate refresh failed', key, err);
      if (errEl) { errEl.textContent = 'עדכון השער נכשל — נשאר השער האחרון שנשמר'; errEl.hidden = false; }
    })
    .finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = '↻ עדכן'; }
    });
}
$$('.refresh').forEach(b => b.addEventListener('click', () => refreshRate(b.dataset.refresh)));

render();

onAuthStateChanged(auth, function(user){
  if (!user) return; // assets/auth-guard.js כבר מטפל בהפניה להתחברות

  docRef = doc(db, 'users', user.uid, 'state', 'budget');

  getDoc(docRef).then(function(snap){
    if (userEdited) return; // המשתמש כבר התחיל לערוך לפני שהתשובה חזרה
    if (snap.exists()) {
      applyState(snap.data());
    } else {
      const local = loadLocal();
      if (local) applyState(local);
    }
  }).catch(function(err){
    console.error('madrid-trip: budget getDoc failed', err);
    if (userEdited) return;
    const local = loadLocal();
    if (local) applyState(local);
  });
});
