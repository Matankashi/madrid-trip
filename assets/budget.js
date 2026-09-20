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

const FIXED_FIELD_IDS = ['flight','airport','nightly','daily','barca','ucl','tour','metro','trip','tripCount','museums','shirt','scale','internet','misc'];
/* FIELD_IDS/CURRENCY_IDS = השורות הקבועות + שורות המשתמש (userRows).
   הן משתנות בזמן ריצה (refreshIds), אז אף קוד לא אמור לשמור עותק שלהן. */
let FIELD_IDS = FIXED_FIELD_IDS.slice();
let CURRENCY_IDS = FIELD_IDS.filter(id => id !== 'tripCount');
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
  lean:{flight:230,airport:12,nightly:58,daily:32,barca:140,ucl:45,tour:25,metro:35,trip:30,tripCount:2,museums:55,shirt:0,scale:0,internet:0,misc:120},
  mid: {flight:330,airport:12,nightly:95,daily:55,barca:250,ucl:70,tour:25,metro:55,trip:60,tripCount:2,museums:130,shirt:0,scale:0,internet:0,misc:200},
  rich:{flight:480,airport:70,nightly:165,daily:95,barca:420,ucl:120,tour:60,metro:130,trip:110,tripCount:2,museums:220,shirt:0,scale:0,internet:0,misc:350}
};
const TIER_LABELS = {lean:'חסכוני', mid:'מאוזן', rich:'נוח', custom:'מותאם אישית'};
/* שורה "בלי תכנון" = אין לה מחיר בשכבות המחיר: שורת משתמש (userRows —
   אין לה PRESETS בכלל), או שורה קבועה שכל שלושת ה-PRESETS שלה 0
   (shirt/scale/internet). התכנון המקורי לא תקצב אותה בנפרד — היא נספרת
   מול הרזרבה (misc), ולכן: (1) ההשוואה הכוללת נשארת הוגנת בלי שינוי —
   צד השכבות כבר כולל את הרזרבה המלאה; (2) שורת "כמה מהרזרבה נוצל"
   מסכמת misc + כל שורה כזו; (3) בשכבת מחיר היא מוסתרת לגמרי ולא נספרת,
   כדי שהסך יישאר בדיוק התכנון המקורי. אין לה שורת ייחוס עם שלושה
   מחירים — רק "נספר ברזרבה". */
const PLANLESS_FIXED_ROWS = FIXED_FIELD_IDS.filter(id => id !== 'tripCount' && ['lean', 'mid', 'rich'].every(t => PRESETS[t][id] === 0));
/* שורות שהמשתמש הוסיף: userRows[id] = {label, group, createdAt}. הערך,
   המטבע והנעילה שלהן נשמרים באותם מקומות של שורה קבועה (custom.values[id],
   custom.currencies[id], locks[id]), כך שכל לוגיקת הסכומים/נעילה עובדת בלי
   שינוי. ה-id תמיד מתחיל ב-u_, ולכן אף פעם לא מתנגש ב-id של PRESETS. */
/* תיאור וקישור לכל שורה (קבועה או משתמש): rowMeta[id] = {desc, url}.
   מפתח קיים רק לשורה שיש לה לפחות אחד מהם (חסר = אין), אותו דפוס כמו
   locks/currencies. url נשמר כפי שהוקלד, וההפיכה לקישור לחיץ (normalizeUrl)
   נעשית רק בזמן הצגה — כך שעריכה באמצע הקלדה לא מוחקת כלום, וערך לא תקין
   פשוט לא מוצג כקישור. ערכים של id שאין לו שורה כרגע נשמרים כמות שהם.
   metaEditing הוא מצב תצוגה בלבד (לא נשמר). */
