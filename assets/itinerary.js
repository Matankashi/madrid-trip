import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, getDoc, runTransaction } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

/* לו"ז הימים בתיק הטיול (פרק 08, "מבנה הימים").
   מקור האמת הוא Firestore, ב-/users/{uid}/state/itinerary, עם גיבוי
   אופליין ב-localStorage. הטעינה והשמירה הן בדיוק הדפוס של budget.js:
   - טעינה היא getDoc חד-פעמי (לא onSnapshot), כדי שהד של כתיבה לא ינחת
     באמצע עריכה. עד שהיא מסתיימת הלו"ז inert ושום דבר לא נשמר; טעינה
     שנכשלה משאירה אותו לקריאה בלבד — ראו setLoadState.
   - כל שמירה כותבת את המסמך כולו, בטרנזקציה שמסרבת אם המסמך בשרת כבר
     לא זהה ל-lastKnown (מה שהדף הזה טען או כתב בפעם האחרונה) — כך דף
     ישן במכשיר אחר לא דורס שינוי חדש. ראו saveNow.
   - אין מסמך עדיין → העותק המקומי, ואם אין — SEED (הלו"ז המקורי). שום
     דבר לא נכתב עד העריכה הראשונה.

   מבנה המסמך: {items: {id: {day, order, title, desc, status, url, altDay?}},
                days: {ISO: {title?, kind?}}}
   days = הכרטיס עצמו, לא פריט: כותרת ליום וסוג יום (צבע ואייקון של
   האריח בראש הכרטיס). מפתח רק ליום שיש לו לפחות אחד מהם; kind ריק =
   ניחוש מהתוכן (guessKind). ה-day לא זז עם הפריטים — הוא שייך לתאריך.
   day/altDay = תאריך ISO. order = סדר בתוך היום (מתמספר מחדש 0..n בכל
   הזזה). altDay = תאריך חלופי לפריט שהתאריך שלו עוד לא סופי — הפריט מוצג
   בשני הימים אבל הוא פריט אחד (משחק ברצלונה: 7.11 או 8.11, לה ליגה
   קובעת כשבועיים לפני). שדות לא מוכרים (ברמה העליונה ובתוך פריט) נשמרים
   כמות שהם, כמו תאימות הקדימה של budget.js.
   slot = חלק ביום (morning/noon/evening, לא חובה): בתוך יום ממיינים לפי
   slot ואז לפי order, בלי slot בסוף. placeId = פריט שהגיע מההמלצות
   (assets/places.js, מסמך places): השם, ההערה והקישור נקראים חיים משם,
   ו-title נשאר עותק של השם — כך הפריט לא נעלם אם ההמלצות לא נטענו או
   בטאב ישן. מקום אחד בכמה ימים = כמה פריטים עם אותו placeId. */

const STORE_KEY = 'madrid.itinerary.v1';
const DEBOUNCE_MS = 800;
const TRIP_DAYS = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
const WEEKDAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const STATUS_LABEL = { booked: 'BOOKED', planned: 'PLANNED', optional: 'OPTIONAL', open: 'OPEN' };
const STATUS_HE = { booked: 'סגור', planned: 'מתוכנן', optional: 'אופציונלי', open: 'פתוח' };
const TITLE_MAX = 120;
const DAY_TITLE_MAX = 80;
/* סוג יום → צבע (משתנה מהפלטה, ב-styles.css: .k-*) ואייקון גדול באריח */
const KIND_HE = { arrival: 'הגעה', football: 'כדורגל', museum: 'מוזיאון', daytrip: 'טיול יום', city: 'העיר', night: 'לילה', open: 'פתוח' };
const KIND_RULES = [
  [/נחיתה|טיסה/, 'arrival'],
  [/אתלטיקו|יום משחק/, 'football'],
  [/טיול יום|טולדו|סגוביה/, 'daytrip'],
  [/מוזיאון|פראדו|ריינה סופיה|תיסן/, 'museum'],
  [/טכנו|מועדון/, 'night'],
  [/יום פתוח|זמן חופשי/, 'open']
];
const DESC_MAX = 600;
const URL_MAX = 2000;
const SLOT_HE = { morning: 'בוקר', noon: 'צהריים', evening: 'ערב' };
const SLOT_RANK = { morning: 0, noon: 1, evening: 2 };

const seedItem = (day, order, status, title, desc, extra) => Object.assign({ day: `2026-11-${day}`, order, status, title, desc, url: '' }, extra);
const SEED = {
  items: {
    i01: seedItem('01', 0, 'booked', 'נחיתה במדריד', "נחיתה ב-18:45 · הגעה ל-Onefam · צ'ק-אין (חדר פרטי) · ערב רגוע"),
    i02: seedItem('02', 0, 'planned', 'מגלים את מדריד', 'פארק רטירו · Barrio de las Letras · Altar de Muertos (Casa de México) · ערב חופשי'),
    i03: seedItem('03', 0, 'booked', 'אתלטיקו–באיירן', 'יום משחק · קפה, אווירה, יום רגוע'),
    i04: seedItem('04', 0, 'planned', 'מוזיאון הפראדו I', 'הירונימוס בוש (גן התענוגות הארציים) · ציור פלמי ואירופי · 3–4 שעות'),
    i05: seedItem('05', 0, 'planned', 'טיול יום לטולדו', 'מורשת יהודית · בתי כנסת · סיור בעיר (גם כמקום אפשרי למגורים) · ב-20:00 ערב חילופי שפות ב-Beer Station'),
    i06: seedItem('06', 0, 'planned', 'מוזיאון הפראדו II', 'ולאסקס (לאס מנינאס) · גויה (הציורים השחורים, 3 במאי 1808) · ציור ספרדי · 3–4 שעות · ערב אופציונלי: Paula Comitre'),
    i07: seedItem('07', 0, 'booked', 'אתלטיקו–ברצלונה', 'יום משחק · ליהנות מהאווירה', { altDay: '2026-11-08' }),
    i09: seedItem('09', 0, 'optional', 'מדריד המלכותית', 'קתדרלת אלמודנה · הארמון המלכותי · Madrid de los Austrias · פלאסה מאיור'),
    i10: seedItem('10', 0, 'optional', 'טיול יום לסגוביה', 'אמת המים הרומית · העיר העתיקה · האלקסר'),
    i11: seedItem('11', 0, 'optional', 'ריינה סופיה', 'גרניקה (פיקאסו) · אמנות מודרנית ועכשווית · ערב אופציונלי: Erik Truffaz & Antonio Lizana'),
    i11b: seedItem('11', 1, 'optional', 'מוזיאון תיסן-בורנמיסה', 'אוסף אירופי מהרנסנס ועד הפופ-ארט · ליד הפראדו וריינה סופיה'),
    i12: seedItem('12', 0, 'optional', 'מדריד ריו ומטדרו', 'הליכה לאורך הנהר · תרבות עכשווית · תערוכות · ערב אופציונלי: Peeping Tom – Chroniques'),
    i13: seedItem('13', 0, 'optional', 'לילה של טכנו', 'להכיר את סצנת המוזיקה האלקטרונית של מדריד'),
    i14: seedItem('14', 0, 'open', 'יום פתוח', 'זמן חופשי · סקירת התוכניות · הצעדים הבאים (להאריך?)')
  }
};

