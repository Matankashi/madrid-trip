import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, getDoc, runTransaction } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { board, h, normalizeUrl, linkLabel, fmtDay, weekday } from './itinerary.js';

/* מאגר ההמלצות בפרק 08 (#places, מעל הלוח): בתי קפה, אוכל, פארקים...
   שאפשר לגרור ליום בלוח, או "הוסף ליום" (שבבי ימים — הדרך בטלפון).
   מקור האמת הוא Firestore, ב-/users/{uid}/state/places, עם גיבוי אופליין
   ב-localStorage. הטעינה והשמירה הן בדיוק הדפוס של itinerary.js: getDoc
   חד-פעמי, loadState, טרנזקציה מול lastKnown, saveChain, checkRemote.

   מבנה המסמך: {places: {p_id: {name, cat, hood, note, url, address?, lat?,
                lng?, been?, beenOn?, createdAt, source}},
                cats: {c_id: {label, createdAt}}}
   cat = מפתח מ-BUILTIN או מ-cats (לא מוכר → "אחר" בתצוגה). lat/lng רק
   כשיש מיקום — בלי מיקום אין כפתור מפה, ואין geocoding.

   הקשר ללוח: שיבוץ הוא פריט במסמך itinerary עם placeId (ראו
   itinerary.js), אז "משובץ" נגזר תמיד מהלוח ולא נשמר כאן. "היינו" (been)
   נשמר רק כאן, ידנית, ושום הסרה מיום לא נוגעת בו.
   כלום לא נמחק בשקט: הסרה מיום לא נוגעת במקום; מחיקה מהמאגר רק אחרי
   אישור, ונחסמת כל עוד המקום משובץ (או כשהלו"ז לא נטען ואי אפשר לדעת) —
   כך אין מחיקה שחצי ממנה נכשלת בין שני מסמכים. ייבוא לא דורס מקום קיים.
   שדות לא מוכרים (ברמה העליונה ובתוך מקום) נשמרים כמות שהם. */

const STORE_KEY = 'madrid.places.v1';
const DEBOUNCE_MS = 800;
const BUILTIN = { cafe: 'קפה', food: 'אוכל', parks: 'פארקים', museums: 'מוזיאונים', music: 'מוזיקה', hoods: 'שכונות', other: 'אחר' };
const NAME_MAX = 120;
const HOOD_MAX = 60;
const NOTE_MAX = 600;
const ADDR_MAX = 200;
const URL_MAX = 2000;
const CAT_MAX = 30;
const POOL_MAX = 1500; // מסמך Firestore עד 1MB; מקום ממוצע ~300 בתים
/* Leaflet רק כשפותחים מפה בפעם הראשונה, מגרסה מוצמדת עם SRI */
const LEAFLET = {
  css: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  cssSri: 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=',
  js: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  jsSri: 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='
};
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const $ = s => document.querySelector(s);
const clone = o => JSON.parse(JSON.stringify(o));
const newId = (prefix, n) => prefix + Date.now().toString(36) + (n === undefined ? '' : n.toString(36)) + Math.random().toString(36).slice(2, 6);

let places = {};
let cats = {};
let foreignTop = {};
/* מצב תצוגה בלבד, לא נשמר:
   isOpen = המאגר פתוח. openCat = הקטגוריה הפתוחה. expanded = המקום שהפרטים
   שלו פתוחים. chipsFor = המקום ששבבי הימים שלו פתוחים. form = {id, isNew,
   vals, orig, err} טופס מקום (חדש — תמיד בראש המאגר). catForm = {id, isNew, vals, err} הוספה/שינוי
   שם של קטגוריה. confirmDel / blockDel = מקום שמחכה ל"כן" / שהמחיקה שלו
   נחסמה. catBlock = קטגוריה שאי אפשר למחוק (יש בה מקומות). imp = ייבוא. */
let isOpen = false;
let openCat = null;
let expanded = null;
let chipsFor = null;
let form = null;
let catForm = null;
let confirmDel = null;
let blockDel = null;
let catBlock = null;
let imp = null;

function applyState(data){
  places = {}; cats = {}; foreignTop = {};
  Object.keys(data || {}).forEach(k => { if (k !== 'places' && k !== 'cats') foreignTop[k] = data[k]; });
  const ps = (data && data.places && typeof data.places === 'object') ? data.places : {};
  Object.keys(ps).forEach(id => { if (ps[id] && typeof ps[id] === 'object') places[id] = Object.assign({}, ps[id]); });
  const cs = (data && data.cats && typeof data.cats === 'object') ? data.cats : {};
  Object.keys(cs).forEach(id => { if (cs[id] && typeof cs[id] === 'object' && !BUILTIN[id]) cats[id] = Object.assign({}, cs[id]); });
  form = null; catForm = null; confirmDel = null; blockDel = null; catBlock = null; imp = null; chipsFor = null;
}

function getState(){
  return Object.assign({}, foreignTop, { places: clone(places), cats: clone(cats) });
}

/* ---------- קטגוריות ---------- */
const isCustom = k => !BUILTIN[k] && !!cats[k];
const catIds = () => Object.keys(BUILTIN).filter(k => k !== 'other')
  .concat(Object.keys(cats).sort((a, b) => ((cats[a].createdAt || 0) - (cats[b].createdAt || 0)) || (a < b ? -1 : 1)), ['other']);
const catLabel = k => BUILTIN[k] || (cats[k] && String(cats[k].label || '')) || BUILTIN.other;
const catOf = p => (BUILTIN[p.cat] || cats[p.cat] ? p.cat : 'other');
const byHoodName = (a, b) => {
  const A = places[a], B = places[b];
  const ha = String(A.hood || ''), hb = String(B.hood || '');
  if (!ha !== !hb) return ha ? -1 : 1; // בלי שכונה בסוף
  return ha.localeCompare(hb, 'he') || String(A.name || '').localeCompare(String(B.name || ''), 'he') || (a < b ? -1 : 1);
};
const idsIn = k => Object.keys(places).filter(id => catOf(places[id]) === k).sort(byHoodName);
// ניחוש קטגוריה לייבוא, לפי שם הקובץ/הרשימה
const CAT_RULES = [
  [/caf[eé]|coffee|קפה/i, 'cafe'],
  [/food|eat|restaurant|tapas|brunch|אוכל|מסעד/i, 'food'],
  [/park|garden|פארק|גן/i, 'parks'],
  [/museum|gallery|art|מוזיאון|גלרי/i, 'museums'],
  [/music|jazz|club|bar|concert|מוזיקה|הופע|בר/i, 'music'],
  [/neighbo|barrio|שכונ/i, 'hoods']
];
const guessCat = name => { const r = CAT_RULES.find(([re]) => re.test(name)); return r ? r[1] : 'other'; };

