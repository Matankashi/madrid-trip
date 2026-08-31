/* רשימת המשימות בתיק הטיול.
   מקור האמת הוא Firestore, ב-/users/{uid}/state/checklist — מסונכרן
   בזמן אמת בין מכשירים. כל שינוי גם נשמר מיד ב-localStorage כגיבוי
   אופליין: אם אין רשת, קוראים משם; אם הרשת חוזרת, הכתיבה הבאה
   מתעדכנת ל-Firestore כרגיל. הכתיבות ל-Firestore מבוצעות ב-debounce
   כדי לא לשלוח בקשה על כל קליק. הטעינה מתחילה רק אחרי שהאימות נפתר
   (onAuthStateChanged) — לפני זה אין עדיין uid לבנות ממנו את הנתיב. */

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const STORE_KEY = 'madrid.checklist.v1';
const DEBOUNCE_MS = 800;

function loadLocal(){
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch (e) { return {}; }
}

function saveLocal(state){
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { /* אחסון חסום — ממשיכים בלי שמירה מקומית */ }
}

const items = document.querySelectorAll('[data-c]');
let state = {};
let docRef = null;
let saveTimer = null;
let remoteLoaded = false;

function render(){
  items.forEach(function(el, i){
    el.classList.toggle('on', !!state['item' + i]);
  });
}

function scheduleSave(){
  saveLocal(state);
  if (!docRef) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    setDoc(docRef, state).catch(function(){ /* אופליין — כבר נשמר ב-localStorage */ });
  }, DEBOUNCE_MS);
}

items.forEach(function(el, i){
  const key = 'item' + i;
  el.addEventListener('click', function(){
    el.classList.toggle('on');
    state[key] = el.classList.contains('on');
    scheduleSave();
  });
});

onAuthStateChanged(auth, function(user){
  if (!user) return; // assets/auth-guard.js כבר מטפל בהפניה להתחברות

  docRef = doc(db, 'users', user.uid, 'state', 'checklist');

  onSnapshot(docRef, function(snap){
    if (snap.exists()) {
      state = snap.data();
    } else if (!remoteLoaded) {
      state = loadLocal(); // ריצה ראשונה למשתמש הזה — מעבירים סימונים ישנים מ-localStorage
    }
    remoteLoaded = true;
    saveLocal(state);
    render();
  }, function(){
    if (remoteLoaded) return;
    state = loadLocal();
    remoteLoaded = true;
    render();
  });
});