const $ = s => document.querySelector(s);
const clone = o => JSON.parse(JSON.stringify(o));

let items = {};
let days = {};
let foreignTop = {};
/* מצב תצוגה בלבד, לא נשמר:
   editing = {id, isNew, at, vals, err} — הטופס הפתוח (at = היום שבו נפתח,
   כדי שפריט עם altDay ייערך במקום שבו לחצו). confirmDel = id שמחכה ל"כן".
   dragId = הפריט שנגרר כרגע. menuFor = הפריט שתפריט הפעולות שלו (⋯) פתוח
   ('alt:'+id לכרטיס החלופי). */
let editing = null;
let dayEdit = null; // {day, vals:{title, kind}} — עורך הכרטיס (היום) הפתוח
let menuFor = null;
let confirmDel = null;
let dragId = null;
let placeDrag = null; // מקום שנגרר מההמלצות (places.js) אל הלוח
/* ההמלצות (places.js) מתחברות דרך board.connect: provider = {ready, get,
   catLabel, hasCoords, toggleBeen, openMap, reveal}. בלי provider (או לפני
   שנטען) פריט מההמלצות מוצג לפי העותק שלו. */
let provider = null;
const renderListeners = [];

function applyState(data){
  items = {}; days = {}; foreignTop = {};
  Object.keys(data || {}).forEach(k => { if (k !== 'items' && k !== 'days') foreignTop[k] = data[k]; });
  const ds = (data && data.days && typeof data.days === 'object') ? data.days : {};
  Object.keys(ds).forEach(d => { if (ds[d] && typeof ds[d] === 'object') days[d] = Object.assign({}, ds[d]); });
  const src = (data && data.items && typeof data.items === 'object') ? data.items : {};
  Object.keys(src).forEach(id => { if (src[id] && typeof src[id] === 'object') items[id] = Object.assign({}, src[id]); });
  editing = null; dayEdit = null; confirmDel = null; menuFor = null;
}

function getState(){
  const out = clone(items);
  // העותק של השם מתעדכן מההמלצות בכל שמירה
  Object.keys(out).forEach(id => { const p = placeOf(id); if (p && p.name) out[id].title = String(p.name).slice(0, TITLE_MAX); });
  return Object.assign({}, foreignTop, { items: out, days: clone(days) });
}

const placeOf = id => (items[id] && items[id].placeId && provider ? provider.get(items[id].placeId) : null);
const titleOf = id => { const p = placeOf(id); return String((p && p.name) || items[id].title || ''); };
const slotOf = id => (SLOT_HE[items[id].slot] ? items[id].slot : '');

function guessKind(day){
  const ids = itemsOn(day).concat(altsOn(day));
  if (!ids.length) return 'open';
  const text = ids.map(id => `${titleOf(id)} ${items[id].desc || ''}`).join(' ');
  const r = KIND_RULES.find(([re]) => re.test(titleOf(ids[0]))) || KIND_RULES.find(([re]) => re.test(text));
  return r ? r[1] : 'city';
}
const kindOf = day => (days[day] && KIND_HE[days[day].kind]) ? days[day].kind : guessKind(day);

/* ---------- סדר וימים ---------- */
const orderOf = id => Number(items[id].order) || 0;
const slotRank = id => (slotOf(id) ? SLOT_RANK[slotOf(id)] : 3);
function itemsOn(day){
  return Object.keys(items).filter(id => items[id].day === day)
    .sort((a, b) => (slotRank(a) - slotRank(b)) || (orderOf(a) - orderOf(b)) || (a < b ? -1 : a > b ? 1 : 0));
}
function altsOn(day){
  return Object.keys(items).filter(id => items[id].altDay === day && items[id].day !== day).sort();
}
function renumber(day){ itemsOn(day).forEach((id, i) => { items[id].order = i; }); }
function fmtDay(day){
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(day || '');
  return m ? `${Number(m[2])}.${Number(m[1])}` : String(day || '?');
}
function weekday(day){
  const d = new Date(day + 'T12:00:00Z');
  return isNaN(d) ? '' : 'יום ' + WEEKDAYS[d.getUTCDay()];
}
const statusOf = id => (STATUS_LABEL[items[id].status] ? items[id].status : 'open');

/* מעביר את id ליום day, לפני beforeId (null = בסוף). העברה לתאריך
   החלופי של הפריט = הוא נקבע ליום הזה, אז altDay נמחק. */
function moveTo(id, day, beforeId){
  const it = items[id];
  const from = it.day;
  const list = itemsOn(day).filter(x => x !== id);
  const at = beforeId ? list.indexOf(beforeId) : -1;
  list.splice(at < 0 ? list.length : at, 0, id);
  it.day = day;
  if (it.altDay === day) delete it.altDay;
  list.forEach((x, i) => { items[x].order = i; });
  if (from !== day) renumber(from);
}