/* ---------- מיקום ---------- */
const validLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const hasCoords = p => !!p && validLatLng(p.lat, p.lng);
const round6 = x => Math.round(x * 1e6) / 1e6;
// "40.4168, -3.7038" (או רווח במקום פסיק)
function parseCoords(text){
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*(?:,\s*|\s+)(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(String(text || ''));
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return validLatLng(lat, lng) ? { lat: round6(lat), lng: round6(lng) } : null;
}
/* מיקום מתוך קישור Google Maps, כשהוא כתוב בו. !3d…!4d… = המקום עצמו
   (עדיף); @lat,lng = מרכז המסך, קרוב מספיק. בלי אף אחד מהם — אין מיקום. */
function coordsFromUrl(raw){
  let s = String(raw || '');
  try { s = decodeURIComponent(s); } catch (e) { /* קישור עם % שבור — בודקים אותו כמו שהוא */ }
  const pats = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query|ll|center|destination)=\+?(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)(?:$|[&\s])/,
    /\/(?:search|place|dir)\/\+?(-?\d+(?:\.\d+)?),\s*\+?(-?\d+(?:\.\d+)?)(?:$|[/?&])/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/
  ];
  for (const re of pats) {
    const m = re.exec(s);
    if (m && validLatLng(Number(m[1]), Number(m[2]))) return { lat: round6(Number(m[1])), lng: round6(Number(m[2])) };
  }
  return null;
}
// שם מתוך קישור (/maps/place/<שם>/ או ?q=<שם>) — לשורה שאין לה שם
function nameFromUrl(url){
  const s = String(url || '');
  const m = /\/maps\/place\/([^/@?]+)/.exec(s) || /[?&]q=([^&]+)/.exec(s);
  if (!m) return '';
  let t = m[1].replace(/\+/g, ' ');
  try { t = decodeURIComponent(t); } catch (e) { /* נשאר כמו שהוא */ }
  t = t.trim();
  return parseCoords(t) ? '' : t;
}

/* ---------- ייבוא מ-Google Takeout ----------
   שני קבצים: רשימה שמורה (Saved/<שם הרשימה>.csv — Title, Note, URL,
   ולפעמים Tags, Comment; בדרך כלל בלי כתובת ובלי מיקום, אלא אם במקרה
   הקישור כולל אותו), ו-Saved Places.json (המקומות המסומנים בכוכב — GeoJSON
   עם קואורדינטות, כתובת וקישור). כפילות = אותו קישור או אותו שם; מקום
   קיים אף פעם לא נדרס. */
