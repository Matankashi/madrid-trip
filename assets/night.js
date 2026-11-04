/* מצב לילה: 20:00–08:00 לפי השעון של המכשיר, אוטומטי, בלי מתג ובלי שמירה.
   נטען כסקריפט רגיל (לא module) ב-<head> לפני גיליון הסגנון, כדי שדף שנפתח
   בלילה לא יהבהב בהיר. הצבעים עצמם: :root[data-theme="night"] ב-styles.css. */
(function () {
  function apply() {
    var h = new Date().getHours();
    var night = h >= 20 || h < 8;
    var root = document.documentElement;
    if (night) root.setAttribute('data-theme', 'night');
    else root.removeAttribute('data-theme');
  }
  apply();
  // דף פתוח שעובר את 20:00 או 08:00 מתחלף לבד. טיימר מושהה בשינה ובלשונית
  // ברקע, לכן בודקים גם בחזרה לדף (כולל מטמון חזרה-אחורה של הדפדפן).
  setInterval(apply, 30000);
  document.addEventListener('visibilitychange', apply);
  window.addEventListener('focus', apply);
  window.addEventListener('pageshow', apply);
})();