/* ---------- קישורים (אותו כלל כמו normalizeUrl ב-budget.js) ---------- */
function normalizeUrl(raw){
  const t = String(raw || '').trim();
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

/* ---------- תצוגה: לוח של 14 כרטיסי יום ----------
   כל כרטיס = יום (תאריך, יום בשבוע), ובתוכו הפריטים של אותו יום: כותרת,
   רשימת נקודות, תג סטטוס בתחתית. התיאור מתפצל לנקודות לפי " · " או שורה
   חדשה; נקודה שמתאימה לאחד מ-ICON_RULES מקבלת אייקון במקום תבליט. */
const svg = inner => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const ICONS = {
  plane: '<path d="M21 12 3 5l3 7-3 7z"/><path d="M6 12h8"/>',
  car: '<rect x="3" y="11" width="18" height="6" rx="2"/><path d="M6 11l2-5h8l2 5"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
  bed: '<path d="M3 7v12M3 15h18v4M21 15v-3a3 3 0 0 0-3-3h-8v6"/><circle cx="6.5" cy="11.5" r="1.5"/>',
  glass: '<path d="M8 3h8l-1 6a3 3 0 0 1-6 0z"/><path d="M12 12v8M8 21h8"/>',
  cutlery: '<path d="M5 3v5a2 2 0 0 0 4 0V3M7 3v18"/><path d="M17 3c-2 2-2 6 0 8v10"/>',
  ball: '<circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/>',
  cup: '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 11h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v3M12 3v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14.5 15a5 5 0 0 1 6.5 5"/>',
  note: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  masks: '<path d="M3 5h9v5a4.5 4.5 0 0 1-9 0z"/><path d="M12 9h9v5a4.5 4.5 0 0 1-9 0"/><path d="M6 12.5c1 1 2 1 3 0M15 16.5c1-1 2-1 3 0"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  // אריח הכרטיס (סוג יום)
  frame: '<rect x="3" y="4" width="18" height="16" rx="1"/><rect x="6.5" y="7.5" width="11" height="9"/><path d="M6.5 15l3.5-3.5 2.5 2.5 2-2 3 3"/>',
  train: '<rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M8 20l2-4M16 20l-2-4"/>',
  columns: '<path d="M3 21h18M4 9h16M12 3l9 5H3z"/><path d="M6 9v9M10 9v9M14 9v9M18 9v9M4 18h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
};
const KIND_ICON = { arrival: 'plane', football: 'ball', museum: 'frame', daytrip: 'train', city: 'columns', night: 'headphones', open: 'sun' };
// הסדר קובע: הכלל הראשון שמתאים מנצח
const ICON_RULES = [
  [/נחיתה|טיסה|הצעדים הבאים|להאריך/, 'plane'],
  [/הגעה ל|מונית|נסיעה/, 'car'],
  [/צ'ק-אין|חדר פרטי/, 'bed'],
  [/ערב רגוע/, 'glass'],
  [/ערב חופשי|ארוחה/, 'cutlery'],
  [/יום משחק/, 'ball'],
  [/קפה|אווירה|זמן חופשי/, 'cup'],
  [/שעות/, 'clock'],
  [/Language Exchange|חילופי שפות/, 'people'],
  [/ג'אז|Truffaz|קונצרט/, 'note'],
  [/ערב אופציונלי|הופעה/, 'masks'],
  [/טכנו|אלקטרונית|מועדון/, 'headphones'],
  [/סקירת|לבדוק/, 'search']
];
const iconFor = text => { const r = ICON_RULES.find(([re]) => re.test(text)); return r ? r[1] : null; };
/* טווח/שעה/תאריך (3–4, 20:00, 7.11) כ-LTR מבודד: אחרת בתוך שורה RTL
   האלגוריתם הדו-כיווני הופך את הסדר ו-"3–4 שעות" מוצג "4–3 שעות". */
function withLtrNumbers(text){
  const span = h('span', {});
  String(text).split(/(\d+(?:[:.\u2013-]\d+)+)/).forEach((part, i) => {
    if (!part) return;
    span.appendChild(i % 2 ? h('span', { dir: 'ltr', text: part }) : document.createTextNode(part));
  });
  return span;
}
const splitPoints = desc => String(desc || '').split(/\s+·\s+|\n+/).map(s => s.trim()).filter(Boolean);

function h(tag, attrs, ...kids){
  const e = document.createElement(tag);
  Object.keys(attrs || {}).forEach(k => {
    const v = attrs[k];
    if (v === false || v === null || v === undefined) return;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  });
  kids.forEach(k => { if (k) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
  return e;
}
const actBtn = (act, id, text, label, disabled) => h('button', { type: 'button', class: 'itin-btn', 'data-act': act, 'data-id': id, 'aria-label': label || false, disabled: !!disabled }, text);

// נקודה = טקסט (אייקון לפי ICON_RULES) או {text, icon} עם אייקון קבוע
function renderPoints(points){
  const ul = h('ul', { class: 'itin-points' });
  points.forEach(pt => {
    const p = typeof pt === 'string' ? pt : pt.text;
    const icon = typeof pt === 'string' ? iconFor(p) : pt.icon;
    const li = h('li', { 'data-icon': icon || false, class: icon ? 'ic' : false });
    if (icon) { const s = h('span', { class: 'itin-ic' }); s.innerHTML = svg(ICONS[icon]); li.appendChild(s); }
    li.appendChild(withLtrNumbers(p));
    ul.appendChild(li);
  });
  return ul;
}
const badge = st => h('div', { class: 'itin-badge', title: STATUS_HE[st] }, STATUS_LABEL[st]);
const menuBtn = (id, title, act) => h('button', { type: 'button', class: 'itin-menu', 'data-act': act || 'menu', 'data-id': id, 'aria-expanded': String(menuFor === id), 'aria-label': `פעולות: "${title}"` }, '⋯');

/* list = הפריטים של אותו יום בסדר התצוגה. ↑/↓ רק בתוך אותו חלק ביום —
   ה-slot קובע את המקום, אז הזזה מעבר לגבול שלו לא הייתה נשארת. */
function renderItem(id, list, idx){
  const it = items[id];
  const st = statusOf(id);
  const title = titleOf(id);
  const place = placeOf(id);
  const sameSlot = j => j >= 0 && j < list.length && slotOf(list[j]) === slotOf(id);
  const dayIdx = TRIP_DAYS.indexOf(it.day);
  const card = h('div', { class: `itin-item st-${st}` + (it.placeId ? ' itin-fromplace' : ''), 'data-item': id, 'data-placeid': it.placeId || false, draggable: 'true' });
  card.appendChild(menuBtn(id, title));
  const meta = [SLOT_HE[slotOf(id)], it.placeId && place ? provider.catLabel(it.placeId) : null].filter(Boolean).join(' · ');
  if (meta || (place && place.been)) card.appendChild(h('div', { class: 'itin-meta' }, meta, place && place.been ? h('span', { class: 'itin-been' }, '✓ היינו') : null));
  card.appendChild(h('div', { class: 'itin-title', 'data-title': id, text: title }));
  const points = place ? (place.hood ? [{ text: String(place.hood), icon: 'pin' }] : []).concat(splitPoints(place.note)) : splitPoints(it.desc);
  if (points.length) card.appendChild(renderPoints(points));
  if (it.placeId && !place && provider && provider.ready()) card.appendChild(h('div', { class: 'itin-tbd itin-gone' }, 'המקום לא נמצא בהמלצות'));
  if (it.altDay) card.appendChild(h('div', { class: 'itin-tbd' }, `תאריך לא סופי: ${fmtDay(it.day)} או ${fmtDay(it.altDay)}`));
  const href = normalizeUrl(place ? place.url : it.url);
  if (href) card.appendChild(h('a', { class: 'itin-link', href, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'rowlink-host', text: linkLabel(href) }), ' ↗'));
  card.appendChild(badge(st));
  const acts = h('div', { class: 'itin-acts', hidden: menuFor !== id });
  const moves = [
    actBtn('edit', id, 'עריכה', `עריכת "${title}"`),
    actBtn('up', id, '↑ למעלה', `הזזת "${title}" למעלה באותו יום`, !sameSlot(idx - 1)),
    actBtn('down', id, '↓ למטה', `הזזת "${title}" למטה באותו יום`, !sameSlot(idx + 1)),
    actBtn('prev', id, 'ליום הקודם', `העברת "${title}" ליום הקודם`, dayIdx <= 0),
    actBtn('next', id, 'ליום הבא', `העברת "${title}" ליום הבא`, dayIdx < 0 || dayIdx >= TRIP_DAYS.length - 1)];
  if (it.placeId) {
    // פריט מההמלצות: הסרה מהיום בלי אישור — המקום עצמו נשאר בהמלצות
    acts.append(...moves.concat([
      place && provider.hasCoords(it.placeId) ? actBtn('map', id, 'על המפה', `"${title}" על המפה`) : null,
      place ? actBtn('been', id, place.been ? 'בטל "היינו"' : 'היינו ✓', place.been ? `ביטול הסימון "היינו" של "${title}"` : `סימון "${title}" כמקום שהיינו בו`, !provider.ready()) : null,
      place ? actBtn('reveal', id, 'בהמלצות', `פתיחת "${title}" בהמלצות`) : null,
      actBtn('unplace', id, 'הסר מהיום', `הסרת "${title}" מ-${fmtDay(it.day)} (נשאר בהמלצות)`)
    ]).filter(Boolean));
  } else if (confirmDel === id) {
    acts.appendChild(h('div', { class: 'itin-confirm' }, `למחוק את "${title}"?`,
      h('button', { type: 'button', class: 'delyes', 'data-act': 'delyes', 'data-id': id }, 'כן, למחוק'),
      h('button', { type: 'button', class: 'delno', 'data-act': 'delno', 'data-id': id }, 'לא')));
  } else {
    acts.append(...moves, actBtn('del', id, 'מחיקה', `מחיקת "${title}"`));
  }
  card.appendChild(acts);
  return card;
}

/* אותו פריט, ביום החלופי שלו (8.11 במקרה של ברצלונה). הפניה בלבד: עריכה
   כן, הזזה רק מהיום הראשי. הנקודות נבנות מהתאריכים ולא מהתיאור — ביום
   הזה זה "יום משחק אם לא ב-X, אחרת זמן חופשי". */
function renderAlt(id){
  const it = items[id];
  const st = statusOf(id);
  const title = String(it.title || '');
  const card = h('div', { class: `itin-item itin-alt st-${st}`, 'data-alt': id });
  card.appendChild(menuBtn(id, title, 'menualt'));
  card.appendChild(h('div', { class: 'itin-title', text: title }, h('span', { class: 'itin-or' }, 'או יום משחק')));
  card.appendChild(renderPoints([`יום משחק (אם לא ב-${fmtDay(it.day)})`, 'זמן חופשי']));
  card.appendChild(h('div', { class: 'itin-tbd' }, `תאריך לא סופי: ${fmtDay(it.day)} או ${fmtDay(it.altDay)}`));
  card.appendChild(badge(st));
  card.appendChild(h('div', { class: 'itin-acts', hidden: menuFor !== 'alt:' + id }, actBtn('editalt', id, 'עריכה', `עריכת "${title}"`)));
  return card;
}

function dayOptions(selected, withNone){
  const sel = h('select', {});
  if (withNone) sel.appendChild(h('option', { value: '' }, '— אין, התאריך סופי —'));
  const days = TRIP_DAYS.slice();
  if (selected && !days.includes(selected)) days.push(selected);
  days.forEach(d => sel.appendChild(h('option', { value: d, selected: d === selected }, TRIP_DAYS.includes(d) ? `${fmtDay(d)} · ${weekday(d)}` : fmtDay(d))));
  return sel;
}

/* פריט מההמלצות: רק תאריך, חלק ביום וסטטוס — השם, ההערה והקישור שייכים
   למקום ונערכים בהמלצות (אחרת עריכה ביום אחד הייתה נעלמת בשאר הימים). */
function renderForm(){
  const v = editing.vals;
  const key = editing.isNew ? 'new' : editing.id;
  const linked = !editing.isNew && items[editing.id] && items[editing.id].placeId;
  const field = (label, input) => h('label', { class: 'itin-field' }, h('span', {}, label), input);
  const slot = h('select', { 'data-f': 'slot' });
  slot.appendChild(h('option', { value: '' }, '—'));
  Object.keys(SLOT_HE).forEach(s => slot.appendChild(h('option', { value: s, selected: s === v.slot }, SLOT_HE[s])));
  const title = h('input', { type: 'text', 'data-f': 'title', maxlength: TITLE_MAX, value: v.title });
  const desc = h('textarea', { 'data-f': 'desc', maxlength: DESC_MAX, rows: '4' }); desc.value = v.desc;
  const day = dayOptions(v.day, false); day.setAttribute('data-f', 'day');
  const alt = dayOptions(v.altDay, true); alt.setAttribute('data-f', 'altDay');
  const status = h('select', { 'data-f': 'status' });
  Object.keys(STATUS_LABEL).forEach(s => status.appendChild(h('option', { value: s, selected: s === v.status }, `${STATUS_LABEL[s]} · ${STATUS_HE[s]}`)));
  const url = h('input', { type: 'text', 'data-f': 'url', maxlength: URL_MAX, value: v.url, dir: 'ltr', inputmode: 'url', placeholder: 'https://…' });
  return h('div', { class: `itin-item itin-form st-${STATUS_LABEL[v.status] ? v.status : 'open'}`, 'data-form': key },
    linked ? h('div', { class: 'itin-title', text: titleOf(editing.id) }) : field('כותרת', title),
    linked ? h('div', { class: 'itin-formnote' }, 'השם, ההערה והקישור נערכים בהמלצות.') : field('נקודות (מופרדות ב-" · " או שורה לכל נקודה)', desc),
    h('div', { class: 'itin-row' }, field('תאריך', day), linked ? null : field('תאריך חלופי (אם לא סופי)', alt), field('חלק ביום', slot), field('סטטוס', status)),
    linked ? null : field('קישור חיצוני', url),
    editing.err ? h('div', { class: 'linkerr', role: 'alert', text: editing.err }) : null,
    h('div', { class: 'itin-formacts' },
      h('button', { type: 'button', class: 'addok', 'data-act': 'save', 'data-id': key }, editing.isNew ? 'הוספה' : 'שמירה'),
      h('button', { type: 'button', class: 'addcancel', 'data-act': 'cancel', 'data-id': key }, 'ביטול')));
}

function renderDay(day){
  const other = day === null;
  const editingHere = editing && (other ? !TRIP_DAYS.includes(editing.at) : editing.at === day);
  const block = h('div', { class: 'itin-day' + (editingHere ? ' editing' : ''), 'data-day': other ? 'other' : day });
  const head = h('div', { class: 'itin-head' },
    h('span', { class: 'mono itin-date' }, other ? '—' : fmtDay(day)),
    h('span', { class: 'itin-wd' }, other ? 'תאריך מחוץ לטווח הטיול' : weekday(day)));
  if (!other) head.appendChild(h('button', { type: 'button', class: 'itin-dayedit', 'data-act': 'dayedit', 'data-id': day, 'aria-label': `עריכת הכרטיס של ${fmtDay(day)} (כותרת וסוג יום)` }, '✎'));
  block.appendChild(head);
  if (!other) {
    const kind = kindOf(day);
    block.classList.add('k-' + kind);
    const tile = h('div', { class: 'itin-tile', 'data-kind': kind, title: KIND_HE[kind] });
    tile.innerHTML = svg(ICONS[KIND_ICON[kind]]).replace('width="15" height="15"', 'width="38" height="38"').replace('stroke-width="1.8"', 'stroke-width="1.4"');
    block.appendChild(tile);
    if (dayEdit && dayEdit.day === day) block.appendChild(renderDayForm(day));
    else if (days[day] && days[day].title) block.appendChild(h('div', { class: 'itin-daytitle', 'data-daytitle': day, text: String(days[day].title) }));
  }
  const list = h('div', { class: 'itin-list', 'data-list': other ? 'other' : day });
  if (!other) altsOn(day).forEach(id => list.appendChild(editing && editing.id === id && editing.at === day ? renderForm() : renderAlt(id)));
  const main = other ? Object.keys(items).filter(id => !TRIP_DAYS.includes(items[id].day)).sort() : itemsOn(day);
  main.forEach((id, i) => list.appendChild(editing && !editing.isNew && editing.id === id && editing.at === items[id].day ? renderForm() : renderItem(id, main, i)));
  if (!other && editing && editing.isNew && editing.at === day) list.appendChild(renderForm());
  else if (!other) list.appendChild(h('div', { class: 'itin-add' }, h('button', { type: 'button', class: 'addrow', 'data-act': 'add', 'data-id': day, 'aria-label': `הוספת פריט ל-${fmtDay(day)}` }, '＋ פריט')));
  block.appendChild(list);
  return block;
}

function renderDayForm(day){
  const v = dayEdit.vals;
  const field = (label, input) => h('label', { class: 'itin-field' }, h('span', {}, label), input);
  const title = h('input', { type: 'text', 'data-df': 'title', maxlength: DAY_TITLE_MAX, value: v.title, placeholder: 'בלי כותרת' });
  const kind = h('select', { 'data-df': 'kind' });
  kind.appendChild(h('option', { value: '' }, `אוטומטי (${KIND_HE[guessKind(day)]})`));
  Object.keys(KIND_HE).forEach(k => kind.appendChild(h('option', { value: k, selected: k === v.kind }, KIND_HE[k])));
  return h('div', { class: 'itin-dayform', 'data-dayform': day },
    field('כותרת היום', title),
    field('סוג יום (צבע ואייקון)', kind),
    h('div', { class: 'itin-formacts' },
      h('button', { type: 'button', class: 'addok', 'data-act': 'daysave', 'data-id': day }, 'שמירה'),
      h('button', { type: 'button', class: 'addcancel', 'data-act': 'daycancel', 'data-id': day }, 'ביטול')));
}

/* סיכום מתחת ללוח, נגזר מהפריטים בלבד (אין עותק שני לערוך): סגור /
   מתוכנן / אופציונלי, כל פריט "תאריך · כותרת" לפי סדר הימים. השורה של
   הלינה (Onefam 1–8.11, ו-8–14.11 שעוד פתוח) קבועות ב-HTML — הן לא
   פעילות ולא פריטים בלוח. */
function renderSummary(){
  const order = id => [TRIP_DAYS.indexOf(items[id].day), orderOf(id), id];
  const cmp = (a, b) => { const x = order(a), y = order(b); return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] < y[2] ? -1 : 1); };
  ['booked', 'planned', 'optional'].forEach(st => {
    const ul = document.querySelector(`[data-sum="${st}"]`);
    if (!ul) return;
    ul.textContent = '';
    Object.keys(items).filter(id => statusOf(id) === st).sort(cmp).forEach(id => {
      const it = items[id];
      const when = it.altDay ? `${fmtDay(it.day)} / ${fmtDay(it.altDay)}` : fmtDay(it.day);
      ul.appendChild(h('li', { 'data-sum-item': id }, h('span', { class: 'mono itin-sumdate', text: when }), h('span', { text: titleOf(id) })));
    });
    if (!ul.children.length) ul.appendChild(h('li', { class: 'itin-sumempty', text: '—' }));
  });
}

function render(focusSel){
  const root = $('#itin');
  if (!root) return;
  root.textContent = '';
  TRIP_DAYS.forEach(d => root.appendChild(renderDay(d)));
  if (Object.keys(items).some(id => !TRIP_DAYS.includes(items[id].day))) root.appendChild(renderDay(null));
  renderSummary();
  const f = focusSel && root.querySelector(focusSel);
  if (f) f.focus();
  renderListeners.forEach(cb => { try { cb(); } catch (e) { console.error('madrid-trip: itinerary render listener failed', e); } });
}

function announce(msg){
  const live = $('#itinLive');
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); }
}