function parseCsv(text){
  const src = String(text).replace(/^﻿/, '');
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const HEAD = {
  name: ['title', 'name', 'שם', 'place', 'place name', 'business name'],
  note: ['note', 'notes', 'description', 'הערה', 'הערות', 'comment'],
  url: ['url', 'google maps url', 'maps url', 'link', 'קישור'],
  address: ['address', 'כתובת', 'location'],
  lat: ['latitude', 'lat'],
  lng: ['longitude', 'lng', 'lon', 'long']
};
function rowsFromCsv(text){
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('הקובץ ריק.');
  const head = rows[0].map(x => x.trim().toLowerCase());
  const col = {};
  Object.keys(HEAD).forEach(k => { const i = head.findIndex(x => HEAD[k].includes(x)); if (i >= 0) col[k] = i; });
  if (col.name === undefined && col.url === undefined) throw new Error('לא נמצאה עמודת שם (Title / Name) בשורה הראשונה — זה לא נראה כמו רשימה מ-Takeout.');
  // ב-Takeout יש גם Note וגם Comment — שומרים את שניהם
  const extra = head.map((x, i) => (x === 'comment' && i !== col.note ? i : -1)).filter(i => i >= 0);
  return rows.slice(1).map(r => {
    const get = k => (col[k] === undefined ? '' : String(r[col[k]] || '').trim());
    const note = [get('note')].concat(extra.map(i => String(r[i] || '').trim())).filter(Boolean).join(' · ');
    const lat = Number(get('lat')), lng = Number(get('lng'));
    const coords = get('lat') && get('lng') && validLatLng(lat, lng) ? { lat: round6(lat), lng: round6(lng) } : coordsFromUrl(get('url'));
    return { name: get('name'), note, url: get('url'), address: get('address'), coords };
  });
}
function rowsFromJson(text){
  let data;
  try { data = JSON.parse(String(text).replace(/^﻿/, '')); }
  catch (e) { throw new Error('קובץ JSON לא תקין.'); }
  const feats = data && Array.isArray(data.features) ? data.features : null;
  if (!feats) throw new Error('זה לא Saved Places.json (אין בו features).');
  return feats.map(f => {
    const pr = (f && f.properties) || {};
    const loc = pr.location || pr.Location || {};
    const g = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : [];
    // GeoJSON: [lng, lat]. [0,0] = אין מיקום
    let coords = validLatLng(Number(g[1]), Number(g[0])) ? { lat: round6(Number(g[1])), lng: round6(Number(g[0])) } : null;
    const geo = loc['Geo Coordinates'];
    if (!coords && geo && validLatLng(Number(geo.Latitude), Number(geo.Longitude))) coords = { lat: round6(Number(geo.Latitude)), lng: round6(Number(geo.Longitude)) };
    const url = String(pr.google_maps_url || pr['Google Maps URL'] || '').trim();
    if (!coords) coords = coordsFromUrl(url);
    return {
      name: String(loc.name || loc['Business Name'] || pr.Title || pr.name || '').trim(),
      address: String(loc.address || loc.Address || pr.address || '').trim(),
      url,
      note: NO_LOCATION_NOTE.test(String(pr.Comment || pr.comment || '')) ? '' : String(pr.Comment || pr.comment || '').trim(),
      coords
    };
  });
}
// מה ש-Takeout כותב ב-Comment של מקום בכוכב שאין לו מיקום — לא הערה של המשתמש
const NO_LOCATION_NOTE = /^\s*No location information is available for this saved place\.?\s*$/i;
const nameKey = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
function urlKey(u){
  const s = String(u || '').trim();
  if (!s) return '';
  const fid = /(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(s); // מזהה המקום של Google, יציב בין פורמטים של קישור
  if (fid) return 'f:' + fid[1].toLowerCase();
  const cid = /[?&]cid=(\d+)/.exec(s);
  if (cid) return 'c:' + cid[1];
  return 'u:' + s.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
}
const keysOf = p => [p.url ? urlKey(p.url) : '', 'n:' + nameKey(p.name)].filter(k => k && k !== 'n:');

/* ---------- סינון "מדריד והסביבה" בייבוא ----------
   Saved Places.json מביא כל מה שסומן בכוכב בעולם, אז בתצוגה המקדימה יש
   מסנן, דלוק כברירת מחדל:
   - יש קואורדינטות → בפנים אם עד AREA_KM מהמרכז (קו אווירי), אחרת בחוץ.
   - אין → לפי השם/הכתובת/ההערה: מזכירים את מדריד או עיר קרובה → בפנים;
     יש כתובת שלא מזכירה אף אחת → בחוץ.
   - בלי מיקום ובלי כתובת, והשם לא מזכיר עיר קרובה → אי אפשר לדעת: נשמר
     רק כשהרשימה עצמה היא של מדריד (שם הקובץ, למשל Saved/madrid.csv —
     ברשימה כזו לרוב אין כתובות בכלל), אחרת מסונן.
   אף פעם לא geocoding. אפשר לכבות את המסנן ולייבא הכול. */
const MADRID = { lat: 40.4168, lng: -3.7038 };
const AREA_KM = 100;
const NEAR_LATIN = ['madrid', 'toledo', 'segovia', 'alcala de henares', 'aranjuez', 'el escorial', 'escorial', 'avila', 'guadalajara', 'chinchon',
  'getafe', 'leganes', 'mostoles', 'alcorcon', 'fuenlabrada', 'pozuelo de alarcon', 'majadahonda', 'las rozas', 'boadilla del monte', 'alcobendas',
  'san sebastian de los reyes', 'tres cantos', 'torrejon de ardoz', 'coslada', 'colmenar viejo', 'valdemoro', 'pinto', 'parla',
  'rivas-vaciamadrid', 'arganda del rey', 'navacerrada', 'cercedilla', 'rascafria', 'manzanares el real', 'villaviciosa de odon'];
const NEAR_HE = ['מדריד', 'טולדו', 'סגוביה', 'אלקלה', 'ארנחואס', 'אסקוריאל', 'אווילה', 'גוודלחרה'];
const NEAR_RE = new RegExp('(^|[^a-z])(' + NEAR_LATIN.map(w => w.replace(/[-]/g, '[- ]')).join('|') + ')($|[^a-z])');
const fold = t => String(t || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function distKm(a, b){
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}
const mentionsNear = text => NEAR_RE.test(fold(text)) || NEAR_HE.some(w => String(text || '').includes(w));
// 'in' / 'out' / 'unknown' (אין מיקום ואין כתובת להכריע לפיה)
function areaOf(r){
  if (r.coords) return distKm(r.coords, MADRID) <= AREA_KM ? 'in' : 'out';
  if (mentionsNear([r.name, r.address, r.note].join(' '))) return 'in';
  return r.address ? 'out' : 'unknown';
}
const keeps = (imp, r) => r.area === 'in' || (r.area === 'unknown' && imp.listIsMadrid);
// מה שייכנס בפועל: הכול כשהמסנן כבוי
const chosen = imp => (imp.filter ? imp.fresh.filter(r => keeps(imp, r)) : imp.fresh);

function prepareImport(fileName, text){
  const isJson = /\.(geo)?json$/i.test(fileName) || /^\s*[[{]/.test(String(text).replace(/^﻿/, ''));
  const raw = isJson ? rowsFromJson(text) : rowsFromCsv(text);
  const seen = new Set();
  Object.keys(places).forEach(id => keysOf(places[id]).forEach(k => seen.add(k)));
  const fresh = []; const dupNames = []; let skipped = 0;
  raw.forEach(r => {
    const name = (r.name || nameFromUrl(r.url) || (r.address ? r.address.split(',')[0].trim() : '')).slice(0, NAME_MAX);
    if (!name) { skipped++; return; }
    const rec = { name, note: r.note.slice(0, NOTE_MAX), url: r.url.slice(0, URL_MAX), address: r.address.slice(0, ADDR_MAX), coords: r.coords };
    const ks = keysOf(rec);
    if (ks.some(k => seen.has(k))) { dupNames.push(name); return; }
    ks.forEach(k => seen.add(k));
    rec.area = areaOf(rec);
    fresh.push(rec);
  });
  const base = String(fileName || '').replace(/\.[^.]+$/, '');
  const listIsMadrid = /madrid|מדריד/i.test(fold(base));
  return { file: fileName, kind: isJson ? 'json' : 'csv', total: raw.length, fresh, dupNames, skipped, filter: true, listIsMadrid, cat: guessCat(base), err: '' };
}

/* ---------- תצוגה ---------- */
const pBtn = (act, id, text, label, disabled, extra) => h('button', Object.assign({ type: 'button', class: 'itin-btn', 'data-pact': act, 'data-id': id, 'aria-label': label || false, disabled: !!disabled }, extra || {}), text);
const countText = n => (n === 1 ? 'מקום אחד' : `${n} מקומות`);

function renderPlaceForm(){
  const v = form.vals;
  const key = form.isNew ? 'new' : form.id;
  const field = (label, input, cls) => h('label', { class: 'itin-field' + (cls ? ' ' + cls : '') }, h('span', {}, label), input);
  const text = (name, max, extra) => h('input', Object.assign({ type: 'text', 'data-pf': name, maxlength: max, value: v[name] }, extra || {}));
  const note = h('textarea', { 'data-pf': 'note', maxlength: NOTE_MAX, rows: '3' }); note.value = v.note;
  const cat = h('select', { 'data-pf': 'cat' });
  catIds().forEach(k => cat.appendChild(h('option', { value: k, selected: k === v.cat }, catLabel(k))));
  return h('div', { class: 'pool-form', 'data-pform': key },
    h('div', { class: 'itin-row' }, field('שם', text('name', NAME_MAX)), field('קטגוריה', cat), field('שכונה', text('hood', HOOD_MAX, { placeholder: 'למשל מלסניה' }))),
    field('הערה קצרה', note),
    field('קישור (Google Maps או כל אתר)', text('url', URL_MAX, { dir: 'ltr', inputmode: 'url', placeholder: 'https://maps.app.goo.gl/…' })),
    h('div', { class: 'itin-row' },
      field('קואורדינטות (לא חובה)', text('coords', 60, { dir: 'ltr', placeholder: '40.4168, -3.7038' })),
      field('כתובת (לא חובה)', text('address', ADDR_MAX))),
    h('div', { class: 'pool-hint' }, 'בלי קואורדינטות — אם הקישור של Google Maps כולל מיקום, הוא נלקח ממנו. מקום בלי מיקום פשוט לא מופיע על המפה.'),
    form.err ? h('div', { class: 'linkerr', role: 'alert', text: form.err }) : null,
    h('div', { class: 'itin-formacts' },
      h('button', { type: 'button', class: 'addok', 'data-pact': 'psave', 'data-id': key }, form.isNew ? 'הוספה' : 'שמירה'),
      h('button', { type: 'button', class: 'addcancel', 'data-pact': 'pcancel', 'data-id': key }, 'ביטול')));
}

function renderImport(){
  const box = h('div', { class: 'pool-import', 'data-import': '' });
  box.appendChild(h('div', { class: 'pool-imphead' }, 'ייבוא מ-Google Takeout'));
  box.appendChild(h('ul', { class: 'pool-impwhich' },
    h('li', {}, h('b', {}, 'Saved Places.json'), ' — המקומות שסימנתם בכוכב. ', h('b', {}, 'הקובץ היחיד עם קואורדינטות וכתובת'), ', כלומר עם מפה.'),
    h('li', {}, h('b', {}, 'רשימה שמורה (‎.csv)'), ' — קובץ לכל רשימה (״רוצה ללכת״, רשימות שיצרתם). שם, הערה וקישור בלבד; בדרך כלל ', h('b', {}, 'בלי מיקום'), ' — מפה רק כשבמקרה הקישור כולל אותו.')));
  if (!imp.fresh) {
    box.appendChild(h('label', { class: 'pool-file' }, h('span', {}, 'בחרו קובץ ‎.csv או ‎.json'), h('input', { type: 'file', accept: '.csv,.json,.geojson,text/csv,application/json', 'data-pimport': 'file' })));
  } else {
    const all = imp.fresh.length;
    const keep = chosen(imp);
    const out = imp.fresh.filter(r => !keeps(imp, r));
    const n = keep.length, withC = keep.filter(r => r.coords).length;
    const sel = h('select', { 'data-pimport': 'cat' });
    catIds().forEach(k => sel.appendChild(h('option', { value: k, selected: k === imp.cat }, catLabel(k))));
    box.appendChild(h('div', { class: 'pool-impsum', 'data-impsum': '' },
      h('span', { class: 'mono', text: imp.file }), ' · ',
      `${imp.total} שורות: ${all} חדשים`,
      imp.dupNames.length ? ` · ${imp.dupNames.length} כבר במאגר (לא נוגעים בהם)` : '',
      imp.skipped ? ` · ${imp.skipped} בלי שם (מדלגים)` : ''));
    if (all) {
      box.appendChild(h('label', { class: 'pool-filter' },
        h('input', { type: 'checkbox', 'data-pimport': 'filter', checked: imp.filter }),
        h('span', {}, `רק מדריד והסביבה (עד כ-${AREA_KM} ק״מ)`)));
      const far = out.filter(r => r.area === 'out').length, unknown = out.filter(r => r.area === 'unknown').length;
      const keptUnknown = imp.filter ? keep.filter(r => r.area === 'unknown').length : 0;
      box.appendChild(h('div', { class: 'pool-impcount', 'data-impcount': '' },
        h('b', {}, `נשמרים ${n}`), ` (${withC} עם מיקום)`,
        imp.filter ? ` · מסוננים ${out.length}` : ' · בלי סינון',
        imp.filter && out.length ? ` (${[far ? `${far} מחוץ לאזור` : '', unknown ? `${unknown} בלי מיקום או כתובת` : ''].filter(Boolean).join(', ')})` : ''));
      if (keptUnknown) box.appendChild(h('div', { class: 'pool-hint' }, `${keptUnknown} בלי מיקום וכתובת נשמרו כי זו רשימה של מדריד.`));
      if (imp.filter && out.length) box.appendChild(h('details', { class: 'pool-dups', 'data-impout': '' }, h('summary', {}, 'מה סונן'), h('div', { text: out.map(r => r.name).join(' · ') })));
    }
    if (n && !withC && imp.kind === 'csv') box.appendChild(h('div', { class: 'pool-hint' }, 'לאף מקום שנשמר אין מיקום, כך שלא יהיה להם כפתור מפה. בשביל מפה — Saved Places.json.'));
    if (imp.dupNames.length) box.appendChild(h('details', { class: 'pool-dups' }, h('summary', {}, 'מה כבר קיים'), h('div', { text: imp.dupNames.join(' · ') })));
    if (n) box.appendChild(h('label', { class: 'itin-field' }, h('span', {}, 'לאיזו קטגוריה'), sel));
  }
  if (imp.err) box.appendChild(h('div', { class: 'linkerr', role: 'alert', text: imp.err }));
  box.appendChild(h('div', { class: 'itin-formacts' },
    imp.fresh && chosen(imp).length ? h('button', { type: 'button', class: 'addok', 'data-pact': 'impok', 'data-id': '' }, `ייבוא ${chosen(imp).length}`) : null,
    h('button', { type: 'button', class: 'addcancel', 'data-pact': 'impcancel', 'data-id': '' }, imp.fresh ? 'ביטול' : 'סגירה')));
  return box;
}

function renderDetail(id, on){
  const p = places[id];
  const d = h('div', { class: 'pool-detail' });
  if (p.note) d.appendChild(h('p', { class: 'pool-note', text: String(p.note) }));
  if (p.address) d.appendChild(h('div', { class: 'pool-addr', text: String(p.address) }));
  const href = normalizeUrl(p.url);
  if (href) d.appendChild(h('a', { class: 'itin-link', href, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'rowlink-host', text: linkLabel(href) }), ' ↗'));
  const name = String(p.name || '');
  const acts = h('div', { class: 'pool-acts' },
    pBtn('chips', id, 'הוסף ליום', `שיבוץ "${name}" בימים`, !board.ready(), { 'aria-expanded': String(chipsFor === id) }),
    hasCoords(p) ? pBtn('map', id, 'על המפה', `"${name}" על המפה`) : null,
    pBtn('been', id, p.been ? '✓ היינו' : 'היינו', p.been ? `ביטול הסימון "היינו" של "${name}"` : `סימון "${name}" כמקום שהיינו בו`, false, { 'aria-pressed': String(!!p.been) }),
    pBtn('edit', id, 'עריכה', `עריכת "${name}"`),
    pBtn('del', id, 'מחיקה', `מחיקת "${name}" מההמלצות`));
  d.appendChild(acts);
  if (chipsFor === id) {
    const onDays = on.map(x => x.day);
    const chips = h('div', { class: 'pool-days', role: 'group', 'aria-label': `ימים עבור "${name}"` });
    board.days().forEach(day => chips.appendChild(h('button', {
      type: 'button', class: 'pool-day', 'data-pact': 'day', 'data-id': id, 'data-day': day,
      'aria-pressed': String(onDays.includes(day)), disabled: !board.ready(),
      'aria-label': `${fmtDay(day)} ${weekday(day)}${onDays.includes(day) ? ' (משובץ — לחיצה מסירה)' : ''}`
    }, h('span', { class: 'mono', text: fmtDay(day) }), h('span', { class: 'pool-wd', text: weekday(day).replace('יום ', '') }))));
    d.appendChild(chips);
    d.appendChild(h('div', { class: 'pool-hint' }, 'לחיצה על יום מוסיפה אותו ללוח, לחיצה נוספת מסירה. אפשר כמה ימים.'));
  }
  if (blockDel === id) {
    d.appendChild(h('div', { class: 'itin-confirm pool-block', role: 'alert', 'data-block': id },
      on.length ? `מופיע ב-${on.map(x => fmtDay(x.day)).join(', ')} — הסר משם קודם` : 'הלו״ז לא נטען, אז אי אפשר לבדוק אם המקום משובץ — המחיקה לא בוצעה. רעננו ונסו שוב.',
      h('button', { type: 'button', class: 'delno', 'data-pact': 'delno', 'data-id': id }, 'הבנתי')));
  } else if (confirmDel === id) {
    d.appendChild(h('div', { class: 'itin-confirm' }, `למחוק את "${name}" מההמלצות?`,
      h('button', { type: 'button', class: 'delyes', 'data-pact': 'delyes', 'data-id': id }, 'כן, למחוק'),
      h('button', { type: 'button', class: 'delno', 'data-pact': 'delno', 'data-id': id }, 'לא')));
  }
  return d;
}

function renderPlace(id){
  if (form && !form.isNew && form.id === id) return renderPlaceForm();
  const p = places[id];
  const on = board.placements(id);
  const open = expanded === id;
  const item = h('div', { class: 'pool-item' + (open ? ' open' : '') + (p.been ? ' been' : ''), 'data-place': id, draggable: 'true' });
  item.appendChild(h('button', { type: 'button', class: 'pool-name', 'data-pact': 'expand', 'data-id': id, 'aria-expanded': String(open) },
    h('span', { class: 'pool-n', text: String(p.name || '') }),
    p.hood ? h('span', { class: 'pool-hood', text: String(p.hood) }) : null));
  const marks = h('span', { class: 'pool-marks' });
  if (on.length) marks.appendChild(h('span', { class: 'pool-on', 'data-mark': 'placed', title: 'משובץ בלוח' }, 'משובץ ', h('span', { class: 'mono', text: on.map(x => fmtDay(x.day)).join(', ') })));
  if (p.been) marks.appendChild(h('span', { class: 'pool-been', 'data-mark': 'been' }, '✓ היינו'));
  if (marks.children.length) item.appendChild(marks);
  if (open) item.appendChild(renderDetail(id, on));
  return item;
}

function renderCatForm(){
  const key = catForm.isNew ? 'new' : catForm.id;
  return h('span', { class: 'pool-catform', 'data-cform': key },
    h('input', { type: 'text', 'data-cf': 'label', maxlength: CAT_MAX, value: catForm.vals.label, placeholder: 'שם הקטגוריה', 'aria-label': 'שם הקטגוריה' }),
    h('button', { type: 'button', class: 'addok', 'data-pact': 'catsave', 'data-id': key }, 'שמירה'),
    h('button', { type: 'button', class: 'addcancel', 'data-pact': 'catcancel', 'data-id': key }, 'ביטול'),
    catForm.err ? h('span', { class: 'linkerr', role: 'alert', text: catForm.err }) : null);
}

function renderCat(k){
  const list = idsIn(k);
  const withC = list.filter(id => hasCoords(places[id])).length;
  const wrap = h('div', { class: 'pool-cat', 'data-cat': k });
  const head = h('div', { class: 'pool-cathead' });
  if (catForm && !catForm.isNew && catForm.id === k) head.appendChild(renderCatForm());
  else head.appendChild(h('span', { class: 'pool-catname', text: catLabel(k) }));
  head.appendChild(pBtn('catmap', k, withC ? `מפה · ${withC}/${list.length}` : 'מפה', withC ? `מפה של ${catLabel(k)}: ${withC} מתוך ${list.length} עם מיקום` : `לאף מקום ב${catLabel(k)} אין מיקום`, !withC));
  head.appendChild(pBtn('new', k, '＋ מקום', `הוספת מקום ל${catLabel(k)}`));
  if (isCustom(k) && !(catForm && catForm.id === k)) {
    head.appendChild(pBtn('catrename', k, 'שינוי שם', `שינוי השם של הקטגוריה ${catLabel(k)}`));
    head.appendChild(pBtn('catdel', k, 'מחיקת קטגוריה', `מחיקת הקטגוריה ${catLabel(k)}`));
  }
  wrap.appendChild(head);
  if (catBlock === k) wrap.appendChild(h('div', { class: 'itin-confirm pool-block', role: 'alert' }, `יש בקטגוריה ${countText(list.length)} — העבירו אותם לקטגוריה אחרת קודם.`, h('button', { type: 'button', class: 'delno', 'data-pact': 'catblockok', 'data-id': k }, 'הבנתי')));
  const grid = h('div', { class: 'pool-grid' });
  list.forEach(id => grid.appendChild(renderPlace(id)));
  if (!list.length) grid.appendChild(h('div', { class: 'pool-empty' }, 'עוד אין כאן מקומות.'));
  wrap.appendChild(grid);
  return wrap;
}

function renderBody(){
  const body = h('div', { class: 'pool-body', id: 'placesBody' });
  if (imp) body.appendChild(renderImport());
  if (form && form.isNew) body.appendChild(renderPlaceForm());
  const chips = h('div', { class: 'pool-cats', role: 'group', 'aria-label': 'קטגוריות' });
  catIds().forEach(k => {
    const n = idsIn(k).length;
    chips.appendChild(h('button', { type: 'button', class: 'pool-chip' + (n ? '' : ' empty'), 'data-pact': 'cat', 'data-id': k, 'aria-pressed': String(openCat === k) },
      h('span', { text: catLabel(k) }), h('span', { class: 'pool-chipn mono', text: String(n) })));
  });
  if (catForm && catForm.isNew) chips.appendChild(renderCatForm());
  else chips.appendChild(h('button', { type: 'button', class: 'pool-chip pool-chipadd', 'data-pact': 'catnew', 'data-id': '' }, '＋ קטגוריה'));
  body.appendChild(chips);
  if (openCat) body.appendChild(renderCat(openCat));
  else if (!Object.keys(places).length && !imp && !form) body.appendChild(h('p', { class: 'pool-empty' }, 'הוסיפו מקום ידנית, או ייבאו רשימה שמורה מ-Google Maps.'));
  return body;
}

function render(focusSel){
  const root = $('#places');
  if (!root) return;
  // רינדור שלא ביקש פוקוס (למשל אחרי שינוי בלוח) לא מפיל את הפוקוס מטופס פתוח
  if (!focusSel && root.contains(document.activeElement)) {
    const a = document.activeElement;
    if (a.dataset.pf) focusSel = `[data-pf="${a.dataset.pf}"]`;
    else if (a.dataset.cf) focusSel = `[data-cf="${a.dataset.cf}"]`;
    else if (a.dataset.pact) focusSel = `[data-pact="${a.dataset.pact}"][data-id="${a.dataset.id}"]` + (a.dataset.day ? `[data-day="${a.dataset.day}"]` : '');
  }
  root.textContent = '';
  const linkedDrag = board.dragging();
  root.classList.toggle('dropzone', !!(linkedDrag && linkedDrag.placeId));
  root.classList.toggle('open', isOpen);
  const n = Object.keys(places).length;
  const bar = h('div', { class: 'pool-bar' },
    h('button', { type: 'button', class: 'pool-toggle', 'data-pact': 'toggle', 'data-id': '', 'aria-expanded': String(isOpen), 'aria-controls': 'placesBody' },
      h('span', { class: 'pool-h' }, 'המלצות'),
      h('span', { class: 'pool-count' }, n ? countText(n) : 'עוד אין מקומות'),
      h('span', { class: 'pool-chev', 'aria-hidden': 'true' }, isOpen ? '▴' : '▾')),
    h('span', { class: 'pool-drophint', 'aria-hidden': 'true' }, 'שחררו כאן כדי להסיר מהיום — המקום נשאר בהמלצות'));
  if (isOpen) bar.appendChild(h('span', { class: 'pool-tools' }, pBtn('new', '', '＋ מקום', 'הוספת מקום'), pBtn('import', '', 'ייבוא מ-Google', 'ייבוא רשימה מ-Google Takeout')));
  root.appendChild(bar);
  if (isOpen) root.appendChild(renderBody());
  const f = focusSel && root.querySelector(focusSel);
  if (f) f.focus({ preventScroll: true });
}

function announce(msg){
  const live = $('#placesLive');
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); }
}

/* ---------- פעולות ---------- */
function toggleBeen(id){
  const p = places[id];
  if (!p || loadState !== 'ready') return;
  if (p.been) { delete p.been; delete p.beenOn; }
  else { p.been = true; p.beenOn = new Date().toISOString().slice(0, 10); }
  scheduleSave();
  board.refresh(); // הסימון מופיע גם על הפריטים בלוח (ומרנדר גם את המאגר)
  announce(p.been ? `${p.name}: היינו` : `${p.name}: בוטל "היינו"`);
}

function reveal(id){
  if (!places[id]) return;
  isOpen = true; openCat = catOf(places[id]); expanded = id; chipsFor = null; confirmDel = null; blockDel = null;
  render(`[data-pact="expand"][data-id="${id}"]`);
  const el = $(`#places [data-place="${id}"]`);
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

function openForm(id, at){
  const p = id ? places[id] : null;
  const vals = p
    ? { name: String(p.name || ''), cat: catOf(p), hood: String(p.hood || ''), note: String(p.note || ''), url: String(p.url || ''), coords: hasCoords(p) ? `${p.lat}, ${p.lng}` : '', address: String(p.address || '') }
    : { name: '', cat: at && (BUILTIN[at] || cats[at]) ? at : (openCat || 'other'), hood: '', note: '', url: '', coords: '', address: '' };
  form = { id, isNew: !p, vals, orig: Object.assign({}, vals), err: '' };
  if (p) expanded = id;
  imp = null; confirmDel = null; blockDel = null;
  render(`[data-pform="${p ? id : 'new'}"] [data-pf="name"]`);
}

function savePlaceForm(){
  const v = form.vals;
  const key = form.isNew ? 'new' : form.id;
  const fail = msg => { form.err = msg; render(`[data-pform="${key}"] [data-pf="name"]`); };
  const name = v.name.trim(), url = v.url.trim(), coordsText = v.coords.trim();
  if (!name) return fail('צריך שם.');
  if (url && !normalizeUrl(url)) return fail('הקישור לא תקין — רק http/https, בלי רווחים.');
  let coords = null;
  if (coordsText) {
    coords = parseCoords(coordsText);
    if (!coords) return fail('קואורדינטות בפורמט "40.4168, -3.7038" (קו רוחב, קו אורך).');
    // הקישור הוחלף והקואורדינטות לא נגעו בהן — מיקום מהקישור החדש, אם יש בו
    if (url !== form.orig.url.trim() && coordsText === form.orig.coords) coords = coordsFromUrl(url) || coords;
  } else coords = coordsFromUrl(url);
  if (form.isNew && Object.keys(places).length >= POOL_MAX) return fail(`המאגר מלא (${POOL_MAX} מקומות).`);
  const id = form.isNew ? newId('p_') : form.id;
  const entry = Object.assign({}, places[id] || { createdAt: Date.now(), source: 'manual' }, {
    name: name.slice(0, NAME_MAX), cat: BUILTIN[v.cat] || cats[v.cat] ? v.cat : 'other',
    hood: v.hood.trim().slice(0, HOOD_MAX), note: v.note.trim().slice(0, NOTE_MAX), url: url.slice(0, URL_MAX)
  });
  const address = v.address.trim().slice(0, ADDR_MAX);
  if (address) entry.address = address; else delete entry.address;
  if (coords) { entry.lat = coords.lat; entry.lng = coords.lng; } else { delete entry.lat; delete entry.lng; }
  places[id] = entry;
  form = null; openCat = entry.cat; expanded = id;
  scheduleSave();
  board.refresh(); // שם/הערה חדשים מופיעים בכל הימים שהמקום משובץ בהם
  render(`[data-pact="expand"][data-id="${id}"]`);
  announce(`נשמר: ${entry.name}`);
}

function saveCatForm(){
  const key = catForm.isNew ? 'new' : catForm.id;
  const label = catForm.vals.label.trim().slice(0, CAT_MAX);
  const fail = msg => { catForm.err = msg; render(`[data-cform="${key}"] [data-cf="label"]`); };
  if (!label) return fail('צריך שם.');
  const taken = catIds().some(k => k !== catForm.id && catLabel(k).trim() === label);
  if (taken) return fail('כבר יש קטגוריה בשם הזה.');
  let id = catForm.id;
  if (catForm.isNew) { id = newId('c_'); cats[id] = { label, createdAt: Date.now() }; }
  else cats[id] = Object.assign({}, cats[id], { label });
  catForm = null; openCat = id;
  scheduleSave();
  board.refresh();
  render(`[data-pact="cat"][data-id="${id}"]`);
  announce(`קטגוריה: ${label}`);
}

function doImport(){
  const rows = imp && imp.fresh ? chosen(imp) : [];
  if (!rows.length) return;
  if (Object.keys(places).length + rows.length > POOL_MAX) { imp.err = `יותר מדי מקומות — המאגר מוגבל ל-${POOL_MAX}.`; return render('[data-pact="impcancel"]'); }
  const cat = BUILTIN[imp.cat] || cats[imp.cat] ? imp.cat : 'other';
  const now = Date.now();
  rows.forEach((r, i) => {
    const entry = { name: r.name, cat, hood: '', note: r.note, url: r.url, createdAt: now + i, source: imp.kind === 'json' ? 'takeout-json' : 'takeout-csv' };
    if (r.address) entry.address = r.address;
    if (r.coords) { entry.lat = r.coords.lat; entry.lng = r.coords.lng; }
    places[newId('p_', i)] = entry;
  });
  const n = rows.length;
  imp = null; openCat = cat; expanded = null;
  scheduleSave();
  board.refresh();
  render(`[data-pact="cat"][data-id="${cat}"]`);
  announce(`יובאו ${countText(n)} ל${catLabel(cat)}`);
}

function onAct(act, id, el){
  if (loadState !== 'ready') return;
  if (act === 'toggle') {
    isOpen = !isOpen;
    if (!isOpen) { form = null; catForm = null; imp = null; confirmDel = null; blockDel = null; catBlock = null; chipsFor = null; }
    return render('.pool-toggle');
  }
  if (act === 'cat') {
    openCat = openCat === id ? null : id;
    expanded = null; chipsFor = null; confirmDel = null; blockDel = null; catBlock = null;
    if (form && !form.isNew) form = null;
    return render(`[data-pact="cat"][data-id="${id}"]`);
  }
  if (act === 'new') { isOpen = true; if (id) openCat = id; return openForm(null, id || null); }
  if (act === 'psave') return savePlaceForm();
  if (act === 'pcancel') {
    const back = form && !form.isNew ? form.id : null;
    form = null;
    return render(back ? `[data-pact="expand"][data-id="${back}"]` : '.pool-toggle');
  }
  if (act === 'import') { imp = { err: '' }; form = null; return render('[data-pimport="file"]'); }
  if (act === 'impcancel') { imp = null; return render('[data-pact="import"]'); }
  if (act === 'impok') return doImport();
  if (act === 'catnew') { catForm = { id: null, isNew: true, vals: { label: '' }, err: '' }; return render('[data-cform="new"] [data-cf="label"]'); }
  if (act === 'catrename' && isCustom(id)) { catForm = { id, isNew: false, vals: { label: catLabel(id) }, err: '' }; return render(`[data-cform="${id}"] [data-cf="label"]`); }
  if (act === 'catsave') return catForm && saveCatForm();
  if (act === 'catcancel') { const back = catForm && !catForm.isNew ? catForm.id : null; catForm = null; return render(back ? `[data-pact="catrename"][data-id="${back}"]` : '[data-pact="catnew"]'); }
  if (act === 'catmap') {
    const list = idsIn(id);
    const withC = list.filter(x => hasCoords(places[x]));
    return withC.length && openMap(withC, catLabel(id), list.length - withC.length);
  }
  if (act === 'catdel' && isCustom(id)) {
    if (idsIn(id).length) { catBlock = id; return render('[data-pact="catblockok"]'); }
    const label = catLabel(id);
    delete cats[id]; openCat = null; catBlock = null;
    scheduleSave();
    render('[data-pact="catnew"]');
    return announce(`הקטגוריה ${label} נמחקה`);
  }
  if (act === 'catblockok') { catBlock = null; return render(`[data-pact="catdel"][data-id="${id}"]`); }
  const p = places[id];
  if (!p) return;
  if (act === 'expand') {
    expanded = expanded === id ? null : id;
    chipsFor = null; confirmDel = null; blockDel = null;
    return render(`[data-pact="expand"][data-id="${id}"]`);
  }
  if (act === 'chips') { chipsFor = chipsFor === id ? null : id; return render(chipsFor ? `[data-pact="day"][data-id="${id}"]` : `[data-pact="chips"][data-id="${id}"]`); }
  if (act === 'day') {
    const day = el.dataset.day;
    const on = board.placements(id).find(x => x.day === day);
    if (on) board.remove(on.id); else board.add(id, day);
    return render(`[data-pact="day"][data-id="${id}"][data-day="${day}"]`);
  }
  if (act === 'map') return hasCoords(p) && openMap([id], String(p.name || ''), 0);
  if (act === 'been') { toggleBeen(id); return render(`[data-pact="been"][data-id="${id}"]`); }
  if (act === 'edit') return openForm(id);
  if (act === 'del') {
    // משובץ, או שהלו"ז לא נטען ואי אפשר לדעת — לא מוחקים
    if (!board.ready() || board.placements(id).length) { blockDel = id; confirmDel = null; return render(`[data-block="${id}"] .delno`); }
    confirmDel = id; blockDel = null;
    return render(`[data-pact="delno"][data-id="${id}"]`);
  }
  if (act === 'delno') { confirmDel = null; blockDel = null; return render(`[data-pact="del"][data-id="${id}"]`); }
  if (act === 'delyes') {
    if (!board.ready() || board.placements(id).length) { blockDel = id; confirmDel = null; return render(`[data-block="${id}"] .delno`); }
    const name = p.name, cat = catOf(p);
    delete places[id]; confirmDel = null; expanded = null; chipsFor = null;
    scheduleSave();
    render(`[data-pact="cat"][data-id="${cat}"]`);
    return announce(`נמחק מההמלצות: ${name}`);
  }
}

/* ---------- מפה (Leaflet + OpenStreetMap, בלי מפתח) ---------- */
let leafletP = null;
let map = null;
let layer = null;
function loadLeaflet(){
  if (window.L) return Promise.resolve(window.L);
  if (!leafletP) {
    leafletP = new Promise((resolve, reject) => {
      const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: LEAFLET.css, integrity: LEAFLET.cssSri, crossOrigin: '' });
      document.head.appendChild(css);
      const s = Object.assign(document.createElement('script'), { src: LEAFLET.js, integrity: LEAFLET.jsSri, crossOrigin: '' });
      s.onload = () => resolve(window.L);
      s.onerror = () => { leafletP = null; s.remove(); reject(new Error('leaflet failed to load')); };
      document.head.appendChild(s);
    });
  }
  return leafletP;
}

function popupFor(id){
  const p = places[id];
  const on = board.placements(id);
  const el = h('div', { class: 'pool-pop', dir: 'rtl' }, h('b', { text: String(p.name || '') }));
  const sub = [p.hood, catLabel(catOf(p))].filter(Boolean).join(' · ');
  if (sub) el.appendChild(h('div', { text: sub }));
  if (on.length) el.appendChild(h('div', {}, 'משובץ ', h('span', { class: 'mono', text: on.map(x => fmtDay(x.day)).join(', ') })));
  if (p.been) el.appendChild(h('div', { class: 'pool-been' }, '✓ היינו'));
  const href = normalizeUrl(p.url);
  if (href) el.appendChild(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, h('span', { class: 'rowlink-host', text: linkLabel(href) }), ' ↗'));
  return el;
}