let rowMeta = {};
let metaEditing = false;
const DESC_MAX = 200;
const URL_MAX = 2000;
let userRows = {};
const isUserRow = id => Object.prototype.hasOwnProperty.call(userRows, id);
const isReserveRow = id => isUserRow(id) || PLANLESS_FIXED_ROWS.includes(id);
const userRowIds = () => Object.keys(userRows).sort((x, y) => (userRows[x].createdAt || 0) - (userRows[y].createdAt || 0) || (x < y ? -1 : 1));
function refreshIds(){
  FIELD_IDS = FIXED_FIELD_IDS.concat(userRowIds());
  CURRENCY_IDS = FIELD_IDS.filter(id => id !== 'tripCount');
}
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
  {key:'metro',  label:'תחבורה ותקשורת',color:'#5B6472', items:['metro','internet']},
  {key:'trips',  label:'טיולים ואטרקציות',color:'#8C3B4A',items:['trip','museums']},
  {key:'pre',    label:'ציוד לפני הטיול',color:'#7A5C99',items:['shirt','scale']},
  {key:'misc',   label:'רזרבה',   color:'#A9A497', items:['misc']}
];
const groupItems = g => g.items.concat(userRowIds().filter(id => userRows[id].group === g.key));
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
/* תאימות קדימה. הכתיבה היא setDoc על המסמך כולו, כך שכל מה שהגרסה
   הזו לא מכירה ולא כותבת בחזרה נמחק בשמירה הבאה — וטאב פתוח עם גרסה
   ישנה יכול לעשות את זה בשקט למסמך שגרסה חדשה יותר כתבה. לכן שלושה
   סוגי נתונים לא מוכרים נשמרים כפי שנטענו ומוחזרים כמות שהם ב-getState:
   שדות ברמה העליונה, מפתחות לא מוכרים תחת custom, ונעילות של id שאין
   לגרסה הזו שורה בשבילו (נעילה היא תיעוד של כסף שהוצא בפועל). ערכים
   ומטבעות של id לא מוכר כבר שורדים לבד, כי customValues/customCurrencies
   מועתקים במלואם. שדות מוכרים תמיד גוברים על הלא-מוכרים. */
const KNOWN_TOP_FIELDS = ['tier','showTierRefs','custom','toggles','locks','rates','values','currencies','userRows','rowMeta'];
let foreignTop = {};
let foreignCustom = {};
let foreignLocks = {};
const cloneJson = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
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

/* נעילה קיימת רק בשכבת custom — בשכבת מחיר קבועה (lean/mid/rich)
   היא כאילו לא קיימת בכלל: לא בערך המוצג, לא בחישוב, לא בכפתור עצמו. */
function isLockActive(id){
  return !!locks[id] && tier === 'custom';
}