/* ---------- פעולות ---------- */
function openEdit(id, at){
  const it = items[id];
  menuFor = null; dayEdit = null;
  editing = { id, isNew: false, at, err: '', vals: { title: String(it.title || ''), desc: String(it.desc || ''), day: it.day, altDay: it.altDay || '', status: statusOf(id), url: String(it.url || ''), slot: slotOf(id) } };
  confirmDel = null;
  render(`[data-form="${id}"] [data-f="${it.placeId ? 'day' : 'title'}"]`);
}

function saveEdit(){
  const v = editing.vals;
  const linked = !editing.isNew && items[editing.id] && items[editing.id].placeId;
  const title = linked ? titleOf(editing.id) : v.title.trim();
  const url = linked ? '' : v.url.trim();
  const fail = msg => { editing.err = msg; render(`[data-form="${editing.isNew ? 'new' : editing.id}"] [data-f="title"]`); };
  if (!title) return fail('צריך כותרת.');
  if (url && !normalizeUrl(url)) return fail('הקישור לא תקין — רק http/https, בלי רווחים.');
  const day = v.day;
  if (!editing.isNew && placeClash(editing.id, day)) return fail(`המקום הזה כבר ב-${fmtDay(day)}.`);
  const altDay = !linked && v.altDay && v.altDay !== day ? v.altDay : '';
  const fields = linked ? { status: STATUS_LABEL[v.status] ? v.status : 'optional' }
    : { title: title.slice(0, TITLE_MAX), desc: v.desc.trim().slice(0, DESC_MAX), status: STATUS_LABEL[v.status] ? v.status : 'open', url: url.slice(0, URL_MAX) };
  let id = editing.id;
  if (editing.isNew) {
    id = 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    items[id] = Object.assign({ day, order: itemsOn(day).length }, fields);
  } else {
    const it = items[id];
    const from = it.day;
    Object.assign(it, fields);
    if (from !== day) { it.day = day; it.order = itemsOn(day).filter(x => x !== id).length; renumber(from); }
  }
  if (altDay) items[id].altDay = altDay; else delete items[id].altDay;
  if (SLOT_HE[v.slot]) items[id].slot = v.slot; else delete items[id].slot;
  renumber(items[id].day); // ה-slot יכול להזיז את הפריט בתוך היום
  editing = null;
  scheduleSave();
  render(`[data-item="${id}"] [data-act="menu"]`);
  announce(`נשמר: ${title}`);
}