function openMap(ids, title, missing){
  const dlg = $('#placesMap'), box = $('#placesMapBox'), status = $('#placesMapStatus');
  if (!dlg || !box) return;
  $('#placesMapTitle').textContent = title;
  $('#placesMapNote').textContent = missing ? `${missing === 1 ? 'מקום אחד' : missing + ' מקומות'} בלי מיקום לא מוצגים` : '';
  status.textContent = 'טוען את המפה…';
  status.hidden = false;
  if (!dlg.open) dlg.showModal();
  return loadLeaflet().then(L => {
    if (!map) {
      map = L.map(box);
      L.tileLayer(TILES, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
      layer = L.layerGroup().addTo(map);
    }
    layer.clearLayers();
    const color = getComputedStyle(document.documentElement).getPropertyValue('--rojo').trim();
    const pts = [];
    let first = null;
    ids.filter(id => hasCoords(places[id])).forEach(id => {
      const p = places[id];
      const m = L.circleMarker([p.lat, p.lng], { radius: 8, color, weight: 2, fillColor: color, fillOpacity: p.been ? 0.3 : 0.8 })
        .bindPopup(popupFor(id)).addTo(layer);
      if (!first) first = m;
      pts.push([p.lat, p.lng]);
    });
    map.invalidateSize();
    if (pts.length === 1) { map.setView(pts[0], 16); first.openPopup(); }
    else if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 16 });
    status.hidden = true;
    box.dataset.markers = String(pts.length);
  }).catch(err => {
    console.error('madrid-trip: map failed to load', err);
    status.textContent = 'המפה לא נטענה (אין חיבור?). סגרו ונסו שוב.';
  });
}