function lineValueNative(id){
  if(id in toggles && !toggles[id]) return 0;
  if(tier !== 'custom' && isReserveRow(id)) return 0; // מוסתרת בשכבת מחיר
  if(isLockActive(id)) return Number(locks[id].amount) || 0;
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
  if(isLockActive(id)){
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
    groupItems(g).forEach(id => {
      const vEur = lineValueEur(id);
      const cell = document.querySelector(`[data-amt="${id}"]`);
      if(cell) cell.textContent = fmtMoney(lineValueNative(id), currencyOf(id));
      sum += vEur;
      if (isLockActive(id)) paidEur += vEur; else projEur += vEur;
    });
    totals[g.key] = sum;
    grand += sum;
  });

  Object.keys(toggles).forEach(id => {
    const row = document.querySelector(`[data-item="${id}"]`);
    if(row) row.classList.toggle('off', !toggles[id]);
  });

  // מצב הנעילה מוצג/מיושם רק ב-custom: כפתור המנעול עצמו זמין רק שם
  // (הוא חסר משמעות בשכבת מחיר קבועה), והשדות נחסמים רק כשהנעילה
  // בפועל פעילה (isLockActive) — לא סתם כי locks[id] קיים.
  // בשכבת מחיר כל השדות לקריאה בלבד (ימים/לילות כלולים — הם נשמרים ב-
  // custom.values): שכבת מחיר היא תצוגה של התכנון המקורי, לא משטח עריכה.
  const readOnly = tier !== 'custom';
  GLOBAL_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = readOnly; });
  CURRENCY_IDS.forEach(id => {
    const active = isLockActive(id);
    const row = document.querySelector(`[data-item="${id}"]`);
    if (row) row.classList.toggle('locked', active);
    const amountInput = document.querySelector(`[data-in="${id}"]`);
    const curSelect = document.querySelector(`[data-cur="${id}"]`);
    const lockBtn = document.querySelector(`[data-lockbtn="${id}"]`);
    const dateWrap = document.querySelector(`[data-lockdatewrap="${id}"]`);
    const tripCountInput = id === 'trip' ? document.querySelector('[data-in="tripCount"]') : null;
    if (amountInput) amountInput.disabled = active || readOnly;
    if (curSelect) curSelect.disabled = active || readOnly;
    if (tripCountInput) tripCountInput.disabled = active || readOnly;
    if (lockBtn) {
      lockBtn.hidden = tier !== 'custom';
      lockBtn.setAttribute('aria-pressed', String(!!locks[id]));
      lockBtn.innerHTML = locks[id] ? LOCK_ICON_CLOSED : LOCK_ICON_OPEN;
    }
    if (dateWrap) dateWrap.hidden = !active;
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
      refEl.textContent = isReserveRow(id)
        ? 'ייחוס: נספר ברזרבה'
        : 'ייחוס: ' + ['lean', 'mid', 'rich'].map(t => eur(PRESETS[t][id])).join(' · ');
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

  // שכבת מחיר מציגה רק את התכנון המקורי: שורה בלי תכנון (isReserveRow)
  // מוסתרת לגמרי, וקבוצה שכל שורותיה מוסתרות מוסתרת איתן. כפתורי הוספה
  // ומחיקה קיימים רק ב-custom; מחיקה חסומה כל עוד השורה נעולה.
  GROUPS.forEach(g => {
    let anyVisible = false;
    groupItems(g).forEach(id => {
      const hide = readOnly && isReserveRow(id);
      const row = document.querySelector(`[data-item="${id}"]`);
      if (row) row.style.display = hide ? 'none' : '';
      if (!hide) anyVisible = true;
    });
    const pctEl = document.querySelector(`[data-pct="${g.key}"]`);
    const h2 = pctEl && pctEl.closest('h2');
    const rowsEl = h2 && h2.nextElementSibling;
    const hideGroup = readOnly && !anyVisible;
    if (h2) h2.style.display = hideGroup ? 'none' : '';
    if (rowsEl) rowsEl.style.display = hideGroup ? 'none' : '';
    const addWrap = document.querySelector(`[data-addwrap="${g.key}"]`);
    if (addWrap) addWrap.style.display = readOnly ? 'none' : '';
  });
  userRowIds().forEach(id => {
    const delBtn = document.querySelector(`[data-delbtn="${id}"]`);
    if (!delBtn) return;
    delBtn.disabled = !!locks[id];
    delBtn.title = locks[id] ? 'בטל את הנעילה כדי למחוק' : '';
    const delWrap = document.querySelector(`[data-delwrap="${id}"]`);
    if (delWrap) delWrap.style.display = readOnly ? 'none' : '';
  });

  // תיאור וקישור: תצוגה בכל שכבה (אלה פרטי ההוצאה, לא חלק מהתכנון), עריכה
  // רק ב-custom ורק כשמתג העריכה דלוק — אחרת שורה בלי פרטים לא מציגה כלום.
  const metaEditingNow = tier === 'custom' && metaEditing;
  const metaToggleWrap = $('#metaToggleWrap');
  if (metaToggleWrap) metaToggleWrap.hidden = tier !== 'custom';
  CURRENCY_IDS.forEach(id => {
    const m = rowMeta[id] || {};
    const desc = (m.desc || '').trim();
    const href = normalizeUrl(m.url);
    const dEl = document.querySelector(`[data-desc-view="${id}"]`);
    if (dEl) { dEl.textContent = desc; dEl.hidden = !desc; }
    const lEl = document.querySelector(`[data-link-view="${id}"]`);
    if (lEl) {
      lEl.hidden = !href;
      if (href) {
        const label = linkLabel(href);
        lEl.href = href;
        lEl.querySelector('.rowlink-host').textContent = label;
        lEl.setAttribute('aria-label', 'פתח קישור: ' + label);
      } else {
        lEl.removeAttribute('href');
      }
    }
    const ed = document.querySelector(`[data-meta-edit="${id}"]`);
    if (ed) ed.hidden = !metaEditingNow;
    const err = document.querySelector(`[data-link-err="${id}"]`);
    const linkIn = document.querySelector(`[data-link-in="${id}"]`);
    const bad = metaEditingNow && !!(m.url || '').trim() && !href;
    if (err) err.hidden = !bad;
    if (linkIn) linkIn.classList.toggle('invalid', bad);
  });

  // כמה מהרזרבה נוצל: misc + כל השורות שנספרות מולה, מול הרזרבה בכל שכבה.
  const reserveEl = $('#reserveLine');
  if (reserveEl) {
    if (tier === 'custom') {
      const used = lineValueEur('misc') + CURRENCY_IDS.filter(isReserveRow).reduce((sum, id) => sum + lineValueEur(id), 0);
      reserveEl.hidden = false;
      reserveEl.textContent = 'רזרבה: ' + eur(used) + ' מתוך ' + ['lean', 'mid', 'rich'].map(t => eur(PRESETS[t].misc)).join(' · ');
    } else {
      reserveEl.hidden = true;
    }
  }
}

/* סך "התוכנית המקורית בשכבת מחיר X" — טהור מ-PRESETS בלבד, בלי שום
   דבר שדולף מ-custom או מנעילות. שורה נעולה תורמת כאן את מחיר הייחוס
   של השכבה, בדיוק כמו שורה פתוחה — לא את הסכום ששולם בפועל. זו כל
   הנקודה בלהיות "נקודת ייחוס": התוכנית המקורית, ללא שינוי, בלי קשר
   למה שקרה בפועל מאז. רק ימים/לילות/toggles חוצים משני הצדדים, כי הם
   מגדירים את *צורת* הטיול (כמה לילות, אילו קטגוריות בכלל רלוונטיות)
   ולא את המחיר בפועל של אף שורה. */
function presetTotalEur(tierName){
  const preset = PRESETS[tierName];
  let total = 0;
  // רק מפתחות ה-PRESETS עצמם: לשורת משתמש אין preset[id], ואיטרציה על
  // CURRENCY_IDS הייתה מחזירה NaN לכל ההשוואה.
  Object.keys(preset).forEach(id => {
    if (id === 'tripCount') return;
    if (id in toggles && !toggles[id]) return;
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

/* מציגה בכל שדה את מחיר הייחוס של השכבה t (מומר למטבע שהמשתמש כבר
   בחר לשורה) כש-t היא שכבת מחיר קבועה, או את custom כש-t==='custom'
   — בלי יוצא מן הכלל. נעילה קיימת רק ב-custom (ראו isLockActive),
   אז שורה נעולה מוצגת בשכבת מחיר בדיוק כמו שורה פתוחה: מחיר הייחוס
   שלה, לא הסכום ששולם בפועל. days/nights הם גלובליים ולא חלק מאף
   שכבה, אז תמיד מ-custom. */
function applyValuesForTier(t){
  // בורר המטבע של כל שורה תמיד מ-customCurrencies, גם בשכבת מחיר: זו
  // בחירת המשתמש (ראו presetAmountForRow), והיא חייבת להיקבע *לפני* הערכים
  // כדי שמחיר הייחוס יומר למטבע האמיתי — אחרת אחרי טעינה בשכבת מחיר
  // כל הבוררים מראים EUR (ברירת המחדל של ה-HTML).
  CURRENCY_IDS.forEach(id => {
    const sel = document.querySelector(`[data-cur="${id}"]`);
    if (sel) sel.value = (customCurrencies[id] === 'USD' || customCurrencies[id] === 'ILS') ? customCurrencies[id] : 'EUR';
  });
  FIELD_IDS.forEach(id => {
    const el = document.querySelector(`[data-in="${id}"]`);
    if (!el) return;
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
}

function applyTier(target){
  // שכבת מחיר היא תצוגה לקריאה בלבד של התכנון המקורי — מעבר אליה (וממנה)
  // אף פעם לא נוגע ב-customValues/customCurrencies/locks. רק עריכה של
  // שדה בזמן ש-tier==='custom' כותבת ל-custom.
  if (target === tier) return;
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

/* ---- תיאור וקישור ---- */
/* רק http/https הופכים לקישור: javascript:/data: וכל סכמה אחרת לא מוצגים
   בכלל. בלי סכמה ("booking.com/x") מוסיפים https://. ערך שלא מתפרש
   כ-URL הוא קלט משתמש צפוי (לא כשל) — הוא מסומן כלא-תקין בעורך במקום
   להיזרק ללוג בכל הקשה. */
function normalizeUrl(raw){
  const t = String(raw || '').trim();
  // רווח בתוך הטקסט = טקסט חופשי, לא קישור. בלעדיו new URL("https://not a url")
  // "מצליח" (רווחים הופכים ל-%20 בתוך שם ה-host) ומציג קישור לאתר מזויף.
  if (!t || /\s/.test(t)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : 'https://' + t;
  try {
    const u = new URL(withScheme);
    const hostOk = u.hostname.includes('.') || u.hostname === 'localhost' || u.hostname.startsWith('[');
    return (u.protocol === 'http:' || u.protocol === 'https:') && hostOk ? u.href : null;
  } catch (e) {
    return null;
  }
}
const linkLabel = href => { try { return new URL(href).hostname.replace(/^www\./, ''); } catch (e) { return 'קישור'; } };

function ensureMetaEl(row, id){
  const txt = row.querySelector('.txt');
  if (!txt || txt.querySelector('[data-meta]')) return;
  const box = document.createElement('div');
  box.className = 'rowmeta';
  box.dataset.meta = id;
  box.innerHTML =
    `<div class="rowdesc" data-desc-view="${id}" hidden></div>` +
    `<a class="rowlink" data-link-view="${id}" target="_blank" rel="noopener noreferrer" hidden><span class="rowlink-host"></span><span aria-hidden="true">&nbsp;↗</span></a>` +
    `<div class="metaedit" data-meta-edit="${id}" hidden>` +
      `<input type="text" class="descin" data-desc-in="${id}" maxlength="${DESC_MAX}" placeholder="תיאור (שורה אחת)" aria-label="תיאור">` +
      `<input type="url" class="linkin" data-link-in="${id}" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" dir="ltr" placeholder="קישור (https://…)" aria-label="קישור">` +
      `<div class="linkerr" data-link-err="${id}" hidden>הקישור לא תקין — הוא לא יוצג כקישור</div>` +
    `</div>`;
  txt.insertBefore(box, txt.querySelector('.tier-ref'));
}

function loadRowMeta(saved){
  rowMeta = {};
  if (saved && typeof saved === 'object') {
    Object.keys(saved).forEach(id => {
      const m = saved[id];
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        console.error('madrid-trip: skipped invalid rowMeta entry', id, m);
        return;
      }
      const e = cloneJson(m);
      if (typeof e.desc !== 'string') delete e.desc;
      if (typeof e.url !== 'string') delete e.url;
      rowMeta[id] = e;
    });
  }
}

function syncMetaInputs(){
  CURRENCY_IDS.forEach(id => {
    const m = rowMeta[id] || {};
    const d = document.querySelector(`[data-desc-in="${id}"]`);
    const u = document.querySelector(`[data-link-in="${id}"]`);
    if (d) d.value = m.desc || '';
    if (u) u.value = m.url || '';
  });
}

function setRowMetaField(id, field, value){
  if (tier !== 'custom' || !CURRENCY_IDS.includes(id)) return;
  const v = String(value).trim().slice(0, field === 'url' ? URL_MAX : DESC_MAX);
  const entry = Object.assign({}, rowMeta[id]);
  if (v) entry[field] = v; else delete entry[field];
  if (Object.keys(entry).length) rowMeta[id] = entry; else delete rowMeta[id];
  render();
  scheduleSave();
}

/* ---- שורות משתמש ---- */
const GROUP_KEYS = GROUPS.map(g => g.key);
const CUR_OPTIONS = '<option value="EUR">€</option><option value="USD">$</option><option value="ILS">₪</option>';

function buildUserRowEl(id){
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.item = id;
  row.dataset.userRow = '1';
  // ה-id נוצר בקוד (u_ + תווים לטיניים), אז שילוב שלו ב-HTML בטוח; התווית
  // שהמשתמש הקליד נכנסת רק דרך textContent.
  row.innerHTML =
    `<button class="lockbtn" data-lockbtn="${id}" aria-pressed="false" aria-label="נעילת תשלום" type="button">${LOCK_ICON_OPEN}</button>` +
    `<div class="txt"><div class="name"></div>` +
    `<div class="tier-ref" data-tier-ref="${id}" hidden></div>` +
    `<div class="lockdate-wrap" data-lockdatewrap="${id}" hidden><label>תאריך חיוב</label><input type="date" data-lockdate="${id}" lang="he-IL"></div>` +
    `<div class="delrow-wrap" data-delwrap="${id}">` +
      `<button class="renbtn" data-renbtn="${id}" type="button">שנה שם</button>` +
      `<form class="renform" data-renform="${id}" hidden>` +
        `<input type="text" maxlength="60" data-ren-in="${id}" aria-label="שם השורה">` +
        `<button class="addok" type="submit">שמור</button>` +
        `<button class="addcancel" data-rencancel="${id}" type="button">ביטול</button>` +
      `</form>` +
      `<button class="delbtn" data-delbtn="${id}" type="button">מחק שורה</button>` +
      `<span class="delconfirm" data-delconfirm="${id}" hidden>למחוק? <button class="delyes" data-delyes="${id}" type="button">כן</button> <button class="delno" data-delno="${id}" type="button">לא</button></span>` +
    `</div></div>` +
    `<select class="cur" data-cur="${id}" aria-label="מטבע">${CUR_OPTIONS}</select>` +
    `<input type="number" data-in="${id}" value="" min="0">` +
    `<div class="amt" data-amt="${id}"></div>`;
  row.querySelector('.name').textContent = userRows[id].label;
  ensureMetaEl(row, id);
  return row;
}

function groupRowsEl(key){
  const pctEl = document.querySelector(`[data-pct="${key}"]`);
  const h2 = pctEl && pctEl.closest('h2');
  return h2 && h2.nextElementSibling;
}

function insertUserRowEl(id){
  const rowsEl = groupRowsEl(userRows[id].group);
  if (!rowsEl) return;
  rowsEl.insertBefore(buildUserRowEl(id), rowsEl.querySelector('[data-addwrap]'));
}

/* טוען userRows ממסמך שמור. פריט פגום (בלי תווית / id לא תקין) לא נטען
   וכן נרשם בקונסולה — שלא ייעלם בשקט. group לא מוכר נופל ל-misc. ה-
   entry נשמר כפי שהוא ומעליו רק label/group/createdAt מנוקים, כדי ששדות
   עתידיים (תיאור/קישור) לא יימחקו בשמירה. */
function loadUserRows(saved){
  $$('[data-user-row]').forEach(el => el.remove());
  userRows = {};
  if (saved && typeof saved === 'object') {
    Object.keys(saved).forEach(id => {
      const def = saved[id];
      if (!/^u_[a-z0-9]+$/.test(id) || !def || typeof def.label !== 'string' || !def.label.trim()) {
        console.error('madrid-trip: skipped invalid userRows entry', id, def);
        return;
      }
      userRows[id] = Object.assign({}, cloneJson(def), {
        label: def.label.trim().slice(0, 60),
        group: GROUP_KEYS.includes(def.group) ? def.group : 'misc',
        createdAt: Number(def.createdAt) || 0
      });
    });
  }
  refreshIds();
  userRowIds().forEach(id => {
    defaults.values[id] = '';
    insertUserRowEl(id);
  });
}

function createUserRow(groupKey, label){
  if (tier !== 'custom' || !GROUP_KEYS.includes(groupKey)) return;
  const clean = String(label).trim().slice(0, 60);
  if (!clean) return;
  const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  userRows[id] = {label: clean, group: groupKey, createdAt: Date.now()};
  customValues[id] = '';
  customCurrencies[id] = 'EUR';
  defaults.values[id] = '';
  refreshIds();
  insertUserRowEl(id);
  render();
  scheduleSave();
  const inp = document.querySelector(`[data-in="${id}"]`);
  if (inp) inp.focus();
}

/* מחיקה: כתיבה אחת (scheduleSave) שמסירה את ההגדרה, הערך, המטבע והנעילה
   יחד — לא נשאר שום דבר יתום. שורה נעולה לא נמחקת (נעילה היא תיעוד של
   כסף שהוצא בפועל — קודם מבטלים אותה, במכוון בשני צעדים). */
function deleteUserRow(id){
  if (tier !== 'custom' || !isUserRow(id) || locks[id]) return;
  delete userRows[id];
  delete customValues[id];
  delete customCurrencies[id];
  delete rowMeta[id];
  delete defaults.values[id];
  const row = document.querySelector(`[data-item="${id}"]`);
  if (row) row.remove();
  refreshIds();
  render();
  scheduleSave();
}

function setDelConfirm(id, on){
  const btn = document.querySelector(`[data-delbtn="${id}"]`);
  const conf = document.querySelector(`[data-delconfirm="${id}"]`);
  if (btn) btn.hidden = on;
  if (conf) conf.hidden = !on;
}

/* שינוי שם: רק שורת משתמש, רק ב-custom. גם שורה נעולה — התווית היא לא
   הסכום הקפוא. משנה רק label; group ו-createdAt (ולכן הסדר) נשארים. */
function setRenaming(id, on){
  const form = document.querySelector(`[data-renform="${id}"]`);
  const btn = document.querySelector(`[data-renbtn="${id}"]`);
  const del = document.querySelector(`[data-delbtn="${id}"]`);
  if (!form) return;
  form.hidden = !on;
  if (btn) btn.hidden = on;
  if (del) del.hidden = on;
  if (on) {
    const inp = form.querySelector('input');
    inp.value = userRows[id].label;
    inp.focus();
    inp.select();
  }
}

function renameUserRow(id, label){
  if (tier !== 'custom' || !isUserRow(id)) return false;
  const clean = String(label).trim().slice(0, 60);
  if (!clean) return false;
  userRows[id].label = clean;
  const nameEl = document.querySelector(`[data-item="${id}"] .name`);
  if (nameEl) nameEl.textContent = clean;
  scheduleSave();
  return true;
}

function closeAddForm(key){
  const btn = document.querySelector(`[data-addrow="${key}"]`);
  const form = document.querySelector(`[data-addform="${key}"]`);
  if (btn) btn.hidden = false;
  if (form) { form.hidden = true; const i = form.querySelector('input'); if (i) i.value = ''; }
}

function buildAddRowWrappers(){
  GROUPS.forEach(g => {
    const rowsEl = groupRowsEl(g.key);
    if (!rowsEl) return;
    const wrap = document.createElement('div');
    wrap.className = 'addrow-wrap';
    wrap.dataset.addwrap = g.key;
    wrap.innerHTML =
      `<button class="addrow" data-addrow="${g.key}" type="button">＋ הוסף שורה</button>` +
      `<form class="addform" data-addform="${g.key}" hidden>` +
        `<input type="text" maxlength="60" placeholder="שם השורה" aria-label="שם השורה החדשה">` +
        `<button class="addok" type="submit">הוסף</button>` +
        `<button class="addcancel" data-addcancel="${g.key}" type="button">ביטול</button>` +
      `</form>`;
    rowsEl.appendChild(wrap);
  });
}

/* מסנכרן את customValues/currencies מה-DOM: תמיד עבור GLOBAL_IDS
   (ימים/לילות אינם שייכים לאף שכבה), ומעבר לזה רק כש-tier==='custom'
   ורק לשורה לא נעולה. בשכבת מחיר קבועה ה-DOM מציג את מחיר הייחוס של
   השכבה (לא את custom), ושורה נעולה היא בדיוק השורה שאסור שערך מה-DOM
   ידרוס: השדות שלה חסומים לעריכה, אז ה-DOM אף פעם לא מקור האמת שלה —
   customValues/customCurrencies הם.
   זה מה שמבטיח את כלל 5: רק custom נשמר, presets לא נכתבים
   ל-Firestore בכלל. */
function getState(){
  GLOBAL_IDS.forEach(id => { const el = $(`#${id}`); if (el) customValues[id] = el.value; });
  FIELD_IDS.forEach(id => {
    if (tier === 'custom' && !locks[lockOwnerOf(id)]) {
      const el = $(`[data-in="${id}"]`);
      if (el) customValues[id] = el.value;
    }
  });
  CURRENCY_IDS.forEach(id => {
    if (tier === 'custom' && !locks[id]) customCurrencies[id] = currencyOf(id);
  });
  const locksOut = {};
  Object.keys(locks).forEach(id => { locksOut[id] = Object.assign({}, locks[id]); });
  return Object.assign({}, cloneJson(foreignTop), {
    tier,
    showTierRefs,
    userRows: cloneJson(userRows),
    rowMeta: cloneJson(rowMeta),
    custom: Object.assign({}, cloneJson(foreignCustom), {values: Object.assign({}, customValues), currencies: Object.assign({}, customCurrencies)}),
    toggles: Object.assign({}, toggles), locks: Object.assign({}, cloneJson(foreignLocks), locksOut),
    rates: {
      usd: {value: $('#rateUsd') ? $('#rateUsd').value : '1.08', updatedAt: rateMeta.usd},
      ils: {value: $('#rateIls') ? $('#rateIls').value : '4.05', updatedAt: rateMeta.ils}
    }
  });
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

  // שורות המשתמש נטענות ראשונות: הן קובעות את CURRENCY_IDS, ואת זה שנעילה
  // של id מסוים היא "מוכרת" ולא foreignLocks.
  loadUserRows(data && data.userRows);
  loadRowMeta(data && data.rowMeta);
  syncMetaInputs();

  const savedLocks = (data && data.locks) || {};
  foreignTop = {};
  foreignCustom = {};
  foreignLocks = {};
  if (data) Object.keys(data).forEach(k => { if (!KNOWN_TOP_FIELDS.includes(k)) foreignTop[k] = cloneJson(data[k]); });
  if (data && data.custom) Object.keys(data.custom).forEach(k => { if (k !== 'values' && k !== 'currencies') foreignCustom[k] = cloneJson(data.custom[k]); });
  Object.keys(savedLocks).forEach(id => { if (!CURRENCY_IDS.includes(id)) foreignLocks[id] = cloneJson(savedLocks[id]); });
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
      const dateInput = document.querySelector(`[data-lockdate="${id}"]`);
      if (dateInput) dateInput.value = locks[id].chargedOn;
    }
  });

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
  // הערכים מוצגים רק אחרי שהשערים נקבעו: בשכבת מחיר, presetAmountForRow
  // ממיר את מחיר הייחוס לפי השער החי ב-DOM — אחרת אחרי טעינה הוא ממיר
  // לפי ברירת המחדל של ה-HTML (4.05) ולא לפי השער השמור.
  applyValuesForTier(tier);
  renderTierButtons();
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
  // שדות התקציב וימים/לילות חסומים לעריכה מחוץ ל-custom (ראו render()),
  // אז אירוע input עליהם לא יכול לקרות בשכבת מחיר — אין מעבר אוטומטי.
  if (e.target.matches('[data-desc-in]')) setRowMetaField(e.target.dataset.descIn, 'desc', e.target.value);
  if (e.target.matches('[data-link-in]')) setRowMetaField(e.target.dataset.linkIn, 'url', e.target.value);
  if(e.target.matches('input[type=number]')) { render(); scheduleSave(); }
  if(e.target.matches('[data-lockdate]')){
    const id = e.target.dataset.lockdate;
    if (locks[id]) { locks[id].chargedOn = e.target.value; render(); scheduleSave(); }
  }
});
document.addEventListener('change', e => {
  if(e.target.matches('select.cur')) {
    render();
    scheduleSave();
  }
});
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-lockbtn]');
  // הכפתור עצמו מוסתר מחוץ ל-custom (ראו render()), אבל בודקים גם כאן:
  // נעילה חסרת משמעות בשכבת מחיר קבועה.
  if (!btn || tier !== 'custom') return;
  const id = btn.dataset.lockbtn;
  if (locks[id]) {
    delete locks[id];
  } else {
    const currency = currencyOf(id);
    const amount = lineValueNative(id);
    const rate = currency === 'EUR' ? 1 : rateValue(currency === 'USD' ? 'usd' : 'ils');
    const chargedOn = todayIso();
    locks[id] = {amount: String(amount), currency, rate, chargedOn};
    const dateInput = document.querySelector(`[data-lockdate="${id}"]`);
    if (dateInput) dateInput.value = chargedOn;
  }
  render();
  scheduleSave();
});