function onAct(act, id){
  if (loadState !== 'ready') return;
  const it = items[id];
  if (act === 'add') {
    dayEdit = null;
    editing = { id: null, isNew: true, at: id, err: '', vals: { title: '', desc: '', day: id, altDay: '', status: 'planned', url: '', slot: '' } };
    confirmDel = null;
    return render('[data-form="new"] [data-f="title"]');
  }
  if (act === 'save') return saveEdit();
  if (act === 'dayedit') {
    const d = days[id] || {};
    editing = null; menuFor = null; confirmDel = null;
    dayEdit = { day: id, vals: { title: String(d.title || ''), kind: KIND_HE[d.kind] ? d.kind : '' } };
    return render(`[data-dayform="${id}"] [data-df="title"]`);
  }
  if (act === 'daycancel') { dayEdit = null; return render(`[data-act="dayedit"][data-id="${id}"]`); }
  if (act === 'daysave') {
    if (!dayEdit || dayEdit.day !== id) return;
    const v = dayEdit.vals;
    const entry = Object.assign({}, days[id] || {});
    const title = v.title.trim().slice(0, DAY_TITLE_MAX);
    if (title) entry.title = title; else delete entry.title;
    if (KIND_HE[v.kind]) entry.kind = v.kind; else delete entry.kind;
    if (Object.keys(entry).length) days[id] = entry; else delete days[id];
    dayEdit = null;
    scheduleSave();
    render(`[data-act="dayedit"][data-id="${id}"]`);
    return announce(`נשמר: ${fmtDay(id)}`);
  }
  if (act === 'cancel') { const back = editing && !editing.isNew ? editing.id : null; const at = editing && editing.at; editing = null; return render(back ? `[data-item="${back}"] [data-act="menu"], [data-alt="${back}"] [data-act="menualt"]` : `[data-act="add"][data-id="${at}"]`); }
  if (!it) return;
  if (act === 'menu' || act === 'menualt') {
    const k = act === 'menu' ? id : 'alt:' + id;
    menuFor = menuFor === k ? null : k; confirmDel = null;
    return render(menuFor ? `[data-${act === 'menu' ? 'item' : 'alt'}="${id}"] .itin-acts button` : `[data-${act === 'menu' ? 'item' : 'alt'}="${id}"] [data-act="${act}"]`);
  }
  if (['up', 'down', 'prev', 'next', 'del', 'been'].includes(act)) menuFor = id; // גם כשהלחיצה לא הגיעה מהתפריט (מקלדת/בדיקות), הפוקוס נשאר על הפריט
  if (act === 'unplace') return removePlacement(id, true);
  if (act === 'map') return provider && it.placeId && provider.openMap(it.placeId);
  if (act === 'reveal') return provider && it.placeId && provider.reveal(it.placeId);
  if (act === 'been') {
    if (!provider || !provider.ready() || !placeOf(id)) return;
    provider.toggleBeen(it.placeId); // כותב למסמך places בלבד, ומרנדר את הלוח מחדש
    return render(`[data-item="${id}"] [data-act="been"]`);
  }
  if (act === 'edit') return openEdit(id, it.day);
  if (act === 'editalt') return openEdit(id, it.altDay);
  if (act === 'del') { confirmDel = id; return render(`[data-act="delno"][data-id="${id}"]`); }
  if (act === 'delno') { confirmDel = null; menuFor = id; return render(`[data-item="${id}"] [data-act="del"]`); }
  if (act === 'delyes') {
    const day = it.day, title = it.title;
    delete items[id]; confirmDel = null; menuFor = null;
    if (editing && editing.id === id) editing = null;
    renumber(day);
    scheduleSave();
    render(`[data-act="add"][data-id="${day}"]`);
    return announce(`נמחק: ${title}`);
  }
  if (act === 'up' || act === 'down') {
    const list = itemsOn(it.day);
    const i = list.indexOf(id), j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length || slotOf(list[j]) !== slotOf(id)) return;
    moveTo(id, it.day, act === 'up' ? list[j] : list[j + 1] || null);
    scheduleSave();
    render(`[data-item="${id}"] [data-act="${act}"]:not([disabled]), [data-item="${id}"] [data-act="edit"]`);
    return announce(`${it.title}: מקום ${j + 1} ב-${fmtDay(it.day)}`);
  }
  if (act === 'prev' || act === 'next') {
    const i = TRIP_DAYS.indexOf(it.day), j = act === 'prev' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= TRIP_DAYS.length) return;
    if (placeClash(id, TRIP_DAYS[j])) return announce(`${titleOf(id)} כבר ב-${fmtDay(TRIP_DAYS[j])}`);
    moveTo(id, TRIP_DAYS[j], null);
    scheduleSave();
    render(`[data-item="${id}"] [data-act="${act}"]:not([disabled]), [data-item="${id}"] [data-act="edit"]`);
    return announce(`${it.title} הועבר ל-${fmtDay(TRIP_DAYS[j])}`);
  }
}