function wireMap(){
  const dlg = $('#placesMap');
  if (!dlg) return;
  dlg.addEventListener('click', e => {
    if (e.target === dlg || e.target.closest('[data-mapclose]')) dlg.close(); // לחיצה על הרקע סוגרת
  });
}

function wire(){
  const root = $('#places');
  if (!root) return;
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-pact]');
    if (b && root.contains(b)) onAct(b.dataset.pact, b.dataset.id, b);
  });
  const keep = e => {
    const f = e.target.closest('[data-pf]');
    if (f && form) form.vals[f.dataset.pf] = f.value;
    const c = e.target.closest('[data-cf]');
    if (c && catForm) catForm.vals[c.dataset.cf] = c.value;
    if (e.target.dataset.pimport === 'cat' && imp) imp.cat = e.target.value;
  };
  // מתג הסינון משנה את התצוגה המקדימה מיד (שום דבר לא נכתב עד "ייבוא")
  root.addEventListener('change', e => {
    if (e.target.dataset.pimport !== 'filter' || !imp || !imp.fresh) return;
    imp.filter = e.target.checked;
    render('[data-pimport="filter"]');
  });
  root.addEventListener('input', keep);
  root.addEventListener('change', e => {
    keep(e);
    const file = e.target.dataset.pimport === 'file' && e.target.files && e.target.files[0];
    if (!file || !imp) return;
    file.text().then(text => {
      if (!imp) return;
      try { imp = prepareImport(file.name, text); }
      catch (err) { console.error('madrid-trip: import parse failed', err); imp = { err: err.message || 'הקובץ לא נקרא.' }; }
      render(imp.fresh && chosen(imp).length ? '[data-pact="impok"]' : '[data-pact="impcancel"]');
    }, err => {
      console.error('madrid-trip: import read failed', err);
      imp = { err: 'הקובץ לא נקרא.' };
      render('[data-pact="impcancel"]');
    });
  });
  root.addEventListener('keydown', e => {
    if (e.target.closest('[data-cform]') && catForm) {
      if (e.key === 'Escape') { e.preventDefault(); onAct('catcancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); onAct('catsave'); }
      return;
    }
    if (!form || !e.target.closest('[data-pform]')) return;
    if (e.key === 'Escape') { e.preventDefault(); onAct('pcancel'); }
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); onAct('psave'); }
  });

  /* גרירה: מקום מהמאגר אל יום בלוח (itinerary.js מקבל אותו דרך
     board.setPlaceDrag), ופריט מההמלצות מהלוח אל המאגר = הסרה מהיום. */
  root.addEventListener('dragstart', e => {
    const it = e.target.closest && e.target.closest('[data-place]');
    if (!it) return;
    if (loadState !== 'ready' || !board.ready() || e.target.closest('a, input, textarea, select')) { e.preventDefault(); return; }
    board.setPlaceDrag(it.dataset.place);
    it.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', String(places[it.dataset.place].name || ''));
  });
  root.addEventListener('dragend', () => {
    board.setPlaceDrag(null);
    root.querySelectorAll('.dragging').forEach(x => x.classList.remove('dragging'));
  });
  const linkedDrag = () => { const d = board.dragging(); return d && d.placeId ? d : null; };
  root.addEventListener('dragover', e => {
    if (!linkedDrag() || loadState !== 'ready') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  root.addEventListener('drop', e => {
    const d = linkedDrag();
    if (!d) return;
    e.preventDefault();
    board.endDrag(); // הפריט שנגרר נעלם בשחרור, אז dragend שלו לא יגיע
    root.classList.remove('dropzone');
    board.remove(d.id);
  });
  // ה-listener של הלוח רץ קודם (#itin), אז כאן כבר ידוע מה נגרר
  document.addEventListener('dragstart', () => { const d = linkedDrag(); if (d) root.classList.add('dropzone'); });
  document.addEventListener('dragend', () => root.classList.remove('dropzone'));

  // המאגר נדבק מתחת ל-nav הדביק של התיק
  const nav = document.querySelector('nav');
  const setTop = () => document.documentElement.style.setProperty('--pool-top', (nav ? nav.offsetHeight : 0) + 'px');
  setTop();
  window.addEventListener('resize', setTop);
}

/* ---------- שמירה (הדפוס של itinerary.js) ---------- */
function loadLocal(){
  try { return JSON.parse(localStorage.getItem(STORE_KEY)); }
  catch (e) { console.error('madrid-trip: places local copy unreadable', e); return null; }
}

function saveLocal(state){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { console.error('madrid-trip: places local save failed', e); }
}

let docRef = null;
let saveTimer = null;

/* אותם ארבעה מצבים כמו ב-itinerary.js. inert רק על המאגר עצמו. */
let loadState = 'pending';
const LOAD_MSG = {
  pending: 'טוען את ההמלצות…',
  failed: 'טעינת ההמלצות מהשרת נכשלה. מוצג העותק האחרון שנשמר במכשיר הזה, לקריאה בלבד — שום שינוי לא יישמר. רעננו את הדף כדי לנסות שוב.',
  failedNoLocal: 'טעינת ההמלצות מהשרת נכשלה ואין עותק שמור במכשיר הזה — לקריאה בלבד. רעננו את הדף כדי לנסות שוב.',
  conflict: 'ההמלצות השתנו במכשיר אחר — רענן'
};
function setLoadState(state, msgKey){
  loadState = state;
  const blocked = state !== 'ready';
  const root = $('#places');
  if (root) root.inert = blocked;
  const banner = $('#placesBanner');
  if (banner) {
    banner.hidden = !blocked;
    banner.textContent = LOAD_MSG[msgKey || state];
    banner.classList.toggle('failed', state === 'failed' || state === 'conflict');
  }
  board.refresh(); // "היינו" בלוח זמין רק כשההמלצות מוכנות
}

const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x);
const docCanon = snap => (snap.exists() ? canon(snap.data()) : null);
const CONFLICT = new Error('places doc changed since this page loaded');
let lastKnown = null;
let saveChain = Promise.resolve();
let savePending = false;

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
      console.error('madrid-trip: places save refused, the doc changed on another device');
      setLoadState('conflict');
    } else {
      console.error('madrid-trip: places save failed', err);
    }
  }).finally(() => {
    if (!saveTimer) savePending = false;
  });
}