document.addEventListener('click', e => {
  const t = e.target;
  const addBtn = t.closest('[data-addrow]');
  if (addBtn) {
    const form = document.querySelector(`[data-addform="${addBtn.dataset.addrow}"]`);
    addBtn.hidden = true;
    form.hidden = false;
    form.querySelector('input').focus();
    return;
  }
  const cancel = t.closest('[data-addcancel]');
  if (cancel) { closeAddForm(cancel.dataset.addcancel); return; }
  const del = t.closest('[data-delbtn]');
  if (del) { if (tier === 'custom' && !locks[del.dataset.delbtn]) setDelConfirm(del.dataset.delbtn, true); return; }
  const ren = t.closest('[data-renbtn]');
  if (ren) { if (tier === 'custom') setRenaming(ren.dataset.renbtn, true); return; }
  const renCancel = t.closest('[data-rencancel]');
  if (renCancel) { setRenaming(renCancel.dataset.rencancel, false); return; }
  const no = t.closest('[data-delno]');
  if (no) { setDelConfirm(no.dataset.delno, false); return; }
  const yes = t.closest('[data-delyes]');
  if (yes) deleteUserRow(yes.dataset.delyes);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.matches && e.target.matches('[data-ren-in]')) setRenaming(e.target.dataset.renIn, false);
});
const metaToggleInput = $('#metaToggle');
if (metaToggleInput) metaToggleInput.addEventListener('change', e => {
  metaEditing = e.target.checked;
  render();
});
document.addEventListener('submit', e => {
  const renForm = e.target.closest('[data-renform]');
  if (renForm) {
    e.preventDefault();
    const id = renForm.dataset.renform;
    // שם ריק לא נשמר — נשאר השם הקיים
    renameUserRow(id, renForm.querySelector('input').value);
    setRenaming(id, false);
    return;
  }
  const form = e.target.closest('[data-addform]');
  if (!form) return;
  e.preventDefault();
  const key = form.dataset.addform;
  createUserRow(key, form.querySelector('input').value);
  closeAddForm(key);
});
buildAddRowWrappers();
$$('.row[data-item]').forEach(row => ensureMetaEl(row, row.dataset.item));

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