/* ---------- שיבוץ מההמלצות (places.js) ----------
   מקום בלוח = פריט רגיל עם placeId, סטטוס optional. אותו מקום פעם אחת לכל
   היותר בכל יום, בכמה ימים כמה שרוצים. הסרה מוחקת רק את הפריט — המקום
   נשאר במסמך places. */
// פריט מההמלצות לא נכנס ליום שכבר יש בו את אותו מקום
const placeClash = (id, day) => !!items[id].placeId && itemsOn(day).some(x => x !== id && items[x].placeId === items[id].placeId);

function placementsOf(pid){
  return Object.keys(items).filter(id => items[id].placeId === pid)
    .sort((a, b) => (items[a].day < items[b].day ? -1 : items[a].day > items[b].day ? 1 : 0))
    .map(id => ({ id, day: items[id].day }));
}

function addPlacement(pid, day, beforeId){
  const p = provider && provider.get(pid);
  if (loadState !== 'ready' || !p || !TRIP_DAYS.includes(day)) return false;
  if (itemsOn(day).some(x => items[x].placeId === pid)) { announce(`${p.name} כבר ב-${fmtDay(day)}`); return false; }
  const id = 'i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  items[id] = { day, order: itemsOn(day).length, title: String(p.name || '').slice(0, TITLE_MAX), desc: '', status: 'optional', url: '', placeId: pid };
  moveTo(id, day, beforeId || null);
  menuFor = null;
  scheduleSave();
  render();
  announce(`${p.name} נוסף ל-${fmtDay(day)}`);
  return true;
}