function scheduleSave(){
  if (loadState !== 'ready') return;
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
      console.error('madrid-trip: the places doc changed on another device');
      setLoadState('conflict');
    }
  }).catch(err => console.error('madrid-trip: places remote change check failed', err));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkRemote(); });
window.addEventListener('focus', checkRemote);

board.connect({
  ready: () => loadState === 'ready',
  get: pid => places[pid] || null,
  catLabel: pid => (places[pid] ? catLabel(catOf(places[pid])) : ''),
  hasCoords: pid => hasCoords(places[pid]),
  toggleBeen,
  openMap: pid => places[pid] && hasCoords(places[pid]) && openMap([pid], String(places[pid].name || ''), 0),
  reveal
});
board.onRender(() => render());

applyState({});
wire();
wireMap();
setLoadState('pending');

onAuthStateChanged(auth, function(user){
  if (!user) return; // assets/auth-guard.js כבר מטפל בהפניה להתחברות

  docRef = doc(db, 'users', user.uid, 'state', 'places');

  getDoc(docRef).then(function(snap){
    lastKnown = docCanon(snap);
    applyState(snap.exists() ? snap.data() : (loadLocal() || {}));
    setLoadState('ready');
  }).catch(function(err){
    console.error('madrid-trip: places getDoc failed', err);
    const local = loadLocal();
    applyState(local || {});
    setLoadState('failed', local ? 'failed' : 'failedNoLocal');
  });
});

// לבדיקות בלבד (tests/places-checks.js): הפענוח של הייבוא בלי קובץ אמיתי
export const __test = { parseCsv, rowsFromCsv, rowsFromJson, coordsFromUrl, parseCoords, nameFromUrl, prepareImport, areaOf, distKm };
