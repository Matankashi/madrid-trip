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
const GLOBAL_IDS = ['days','nights','rate'];
const STORE_KEY = 'madrid.budget.v1';
const DEBOUNCE_MS = 800;

const PRESETS = {
  lean:{flight:230,airport:12,nightly:58,daily:32,barca:140,ucl:45,tour:25,metro:35,trip:30,tripCount:2,museums:55,misc:120},
  mid: {flight:330,airport:12,nightly:95,daily:55,barca:250,ucl:70,tour:25,metro:55,trip:60,tripCount:2,museums:130,misc:200},
  rich:{flight:480,airport:70,nightly:165,daily:95,barca:420,ucl:120,tour:60,metro:130,trip:110,tripCount:2,museums:220,misc:350}
};
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
const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const num = el => { const v = parseFloat(el.value); return isNaN(v) || v < 0 ? 0 : v; };
const eur = n => '€' + Math.round(n).toLocaleString('en-US');

function lineValue(id){
  const inp = document.querySelector(`[data-in="${id}"]`);
  if(!inp) return 0;
  if(id in toggles && !toggles[id]) return 0;
  const v = num(inp);
  if(id === 'nightly') return v * num($('#nights'));
  if(id === 'daily')   return v * num($('#days'));
  if(id === 'trip')    return v * num(document.querySelector('[data-in="tripCount"]'));
  return v;
}

function render(){
  const totals = {};
  let grand = 0;
  GROUPS.forEach(g => {
    let sum = 0;
    g.items.forEach(id => {
      const v = lineValue(id);
      const cell = document.querySelector(`[data-amt="${id}"]`);
      if(cell) cell.textContent = eur(v);
      sum += v;
    });
    totals[g.key] = sum;
    grand += sum;
  });

  Object.keys(toggles).forEach(id => {
    const row = document.querySelector(`[data-item="${id}"]`);
    if(row) row.classList.toggle('off', !toggles[id]);
  });

  const days = Math.max(1, num($('#days')));
  const core = lineValue('nightly') + lineValue('daily');

  $('#totEur').textContent  = eur(grand);
  $('#footEur').textContent = eur(grand);
  $('#perDay').textContent  = eur(grand / days);
  $('#coreDay').textContent = eur(core / days);

  const r = num($('#rate')) || 4.05;
  const ils = '≈ ₪' + Math.round(grand * r).toLocaleString('en-US');
  $('#totIls').textContent  = ils;
  $('#footIls').textContent = ils;

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
}

function applyTier(t){
  const p = PRESETS[t];
  Object.entries(p).forEach(([k, v]) => {
    const inp = document.querySelector(`[data-in="${k}"]`);
    if(inp) inp.value = v;
  });
  $$('.tier').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tier === t)));
  render();
}

// ברירות המחדל שכבר ב-HTML, נלכדות לפני שכל נתון שמור נטען — הן
// רשת הביטחון כששדה קיים ב-DOM אבל חסר במסמך השמור (data-c חדש
// שנוסף אחרי שהמסמך נכתב בפעם האחרונה).
const defaults = {values: {}, toggles: Object.assign({}, toggles)};
FIELD_IDS.forEach(id => { const el = $(`[data-in="${id}"]`); if (el) defaults.values[id] = el.value; });
GLOBAL_IDS.forEach(id => { const el = $(`#${id}`); if (el) defaults.values[id] = el.value; });

function getState(){
  const values = {};
  FIELD_IDS.forEach(id => { const el = $(`[data-in="${id}"]`); if (el) values[id] = el.value; });
  GLOBAL_IDS.forEach(id => { const el = $(`#${id}`); if (el) values[id] = el.value; });
  return { values, toggles: Object.assign({}, toggles) };
}

function applyState(data){
  const values = (data && data.values) || {};
  const savedToggles = (data && data.toggles) || {};
  FIELD_IDS.forEach(id => {
    const el = $(`[data-in="${id}"]`);
    if (el) el.value = values[id] !== undefined ? values[id] : defaults.values[id];
  });
  GLOBAL_IDS.forEach(id => {
    const el = $(`#${id}`);
    if (el) el.value = values[id] !== undefined ? values[id] : defaults.values[id];
  });
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
    setDoc(docRef, getState()).catch(function(){ /* אופליין — כבר נשמר ב-localStorage */ });
  }, DEBOUNCE_MS);
}

$$('.tier').forEach(b => b.addEventListener('click', () => { applyTier(b.dataset.tier); scheduleSave(); }));
$$('.tog').forEach(b => b.addEventListener('click', () => {
  const k = b.dataset.tog;
  toggles[k] = !toggles[k];
  b.setAttribute('aria-pressed', String(toggles[k]));
  render();
  scheduleSave();
}));
document.addEventListener('input', e => {
  if(e.target.matches('input[type=number]')) { render(); scheduleSave(); }
});

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
  }).catch(function(){
    if (userEdited) return;
    const local = loadLocal();
    if (local) applyState(local);
  });
});