function removePlacement(id, fromMenu){
  const it = items[id];
  if (loadState !== 'ready' || !it || !it.placeId) return false;
  const day = it.day, title = titleOf(id);
  delete items[id];
  if (editing && editing.id === id) editing = null;
  menuFor = null; confirmDel = null;
  renumber(day);
  scheduleSave();
  render(fromMenu ? `[data-act="add"][data-id="${day}"]` : null);
  announce(`${title} הוסר מ-${fmtDay(day)} — נשאר בהמלצות`);
  return true;
}

let endDrag = () => {}; // נקבע ב-wire()

export { h, normalizeUrl, linkLabel, fmtDay, weekday };
export const board = {
  ready: () => loadState === 'ready',
  days: () => TRIP_DAYS.slice(),
  placements: placementsOf,
  add: addPlacement,
  remove: id => removePlacement(id, false),
  // הפריט שנגרר כרגע מהלוח (כדי שההמלצות יקבלו אותו בשחרור)
  dragging: () => (dragId && items[dragId] ? { id: dragId, placeId: items[dragId].placeId || null } : null),
  setPlaceDrag: pid => { placeDrag = pid || null; if (!placeDrag) endDrag(); },
  endDrag: () => endDrag(),
  connect: p => { provider = p; },
  onRender: cb => { renderListeners.push(cb); },
  refresh: () => render()
};

