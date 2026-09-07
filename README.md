# מדריד · נובמבר 2026

**גרסה: v1.3**

תיק תכנון לטיול. אתר סטטי על GitHub Pages, מוגן בהתחברות, עם Firestore
לסנכרון רשימת המשימות ומחשבון התקציב בין מכשירים.

## פתיחה

**לא עובד בלחיצה כפולה על הקובץ** — Firebase Auth דורש שרת אמיתי
(http/https), לא `file://`. להרצה מקומית:

```bash
cd madrid-trip
python3 -m http.server 8000
```

ואז לפתוח `http://localhost:8000`. בלי משתמש מחובר, כל הדפים מפנים
אוטומטית ל-`login.html`.

## התחברות

אימייל+סיסמה בלבד, בלי הרשמה עצמית באתר. משתמש חדש נוצר ידנית ב-
Firebase Console → Authentication → Users.

## עריכה

| רוצה לשנות | הקובץ |
|---|---|
| צבעים, גופנים, מרווחים | `assets/styles.css` — הכל ב-`:root` בראש הקובץ |
| מספרי ברירת המחדל בתקציב | `assets/budget.js` — האובייקט `PRESETS` |
| תוכן התיק | `dossier.html` |
| רשימת המשימות | `dossier.html`, החלק בסוף עם `data-c` — הסימונים עצמם נשמרים ב-Firestore, לא בקובץ |
| config של Firebase | `assets/firebase-init.js` |
| כללי אבטחה של Firestore | מעדכנים בקונסולה (Firestore → Rules), ואז מעתיקים ל-`firestore.rules` לתיעוד — אין פריסה אוטומטית |

## ייצוא ל-PDF

לפתוח את `dossier.html` בדפדפן, `Cmd/Ctrl + P`, ולבחור שמירה כ-PDF.
בהגדרות ההדפסה כדאי לסמן "גרפיקת רקע" כדי שהצבעים יישמרו.

## עבודה עם Claude Code

```bash
cd madrid-trip
claude
```

יש בתיקייה `CLAUDE.md` עם ההקשר והמוסכמות, שנטען אוטומטית בכל שיחה.
