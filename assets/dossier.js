/* הפרקים המכווצים בתיק (v1.31). כל פרק טקסט אחרי הלוח הוא <details> בתוך
   <section id> — שורה אחת, סגור כברירת מחדל, נפתח בלחיצה (בלי JS). הקובץ
   הזה רק דואג שקישור לפרק (בניווט, או כתובת עם #) יפתח אותו: הלחיצה
   פותחת לפני שהדפדפן גולל, אז הגלילה נוחתת על פרק פתוח. מצב הפתיחה לא
   נשמר. בהדפסה (ייצוא ל-PDF, ראו README) כל הפרקים נפתחים, ואחריה חוזרים
   למצב שהיו בו. (עד v1.30 כאן הייתה רשימת המשימות, פרק 09 — נמחקה; המסמך
   state/checklist נשאר ב-Firestore כמו שהוא ולא נקרא יותר.) */

function openTarget(hash){
  if (!hash || hash.length < 2) return;
  let id;
  try { id = decodeURIComponent(hash.slice(1)); } catch (e) { console.error('madrid-trip: bad section hash', hash, e); return; }
  const sec = document.getElementById(id);
  const d = sec && sec.querySelector(':scope > details');
  if (d) d.open = true;
}

document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href^="#"]');
  if (a) openTarget(a.getAttribute('href'));
});
window.addEventListener('hashchange', () => openTarget(location.hash));
openTarget(location.hash);

let printed = [];
window.addEventListener('beforeprint', () => {
  printed = [...document.querySelectorAll('section.fold > details:not([open]), details.fold-note:not([open])')];
  printed.forEach(d => { d.open = true; });
});
window.addEventListener('afterprint', () => { printed.forEach(d => { d.open = false; }); printed = []; });