function wire(){
  const root = $('#itin');
  if (!root) return;
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b && root.contains(b)) onAct(b.dataset.act, b.dataset.id);
  });
  const keep = e => {
    const f = e.target.closest('[data-f]');
    if (f && editing) editing.vals[f.dataset.f] = f.value;
    const df = e.target.closest('[data-df]');
    if (df && dayEdit) dayEdit.vals[df.dataset.df] = df.value;
  };
  root.addEventListener('input', keep);
  root.addEventListener('change', keep);
  root.addEventListener('keydown', e => {
    const dayForm = e.target.closest('[data-dayform]');
    if (dayForm && dayEdit) {
      if (e.key === 'Escape') { e.preventDefault(); onAct('daycancel', dayEdit.day); }
      else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); onAct('daysave', dayEdit.day); }
      return;
    }
    if (!editing || !e.target.closest('[data-form]')) return;
    if (e.key === 'Escape') { e.preventDefault(); onAct('cancel'); }
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); onAct('save'); }
  });

  /* גרירה (עכבר/משטח מגע). אותה פעולה בדיוק כמו הכפתורים — moveTo.
     מקום מההמלצות (placeDrag, נקבע ב-places.js) נכנס ליום דרך addPlacement. */
  const line = h('div', { class: 'itin-dropline', 'aria-hidden': 'true' });
  const clearDrag = () => {
    line.remove();
    root.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging'));
    dragId = null;
    placeDrag = null;
  };
  endDrag = clearDrag;
  const dropTarget = (e) => {
    // כל הכרטיס הוא אזור שחרור, גם הכותרת שלו — לא רק רשימת הפריטים
    const card = e.target.closest && e.target.closest('.itin-day');
    const list = card && card.querySelector('[data-list]');
    if (!list || list.dataset.list === 'other' || !root.contains(list)) return null;
    const cards = [...list.querySelectorAll(':scope > [data-item], :scope > [data-form]')].filter(c => c.dataset.item !== dragId && c.dataset.form !== 'new');
    const before = cards.find(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; }) || null;
    return { list, before };
  };
  root.addEventListener('dragstart', e => {
    const card = e.target.closest && e.target.closest('[data-item]');
    if (!card || loadState !== 'ready' || e.target.closest('input, textarea, select, button, a')) { e.preventDefault(); return; }
    dragId = card.dataset.item;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  root.addEventListener('dragover', e => {
    if (!dragId && !placeDrag) return;
    const t = dropTarget(e);
    if (!t || loadState !== 'ready') { line.remove(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = placeDrag ? 'copy' : 'move';
    const anchor = t.before || t.list.querySelector(':scope > .itin-add, :scope > [data-form="new"]');
    if (anchor) t.list.insertBefore(line, anchor); else t.list.appendChild(line);
  });
  root.addEventListener('drop', e => {
    if (!dragId && !placeDrag) return;
    const t = dropTarget(e);
    if (!t) return;
    e.preventDefault();
    const id = dragId, pid = placeDrag;
    const beforeId = t.before ? (t.before.dataset.item || t.before.dataset.form) : null;
    clearDrag();
    if (pid) { addPlacement(pid, t.list.dataset.list, beforeId); return; }
    if (loadState !== 'ready' || !items[id]) return;
    if (placeClash(id, t.list.dataset.list)) return announce(`${titleOf(id)} כבר ב-${fmtDay(t.list.dataset.list)}`);
    menuFor = null;
    moveTo(id, t.list.dataset.list, beforeId);
    scheduleSave();
    render();
    announce(`${items[id].title} הועבר ל-${fmtDay(items[id].day)}`);
  });
  root.addEventListener('dragend', clearDrag);
}

/* ---------- שמירה (הדפוס של budget.js) ---------- */
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

/* מצב הטעינה הראשונית — אותם ארבעה מצבים כמו ב-budget.js:
   'pending' (getDoc באוויר, inert, לא שומרים כלום), 'failed' (מוצג העותק
   המקומי לקריאה בלבד), 'ready' (רק כאן שומרים), 'conflict' (המסמך השתנה
   במכשיר/טאב אחר — לקריאה בלבד עד רענון). inert רק על הלו"ז עצמו, לא על
   כל הדף: הצ'קליסט והקישורים בשאר התיק ממשיכים לעבוד. */
let loadState = 'pending';
const LOAD_MSG = {
  pending: 'טוען את הלו״ז…',
  failed: 'הטעינה מהשרת נכשלה. מוצג העותק האחרון שנשמר במכשיר הזה, לקריאה בלבד — שום שינוי לא יישמר. רעננו את הדף כדי לנסות שוב.',
  failedNoLocal: 'הטעינה מהשרת נכשלה ואין עותק שמור במכשיר הזה. מוצג הלו״ז המקורי, לקריאה בלבד — שום שינוי לא יישמר. רעננו את הדף כדי לנסות שוב.',
  conflict: 'השתנה במכשיר אחר — רענן'
};
function setLoadState(state, msgKey){
  loadState = state;
  const blocked = state !== 'ready';
  const root = $('#itin');
  if (root) root.inert = blocked;
  const banner = $('#itinBanner');
  if (banner) {
    banner.hidden = !blocked;
    banner.textContent = LOAD_MSG[msgKey || state];
    banner.classList.toggle('failed', state === 'failed' || state === 'conflict');
  }
}

/* הגנה מדריסה בין מכשירים — העתק של budget.js: lastKnown = JSON קנוני של
   המסמך כפי שהדף הזה מכיר אותו (null = אין מסמך). השמירה קוראת את המסמך
   בטרנזקציה ומסרבת אם הוא שונה; שמירות של הדף עצמו רצות בתור (saveChain). */
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x);
const docCanon = snap => (snap.exists() ? canon(snap.data()) : null);
const CONFLICT = new Error('itinerary doc changed since this page loaded');
let lastKnown = null;
let saveChain = Promise.resolve();
let savePending = false; // יש שמירה שמחכה ל-debounce או רצה כרגע

function saveNow(){
  saveTimer = null;
  if (loadState !== 'ready') { savePending = false; return Promise.resolve(); }
  const state = getState();
  const next = canon(state);
  return runTransaction(db, async tx => {
    const cur = docCanon(await tx.get(docRef));
    if (cur !== lastKnown) throw CONFLICT;
    tx.set(docRef, state);
  }).then(() => {
    lastKnown = next;
  }, err => {
    if (err === CONFLICT) {
      console.error('madrid-trip: itinerary save refused, the doc changed on another device');
      setLoadState('conflict');
    } else {
      // נשמר ב-localStorage, אבל בלי הלוג כשל נראה בדיוק כמו הצלחה
      console.error('madrid-trip: itinerary save failed', err);
    }
  }).finally(() => {
    if (!saveTimer) savePending = false;
  });
}

function scheduleSave(){
  if (loadState !== 'ready') return; // ראו setLoadState
  saveLocal(getState());
  if (!docRef) return;
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    saveChain = saveChain.then(saveNow);
  }, DEBOUNCE_MS);
}

function checkRemote(){
  if (loadState !== 'ready' || !docRef || savePending) return;
  getDoc(docRef).then(snap => {
    if (loadState === 'ready' && !savePending && docCanon(snap) !== lastKnown) {
      console.error('madrid-trip: the itinerary doc changed on another device');
      setLoadState('conflict');
    }
  }).catch(err => console.error('madrid-trip: itinerary remote change check failed', err));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkRemote(); });
window.addEventListener('focus', checkRemote);

applyState(clone(SEED));
wire();
setLoadState('pending');
render();

onAuthStateChanged(auth, function(user){
  if (!user) return; // assets/auth-guard.js כבר מטפל בהפניה להתחברות

  docRef = doc(db, 'users', user.uid, 'state', 'itinerary');

  getDoc(docRef).then(function(snap){
    lastKnown = docCanon(snap);
    if (snap.exists()) {
      applyState(snap.data());
    } else {
      // אין עדיין מסמך בשרת — העותק המקומי, ואם אין, הלו"ז המקורי
      applyState(loadLocal() || clone(SEED));
    }
    render();
    setLoadState('ready');
  }).catch(function(err){
    console.error('madrid-trip: itinerary getDoc failed', err);
    const local = loadLocal();
    applyState(local || clone(SEED));
    render();
    setLoadState('failed', local ? 'failed' : 'failedNoLocal');
  });
});
