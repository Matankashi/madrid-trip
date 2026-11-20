/* Browser checks for the itinerary in dossier.html (#plan, assets/itinerary.js).
   No framework, no build step.

   HOW TO RUN (against a scratch doc, never the real one)
   1. python3 tests/serve-test.py            (itinerary.js -> state/itinerary_test,
                                              dossier.js  -> state/checklist_test)
   2. Open http://localhost:8000/dossier.html in a Chrome that is signed in.
   3. In the console (or via automation) — each phase reseeds itself:
        const t = await import('/tests/itinerary-checks.js');
        await t.phaseMain();     // seed render, colours, edit, move, reorder, drag, add, delete, reload
        await t.phaseGuard();    // another tab/device changed the doc -> refuse to save
        await t.phaseLoad();     // slow/failed load, local fallback, unknown fields kept
        await t.phaseChecklist(); // the 3 remaining tasks keep their marks (checklist_test)
        await t.phaseCollapse(); // blocks of 4: default by date, toggle, remember, drag onto collapsed
        await t.dropTestDoc();   // deletes itinerary_test + the local test copy
   The board's collapse state lives in localStorage (madrid.itinerary.view.test
   under serve-test.py). open() opens every block first unless told otherwise,
   so the layout/drag checks see all 30 cards; "today" is pinned to 14.11
   (?today=YYYY-MM-DD overrides).
   Every phase returns {passed, failed, failures:[...]} and checks at the end
   that the real state/itinerary doc is byte-identical to before (read only).
   The automation tab is often hidden (throttled timers): start a phase with
   .then(x => window.__R = x) and poll instead of awaiting inline. */

import { db, auth } from '/assets/firebase-init.js';
import { doc, getDoc, setDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCAL_KEY = 'madrid.itinerary.test';
const MSG_CONFLICT = 'השתנה במכשיר אחר — רענן';
const canonJson = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
const isInert = el => !!el && !!el.closest('[inert]');
const D = n => `2026-11-${String(n).padStart(2, '0')}`;
const VIEW_KEY = 'madrid.itinerary.view.test';
const BLOCK_IDS = [1, 5, 9, 13, 15, 19, 23, 27].map(D);
// view: 'all' = every block open, 'none' = all collapsed, null = leave what is stored (or nothing = default)
function setView(view) {
  if (view === null) return;
  if (view === 'clear') { localStorage.removeItem(VIEW_KEY); return; }
  localStorage.setItem(VIEW_KEY, JSON.stringify({ open: Object.fromEntries(BLOCK_IDS.map(b => [b, view === 'all'])) }));
}
const storedView = () => { try { return (JSON.parse(localStorage.getItem(VIEW_KEY)) || {}).open || {}; } catch (e) { return {}; } };
// the cards are what goes read-only now (headers + compact lines stay usable)
const cardsInert = p => { const b = p.qa('#itin [data-bbody]'); return b.length > 0 && b.every(isInert); };
const cardsFree = p => p.qa('#itin [data-bbody]').every(x => !isInert(x));
const openBlocks = p => p.qa('#itin [data-block]').filter(b => !b.querySelector('[data-bbody]').hidden).map(b => b.dataset.block);

async function guard() {
  const src = await (await fetch('/assets/itinerary.js', { cache: 'no-store' })).text();
  const chk = await (await fetch('/assets/dossier.js', { cache: 'no-store' })).text();
  if (!src.includes("'state', 'itinerary_test')") || !chk.includes("'state', 'checklist_test')")) {
    throw new Error('dossier scripts are not served by tests/serve-test.py - refusing to run');
  }
  if (!src.includes('__loadDoc(docRef)')) throw new Error('serve-test.py load hook missing - restart the test server');
}
const ref = () => doc(db, 'users', auth.currentUser.uid, 'state', 'itinerary_test');
const realRef = () => doc(db, 'users', auth.currentUser.uid, 'state', 'itinerary');
const realSnap = async () => { const s = await getDoc(realRef()); return s.exists() ? canonJson(s.data()) : null; };

function reporter() {
  const failures = []; let passed = 0;
  return {
    ok(name, cond, detail) { if (cond) passed++; else failures.push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`); },
    result() { return { passed, failed: failures.length, failures }; }
  };
}

function openFrame(query, width = 1300) {
  return new Promise(resolve => {
    const f = document.createElement('iframe');
    f.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:900px;opacity:0;pointer-events:none`;
    f.onload = () => resolve(f);
    f.src = '/dossier.html?' + query;
    document.body.appendChild(f);
  });
}
// a page handle: waits until the load settled (banner hidden, or a failed/conflict message)
async function open(query = '', wait = true, width, view = 'all') {
  setView(view);
  const f = await openFrame(query, width);
  const w = f.contentWindow, qq = s => w.document.querySelector(s), qa = s => [...w.document.querySelectorAll(s)];
  const p = { f, w, qq, qa };
  if (wait) for (let i = 0; i < 60 && !settled(p); i++) await sleep(200);
  return p;
}
const settled = p => { const b = p.qq('#itinBanner'); return b && (b.hidden || b.classList.contains('failed')); };
const idle = p => !p.w.__itinIdle || p.w.__itinIdle();
const waitIdle = async (...ps) => { await sleep(300); for (let i = 0; i < 80 && !ps.every(idle); i++) await sleep(150); };
const docWhen = async pred => { let d; for (let i = 0; i < 40; i++) { await sleep(250); const s = await getDoc(ref()); d = s.exists() ? s.data() : undefined; if (d && pred(d)) break; } return d; };

const act = (p, a, id) => { const b = p.qq(`[data-act="${a}"][data-id="${id}"]`); if (!b) throw new Error(`no button ${a} ${id}`); b.click(); };
const setF = (p, name, value) => { const el = p.qq(`[data-form] [data-f="${name}"]`); el.value = value; el.dispatchEvent(new p.w.Event('input', { bubbles: true })); el.dispatchEvent(new p.w.Event('change', { bubbles: true })); };
const key = (p, name, k) => p.qq(`[data-form] [data-f="${name}"]`).dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, bubbles: true }));
const mainIds = (p, day) => p.qa(`[data-list="${day}"] > [data-item]`).map(x => x.dataset.item);
const altIds = (p, day) => p.qa(`[data-list="${day}"] > [data-alt]`).map(x => x.dataset.alt);
const titleOf = (p, id) => (p.qq(`[data-item="${id}"] .itin-title`) || {}).textContent;
// what the page shows, day by day — compared across reloads
const snapshot = p => p.qa('.itin-day').map(d => ({
  day: d.dataset.day,
  kind: [...d.classList].find(c => c.startsWith('k-')) || '',
  dayTitle: (d.querySelector('.itin-daytitle') || {}).textContent || '',
  main: [...d.querySelectorAll('[data-item]')].map(c => [c.dataset.item, c.querySelector('.itin-title').textContent, c.className, (c.querySelector('.itin-link') || {}).href || '', [...c.querySelectorAll('.itin-points li')].map(li => li.textContent).join('|')]),
  alt: [...d.querySelectorAll('[data-alt]')].map(c => c.dataset.alt)
}));

function drag(p, id, targetEl, where) {
  const w = p.w, src = p.qq(`[data-item="${id}"]`);
  const r = targetEl.getBoundingClientRect();
  const y = where === 'top' ? r.top + 2 : r.bottom - 2;
  const x = r.left + r.width / 2;
  const dt = new w.DataTransfer();
  src.dispatchEvent(new w.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  targetEl.dispatchEvent(new w.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  const line = !!p.qq('.itin-dropline');
  targetEl.dispatchEvent(new w.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  src.dispatchEvent(new w.DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return line;
}

async function fresh() {
  await deleteDoc(ref());
  localStorage.removeItem(LOCAL_KEY);
}

export async function phaseMain() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();

  // 1. first load, no doc: the seed itinerary, read straight from code
  const A = await open();
  r.ok('loads ready', A.qq('#itinBanner').hidden && cardsFree(A), A.qq('#itinBanner').textContent);
  r.ok('30 day blocks, 1.11 to 30.11', A.qa('.itin-day').length === 30 && A.qq('.itin-day .itin-date').textContent === '1.11' && A.qa('.itin-date').pop().textContent === '30.11');
  r.ok('14 items (Thyssen on 11.11) + one alt occurrence', A.qa('[data-item]').length === 14 && mainIds(A, D(11)).join() === 'i11,i11b' && A.qq('[data-item="i11b"]').classList.contains('st-optional') && A.qa('[data-alt]').length === 1);
  r.ok('weekday: 1.11 Sunday, 14.11 Saturday, 30.11 Monday', A.qq('.itin-wd').textContent === 'יום א׳' && A.qq(`[data-day="${D(14)}"] .itin-wd`).textContent === 'יום ש׳' && A.qa('.itin-wd').pop().textContent === 'יום ב׳');
  // two parts: 1–14.11 the holiday, 15–30.11 what comes after
  const parts = A.qa('#itin > .itin-part');
  r.ok('parts: two headings, right before 1.11 and 15.11', parts.length === 2 && parts[0].nextElementSibling.dataset.block === D(1) && parts[1].nextElementSibling.dataset.block === D(15) && parts[1].previousElementSibling.dataset.block === D(13) && A.qa(`[data-block="${D(13)}"] .itin-day`).pop().dataset.day === D(14) && /^חלק א׳/.test(parts[0].textContent) && /1–14\.11/.test(parts[0].textContent) && /^חלק ב׳/.test(parts[1].textContent) && /15–30\.11/.test(parts[1].textContent) && !/Workaway|החופשה/.test(parts[0].textContent + parts[1].textContent));
  r.ok('parts: headings span the whole row and are not drop targets', parts.every(p => !p.dataset.day && Math.abs(p.getBoundingClientRect().width - A.qq('#itin').getBoundingClientRect().width) < 2));
  const after = A.qa('.itin-day.after').map(e => e.dataset.day);
  r.ok('parts: exactly 15–30.11 marked as the second part', after.length === 16 && after[0] === D(15) && after[15] === D(30));
  const bg = day => A.w.getComputedStyle(A.qq(`[data-day="${D(day)}"]`)).backgroundColor;
  const bs = day => A.w.getComputedStyle(A.qq(`[data-day="${D(day)}"]`)).borderTopStyle;
  r.ok('parts: second part has its own tone (paper + dashed), first part unchanged', bg(15) !== bg(14) && bg(15) === A.w.getComputedStyle(A.w.document.body).backgroundColor && bs(15) === 'dashed' && bs(14) === 'solid', [bg(14), bg(15), bs(14), bs(15)]);
  r.ok('parts: 15.11–30.11 cards have the same parts as 1–14 (✎, tile, list, add)', [15, 22, 30].every(n => A.qq(`[data-act="dayedit"][data-id="${D(n)}"]`) && A.qq(`[data-day="${D(n)}"] .itin-tile`) && A.qq(`[data-list="${D(n)}"]`) && A.qq(`[data-act="add"][data-id="${D(n)}"]`)));
  r.ok('Barcelona: one item, on 7.11 and as an alt on 8.11', mainIds(A, D(7)).join() === 'i07' && altIds(A, D(8)).join() === 'i07' && mainIds(A, D(8)).length === 0);
  r.ok('Barcelona: marked as an unresolved date', /7\.11 או 8\.11/.test(A.qq('[data-item="i07"] .itin-tbd').textContent));
  const colour = id => A.w.getComputedStyle(A.qq(`[data-item="${id}"] .itin-badge`)).color;
  const pill = id => A.qq(`[data-item="${id}"] .itin-badge`).textContent;
  r.ok('badge is the last thing on the card', [...A.qq('[data-item="i01"]').children].filter(c => !c.hidden).pop().classList.contains('itin-badge'));
  r.ok('status labels', pill('i01') === 'BOOKED' && pill('i02') === 'PLANNED' && pill('i09') === 'OPTIONAL' && pill('i14') === 'OPEN');
  const cols = { booked: colour('i01'), planned: colour('i02'), optional: colour('i09'), open: colour('i14') };
  r.ok('status colours: green / blue / gold / slate', cols.booked === 'rgb(47, 111, 78)' && cols.planned === 'rgb(61, 110, 140)' && cols.optional === 'rgb(201, 150, 44)' && cols.open === 'rgb(91, 100, 114)', cols);
  const icons = id => A.qa(`[data-item="${id}"] .itin-points li`).map(li => li.dataset.icon || '•');
  r.ok('bullets + icons: arrival', icons('i01').join() === 'plane,car,bed,glass', icons('i01'));
  r.ok('bullets + icons: 2.11 bullets then free evening', icons('i02').join() === '•,•,•,cutlery', icons('i02'));
  r.ok('bullets + icons: Prado II', icons('i06').join() === '•,•,•,clock,masks', icons('i06'));
  r.ok('bullets + icons: Reina Sofía music, Techno headphones, Open day', icons('i11').join() === '•,•,note' && icons('i13').join() === 'headphones' && icons('i14').join() === 'cup,search,plane', [icons('i11'), icons('i13'), icons('i14')]);
  r.ok('8.11 card: "or match day", match if not on 7.11, free time', /או יום משחק/.test(A.qq('[data-alt="i07"] .itin-title').textContent) && A.qa('[data-alt="i07"] .itin-points li').map(li => li.textContent).join('|') === 'יום משחק (אם לא ב-7.11)|זמן חופשי');
  // layout: blocks of 4 per part, 4 across on desktop, wider than the text
  // column — 1–4, 5–8, 9–12, 13–14 | 15–18 … 27–30
  const tops = P => [...new Set(P.qa('.itin-day').map(d => Math.round(d.getBoundingClientRect().top)))];
  const firstRow = P => P.qa('.itin-day').filter(d => Math.round(d.getBoundingClientRect().top) === tops(P)[0]).length;
  const perRow = P => tops(P).map(t => P.qa('.itin-day').filter(d => Math.round(d.getBoundingClientRect().top) === t).length);
  r.ok('desktop: blocks of 4 — 4,4,4,2 then 4,4,4,4', perRow(A).join() === '4,4,4,2,4,4,4,4' && Math.round(A.qq(`[data-day="${D(15)}"]`).getBoundingClientRect().top) > Math.round(A.qq('#itin > .itin-part.after').getBoundingClientRect().bottom) - 1, perRow(A));
  r.ok('desktop: board breaks out of the 780px text column', A.qq('#itin').getBoundingClientRect().width > 1100, A.qq('#itin').getBoundingClientRect().width);
  r.ok('desktop: RTL — 1.11 is the right-most card', A.qq('[data-day="2026-11-01"]').getBoundingClientRect().right > A.qq('[data-day="2026-11-04"]').getBoundingClientRect().right);
  r.ok('desktop: no horizontal page scroll', A.w.document.documentElement.scrollWidth <= A.w.innerWidth);
  const badgesRow = A.qa('.itin-day').slice(0, 4).map(d => Math.round(d.querySelector('.itin-badge').getBoundingClientRect().bottom));
  r.ok('desktop: badges line up along the bottom of a row', Math.max(...badgesRow) - Math.min(...badgesRow) <= 2, badgesRow);
  r.ok('actions menu closed by default', A.qa('[data-item] .itin-acts').every(x => x.hidden) && A.qq('[data-act="menu"][data-id="i01"]').getAttribute('aria-expanded') === 'false');
  act(A, 'menu', 'i01');
  r.ok('⋯ opens the item\'s actions', !A.qq('[data-item="i01"] .itin-acts').hidden && A.qq('[data-act="menu"][data-id="i01"]').getAttribute('aria-expanded') === 'true');
  act(A, 'menu', 'i01');
  for (const [wpx, cols] of [[820, 4], [560, 2], [400, 1]]) {
    const T = await open('', true, wpx);
    r.ok(`${wpx}px: ${cols} per row, no horizontal scroll`, firstRow(T) === cols && T.w.document.documentElement.scrollWidth <= T.w.innerWidth, { first: firstRow(T), sw: T.w.document.documentElement.scrollWidth });
    T.f.remove();
  }
  // poster tiles: a colour + icon per day type, guessed from the content
  const kinds = A.qa('.itin-day').map(d => [...d.classList].find(c => c.startsWith('k-')).slice(2));
  r.ok('tile kind per day', kinds.join() === 'arrival,city,football,museum,daytrip,museum,football,football,city,daytrip,museum,park,night,open' + ',open'.repeat(16), kinds);
  r.ok('≥760px: part heading sticks right under the sticky pool', A.w.getComputedStyle(A.qq('.itin-part')).position === 'sticky' && A.w.getComputedStyle(A.qq('.itin-part')).top === A.w.getComputedStyle(A.w.document.documentElement).getPropertyValue('--pool-bottom').trim() && parseFloat(A.w.getComputedStyle(A.w.document.documentElement).getPropertyValue('--pool-bottom')) > parseFloat(A.w.getComputedStyle(A.w.document.documentElement).getPropertyValue('--pool-top')));
  r.ok('2.11 stays "city" although its description mentions פארק רטירו (new types read titles only)', A.qq(`[data-day="${D(2)}"]`).classList.contains('k-city'));
  r.ok('tile has a big icon and the kind colour', !!A.qq('[data-day="2026-11-03"] .itin-tile svg') && A.w.getComputedStyle(A.qq('[data-day="2026-11-03"] .itin-tile')).color === 'rgb(196, 38, 46)');
  // summary under the board, derived from the items
  const sum = st => A.qa(`[data-sum="${st}"] [data-sum-item]`).map(li => li.dataset.sumItem);
  r.ok('summary: booked = Onefam line + the three booked items', /1–8\.11.*Onefam.*7 לילות/.test(A.qq('.sum.st-booked .sum-fixed').textContent) && A.qa('.sum.st-booked .sum-fixed').length === 2 && /8–14\.11.*סגור/.test(A.qa('.sum.st-booked .sum-fixed')[1].textContent) && /15–30\.11.*פתוח/.test(A.qq('.sum-open').textContent) && /8–14\.11[\s\S]*סגור[\s\S]*15–30\.11[\s\S]*פתוח/.test(A.qq('#stay').textContent) && !/Workaway|ייקבע במקום/.test(A.qq('#stay').textContent + A.qq('.itin-summary').textContent) && /Onefam[\s\S]*1–8\.11[\s\S]*שולם/.test(A.qq('#stay').textContent) && !/1–14\.11/.test(A.qq('#stay').textContent + A.qq('.itin-summary').textContent) && sum('booked').join() === 'i01,i03,i07', sum('booked'));
  r.ok('summary: Barcelona shows both dates', /7\.11 \/ 8\.11/.test(A.qq('[data-sum-item="i07"]').textContent));
  r.ok('summary: planned', sum('planned').join() === 'i02,i04,i05,i06', sum('planned'));
  r.ok('summary: optional incl. Thyssen', sum('optional').join() === 'i09,i10,i11,i11b,i12,i13', sum('optional'));
  // goal box at the top, the stale "not yet decided" box gone, timeline not built
  r.ok('goal box at the top', !!A.qq('.box.goal') && A.qq('.box.goal').compareDocumentPosition(A.qq('nav')) === 4 && A.qa('.goal-list li').length === 5);
  r.ok('NOT YET DECIDED box removed', !/NOT YET DECIDED/.test(A.w.document.body.textContent));
  r.ok('legend shows the four statuses', A.qa('.itin-legend .st').map(x => x.textContent).join() === 'BOOKED,PLANNED,OPTIONAL,OPEN');
  r.ok('RTL page, Hebrew titles', A.w.document.documentElement.dir === 'rtl' && titleOf(A, 'i01') === 'נחיתה במדריד');
  await sleep(1500);
  r.ok('nothing written just by loading', !(await getDoc(ref())).exists());

  // 2. edit every field
  act(A, 'edit', 'i02');
  r.ok('the card being edited spans the whole row', A.qq(`[data-day="${D(2)}"]`).getBoundingClientRect().width > 1000);
  r.ok('edit opens a form with the current values', A.qq('[data-form="i02"] [data-f="title"]').value === 'מגלים את מדריד' && A.qq('[data-form="i02"] [data-f="status"]').value === 'planned');
  const groups = A.qa('[data-form="i02"] [data-f="day"] optgroup');
  r.ok('day picker: 30 days in two groups (14 + 16)', groups.length === 2 && groups[0].children.length === 14 && groups[1].children.length === 16 && /^חלק ב׳/.test(groups[1].label) && /15–30\.11/.test(groups[1].label) && A.qq('[data-form="i02"] [data-f="day"]').value === D(2));
  setF(A, 'title', 'בדיקה: רטירו'); setF(A, 'desc', 'תיאור בדיקה'); setF(A, 'status', 'optional'); setF(A, 'url', 'example.com/x');
  act(A, 'save', 'i02');
  r.ok('saved card shows the new values', titleOf(A, 'i02') === 'בדיקה: רטירו' && A.qq('[data-item="i02"]').classList.contains('st-optional') && A.qq('[data-item="i02"] .itin-badge').textContent === 'OPTIONAL' && A.qq('[data-item="i02"] .itin-points li').textContent === 'תיאור בדיקה' && A.qq('[data-item="i02"] .itin-link').href === 'https://example.com/x' && A.qq('[data-item="i02"] .itin-link').target === '_blank');
  r.ok('after saving, the card is back in the grid', A.qq(`[data-day="${D(2)}"]`).getBoundingClientRect().width < 400);
  let d = await docWhen(x => x.items.i02.title === 'בדיקה: רטירו');
  r.ok('summary follows the edit (PLANNED -> OPTIONAL)', sum('planned').join() === 'i04,i05,i06' && sum('optional')[0] === 'i02');
  r.ok('edit persisted', d && d.items.i02.desc === 'תיאור בדיקה' && d.items.i02.status === 'optional' && d.items.i02.url === 'example.com/x' && d.items.i02.day === D(2), d && d.items.i02);
  r.ok('first save writes the whole seed', d && Object.keys(d.items).length === 14 && d.items.i07.altDay === D(8));

  act(A, 'edit', 'i02'); setF(A, 'url', 'javascript:alert(1)'); act(A, 'save', 'i02');
  r.ok('invalid link refused, form stays open with an error', !!A.qq('[data-form="i02"]') && /הקישור לא תקין/.test(A.qq('[data-form="i02"] .linkerr').textContent));
  setF(A, 'url', 'example.com/x'); setF(A, 'title', '   '); act(A, 'save', 'i02');
  r.ok('empty title refused', !!A.qq('[data-form="i02"]') && /כותרת/.test(A.qq('[data-form="i02"] .linkerr').textContent));
  act(A, 'cancel', 'i02');
  r.ok('cancel keeps the saved values', titleOf(A, 'i02') === 'בדיקה: רטירו' && !A.qq('[data-form]'));
  act(A, 'edit', 'i02'); setF(A, 'title', 'לא יישמר'); key(A, 'title', 'Escape');
  r.ok('Escape cancels', titleOf(A, 'i02') === 'בדיקה: רטירו' && !A.qq('[data-form]'));
  act(A, 'edit', 'i02'); setF(A, 'title', 'רטירו'); key(A, 'title', 'Enter');
  r.ok('Enter saves', titleOf(A, 'i02') === 'רטירו' && !A.qq('[data-form]'));

  // 3. change the date from the form -> end of the new day
  act(A, 'edit', 'i02'); setF(A, 'day', D(9)); act(A, 'save', 'i02');
  r.ok('date change moves it to the end of 9.11', mainIds(A, D(9)).join() === 'i09,i02' && mainIds(A, D(2)).length === 0);

  // 4. reorder within a day + move between days with the buttons
  r.ok('first item: ↑ disabled', A.qq('[data-act="up"][data-id="i09"]').disabled && !A.qq('[data-act="down"][data-id="i09"]').disabled);
  act(A, 'up', 'i02');
  r.ok('↑ reorders', mainIds(A, D(9)).join() === 'i02,i09');
  r.ok('focus stays on the moved item, its menu open', A.w.document.activeElement && A.w.document.activeElement.dataset.id === 'i02' && !A.qq('[data-item="i02"] .itin-acts').hidden);
  act(A, 'down', 'i02');
  r.ok('↓ reorders', mainIds(A, D(9)).join() === 'i09,i02');
  act(A, 'next', 'i02');
  r.ok('next day', mainIds(A, D(10)).join() === 'i10,i02' && mainIds(A, D(9)).join() === 'i09');
  act(A, 'prev', 'i02');
  r.ok('previous day', mainIds(A, D(9)).join() === 'i09,i02');
  r.ok('no previous day on 1.11; 14.11 has a next day now', A.qq('[data-act="prev"][data-id="i01"]').disabled && !A.qq('[data-act="next"][data-id="i14"]').disabled);
  act(A, 'next', 'i14');
  r.ok('across the parts: 14.11 -> 15.11 with "ליום הבא"', mainIds(A, D(15)).join() === 'i14' && mainIds(A, D(14)).length === 0);
  drag(A, 'i14', A.qq(`[data-list="${D(30)}"]`), 'bottom');
  r.ok('drag onto 30.11; no next day there', mainIds(A, D(30)).join() === 'i14' && A.qq('[data-act="next"][data-id="i14"]').disabled && !A.qq('[data-act="prev"][data-id="i14"]').disabled);
  d = await docWhen(x => x.items.i14.day === D(30));
  r.ok('a day in the second part persists', d && d.items.i14.day === D(30) && d.items.i14.order === 0);
  drag(A, 'i14', A.qq(`[data-list="${D(14)}"]`), 'bottom');
  r.ok('and back to 14.11', mainIds(A, D(14)).join() === 'i14' && mainIds(A, D(30)).length === 0);
  r.ok('move buttons are labelled', /העברת "רטירו" ליום הבא/.test(A.qq('[data-act="next"][data-id="i02"]').getAttribute('aria-label')));
  d = await docWhen(x => x.items.i02.day === D(9) && x.items.i02.order === 1);
  r.ok('moves persisted with renumbered order', d && d.items.i09.order === 0 && d.items.i02.order === 1 && d.items.i10.order === 0, d && [d.items.i09, d.items.i02]);

  // 5. drag and drop: before another item, onto an empty day, onto a day with only an alt
  let line = drag(A, 'i02', A.qq('[data-item="i04"]'), 'top');
  r.ok('drag: card moved visually (now inside 4.11\'s card)', !!A.qq(`[data-day="${D(4)}"] [data-item="i02"]`));
  r.ok('drag: drop line shown while over a day', line);
  r.ok('drag: dropped before 4.11\'s item', mainIds(A, D(4)).join() === 'i02,i04' && mainIds(A, D(9)).join() === 'i09');
  drag(A, 'i02', A.qq(`[data-list="${D(8)}"]`), 'bottom');
  r.ok('drag: onto 8.11 (only the alt there)', mainIds(A, D(8)).join() === 'i02' && altIds(A, D(8)).join() === 'i07');
  drag(A, 'i02', A.qq(`[data-day="${D(2)}"] .itin-head`), 'top');
  r.ok('drag: back onto the empty 2.11 (dropped on its date header)', mainIds(A, D(2)).join() === 'i02' && mainIds(A, D(8)).length === 0);
  r.ok('drag: no leftover drop line / dragging class', !A.qq('.itin-dropline') && !A.qq('.dragging'));
  d = await docWhen(x => x.items.i02.day === D(2));
  r.ok('drag persisted', d && d.items.i02.day === D(2) && d.items.i04.order === 0);

  // 6. the Barcelona match: one item, edited from either day
  act(A, 'editalt', 'i07');
  r.ok('edit from 8.11 opens the form on 8.11', !!A.qq(`[data-list="${D(8)}"] [data-form="i07"]`));
  setF(A, 'title', 'אתלטיקו–ברצלונה (בדיקה)'); act(A, 'save', 'i07');
  r.ok('both occurrences show the new title', titleOf(A, 'i07') === 'אתלטיקו–ברצלונה (בדיקה)' && A.qq('[data-alt="i07"] .itin-title').firstChild.textContent === 'אתלטיקו–ברצלונה (בדיקה)');
  d = await docWhen(x => x.items.i07.title === 'אתלטיקו–ברצלונה (בדיקה)');
  r.ok('still exactly one Barcelona item in the doc', d && Object.values(d.items).filter(x => /ברצלונה/.test(x.title)).length === 1);
  act(A, 'edit', 'i07'); setF(A, 'altDay', ''); act(A, 'save', 'i07');
  r.ok('clearing the alt date resolves it to 7.11', altIds(A, D(8)).length === 0 && !A.qq('[data-item="i07"] .itin-tbd'));
  act(A, 'edit', 'i07'); setF(A, 'altDay', D(8)); act(A, 'save', 'i07');
  r.ok('alt date set again', altIds(A, D(8)).join() === 'i07');
  drag(A, 'i07', A.qq(`[data-list="${D(8)}"]`), 'bottom');
  r.ok('dragging it onto its alt day fixes it there', mainIds(A, D(8)).join() === 'i07' && altIds(A, D(8)).length === 0 && mainIds(A, D(7)).length === 0);
  act(A, 'edit', 'i07'); setF(A, 'day', D(7)); setF(A, 'altDay', D(8)); act(A, 'save', 'i07');
  r.ok('back to 7.11 with 8.11 as the alt', mainIds(A, D(7)).join() === 'i07' && altIds(A, D(8)).join() === 'i07');

  // 6b. the day card itself: title + day type
  act(A, 'dayedit', D(5));
  r.ok('day editor opens on the card', !!A.qq(`[data-dayform="${D(5)}"]`) && A.qq(`[data-dayform="${D(5)}"] [data-df="kind"]`).value === '' && /אוטומטי \(טיול יום\)/.test(A.qq(`[data-dayform="${D(5)}"] [data-df="kind"] option`).textContent));
  const setDF = (name, v) => { const el = A.qq(`[data-dayform] [data-df="${name}"]`); el.value = v; el.dispatchEvent(new A.w.Event('input', { bubbles: true })); el.dispatchEvent(new A.w.Event('change', { bubbles: true })); };
  setDF('title', 'יום טולדו'); setDF('kind', 'night'); act(A, 'daysave', D(5));
  r.ok('day title shown on the card', A.qq(`[data-daytitle="${D(5)}"]`).textContent === 'יום טולדו' && A.qq(`[data-day="${D(5)}"]`).classList.contains('k-night'));
  r.ok('items of the day untouched', mainIds(A, D(5)).join() === 'i05' && titleOf(A, 'i05') === 'טיול יום לטולדו');
  d = await docWhen(x => x.days && x.days[D(5)]);
  r.ok('day card persisted', d && d.days[D(5)].title === 'יום טולדו' && d.days[D(5)].kind === 'night', d && d.days);
  act(A, 'dayedit', D(5)); setDF('title', 'לא יישמר'); A.qq('[data-dayform] [data-df="title"]').dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  r.ok('day editor: Escape cancels', A.qq(`[data-daytitle="${D(5)}"]`).textContent === 'יום טולדו' && !A.qq('[data-dayform]'));
  act(A, 'dayedit', D(5)); setDF('kind', ''); A.qq('[data-dayform] [data-df="title"]').dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  r.ok('day editor: Enter saves; kind back to automatic', A.qq(`[data-day="${D(5)}"]`).classList.contains('k-daytrip'));
  act(A, 'dayedit', D(6)); setDF('title', 'פראדו, חלק שני'); act(A, 'daysave', D(6));
  act(A, 'dayedit', D(6)); setDF('title', '  '); act(A, 'daysave', D(6));
  d = await docWhen(x => x.days && !x.days[D(6)] && x.days[D(5)] && !x.days[D(5)].kind);
  r.ok('empty title + automatic kind removes the day entry', d && !d.days[D(6)] && d.days[D(5)].title === 'יום טולדו' && !A.qq(`[data-daytitle="${D(6)}"]`), d && d.days);
  // 6c. v1.30 day types: guessed from the day's own title (empty days), manual choice wins
  const kindOn = n => ([...A.qq(`[data-day="${D(n)}"]`).classList].find(c => c.startsWith('k-')) || '').slice(2);
  const opts = (act(A, 'dayedit', D(20)), A.qa(`[data-dayform="${D(20)}"] [data-df="kind"] option`).map(o => o.value));
  r.ok('day editor lists 13 types + automatic, new ones included', opts.length === 14 && ['departure', 'spa', 'park', 'plaza', 'errand', 'music'].every(k => opts.includes(k)), opts);
  act(A, 'daycancel', D(20));
  const typed = [[20, 'DNI Apply', 'errand'], [21, 'טיסה חזרה', 'departure'], [22, 'Riela Bathhouse', 'spa'], [23, 'פארק מדריד ריו', 'park'], [24, 'Plaza Mayor', 'plaza'], [25, 'חדר חזרות והופעה', 'music'], [26, 'נחיתה שנייה', 'arrival']];
  typed.forEach(([n, t]) => { act(A, 'dayedit', D(n)); setDF('title', t); act(A, 'daysave', D(n)); });
  r.ok('day title drives the guess on an empty day', typed.every(([n, , k]) => kindOn(n) === k), typed.map(([n]) => kindOn(n)));
  r.ok('new types: tile icon + own tint', typed.slice(0, 6).every(([n]) => !!A.qq(`[data-day="${D(n)}"] .itin-tile svg`)) && new Set(typed.slice(0, 6).map(([n]) => A.w.getComputedStyle(A.qq(`[data-day="${D(n)}"] .itin-tile`)).color)).size === 6);
  act(A, 'dayedit', D(22));
  r.ok('automatic option names the guess', /אוטומטי \(ספא \/ רוגע\)/.test(A.qq(`[data-dayform="${D(22)}"] [data-df="kind"] option`).textContent));
  setDF('kind', 'museum'); act(A, 'daysave', D(22));
  r.ok('manual choice beats the guess', kindOn(22) === 'museum');
  d = await docWhen(x => x.days && x.days[D(22)] && x.days[D(22)].kind === 'museum');
  r.ok('manual kind persisted, guessed kinds are not', d && d.days[D(22)].kind === 'museum' && [20, 21, 23, 24, 25].every(n => !d.days[D(n)].kind), d && d.days);
  typed.forEach(([n]) => { act(A, 'dayedit', D(n)); setDF('title', ''); setDF('kind', ''); act(A, 'daysave', D(n)); });
  d = await docWhen(x => x.days && typed.every(([n]) => !x.days[D(n)]));
  r.ok('cleared again', d && typed.every(([n]) => !d.days[D(n)] && kindOn(n) === 'open'), d && d.days);

  // 7. add
  act(A, 'add', D(5)); act(A, 'save', 'new');
  r.ok('add: empty title refused', !!A.qq('[data-form="new"] .linkerr'));
  act(A, 'cancel', 'new');
  r.ok('add: cancel adds nothing', mainIds(A, D(5)).join() === 'i05' && !A.qq('[data-form]'));
  act(A, 'add', D(5));
  r.ok('add: new form defaults to PLANNED on that day', A.qq('[data-form="new"] [data-f="status"]').value === 'planned' && A.qq('[data-form="new"] [data-f="day"]').value === D(5));
  setF(A, 'title', 'פריט חדש'); setF(A, 'status', 'open'); act(A, 'save', 'new');
  const ids5 = mainIds(A, D(5)); const nid = ids5[1];
  r.ok('add: appended to the day', ids5.length === 2 && ids5[0] === 'i05' && /^i_/.test(nid) && titleOf(A, nid) === 'פריט חדש' && A.qq(`[data-item="${nid}"]`).classList.contains('st-open'));
  d = await docWhen(x => x.items[nid]);
  r.ok('add persisted', d && d.items[nid].day === D(5) && d.items[nid].order === 1 && d.items[nid].status === 'open', d && d.items[nid]);

  // 8. delete (inline confirm)
  act(A, 'up', nid);
  act(A, 'del', nid);
  r.ok('delete asks first', !!A.qq(`[data-act="delyes"][data-id="${nid}"]`));
  act(A, 'delno', nid);
  r.ok('"no" keeps it', mainIds(A, D(5)).includes(nid));
  act(A, 'del', nid); act(A, 'delyes', nid);
  r.ok('"yes" deletes it', mainIds(A, D(5)).join() === 'i05');
  d = await docWhen(x => !x.items[nid]);
  r.ok('delete persisted, day renumbered', d && !d.items[nid] && d.items.i05.order === 0);

  // 9. local copy + persistence across a reload
  await waitIdle(A);
  d = (await getDoc(ref())).data();
  let local = null; try { local = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch (e) { /* checked below */ }
  r.ok('localStorage copy matches the doc', local && canonJson(local) === canonJson(d));
  const before = snapshot(A);
  A.f.remove();
  const B = await open();
  r.ok('reload: identical itinerary', JSON.stringify(snapshot(B)) === JSON.stringify(before));
  r.ok('reload: day title kept', B.qq(`[data-daytitle="${D(5)}"]`).textContent === 'יום טולדו');
  r.ok('reload: values from the doc', titleOf(B, 'i02') === 'רטירו' && mainIds(B, D(2)).join() === 'i02' && B.qq('[data-item="i02"] .itin-link').href === 'https://example.com/x');
  B.f.remove();

  r.ok('real itinerary doc untouched', (await realSnap()) === realBefore);
  return r.result();
}

export async function phaseGuard() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const conflicted = p => !p.qq('#itinBanner').hidden && p.qq('#itinBanner').textContent === MSG_CONFLICT && cardsInert(p);
  const clean = p => p.qq('#itinBanner').hidden && cardsFree(p);

  // one tab: saves in a row (including while one is in flight) never self-conflict
  const A = await open();
  act(A, 'next', 'i01'); let d = await docWhen(x => x.items.i01.day === D(2));
  r.ok('single tab: first save', d && clean(A));
  for (const id of ['i03', 'i04', 'i05']) { act(A, 'next', id); await sleep(900); }
  d = await docWhen(x => x.items.i05.day === D(6));
  r.ok('single tab: saves during an in-flight save do not conflict', d && d.items.i03.day === D(4) && clean(A), A.qq('#itinBanner').textContent);

  // two tabs: the one that loaded earlier is refused
  await waitIdle(A);
  const B = await open();
  act(B, 'del', 'i14'); act(B, 'delyes', 'i14');
  d = await docWhen(x => !x.items.i14);
  r.ok('tab B (fresh) deletes an item', d && !d.items.i14 && clean(B));
  const snap = canonJson(d);
  act(A, 'up', 'i01'); // 2.11 is [i02, i01] here, so this really is a change A tries to save
  for (let i = 0; i < 40 && !conflicted(A); i++) await sleep(250);
  r.ok('tab A (stale) is refused: doc unchanged', canonJson((await getDoc(ref())).data()) === snap);
  r.ok('tab A shows the notice and goes read-only', conflicted(A), A.qq('#itinBanner').textContent);
  act(A, 'next', 'i06'); await waitIdle(A);
  r.ok('tab A stays refused', canonJson((await getDoc(ref())).data()) === snap);
  r.ok('tab B unaffected', clean(B));
  A.f.remove();

  // a write from somewhere else is caught on focus, before any edit
  await waitIdle(B);
  const ext = (await getDoc(ref())).data(); ext.items.i09.title = 'שונה במכשיר אחר';
  await setDoc(ref(), ext);
  B.w.dispatchEvent(new B.w.Event('focus'));
  for (let i = 0; i < 20 && !conflicted(B); i++) await sleep(250);
  r.ok('focus check: other-device change detected', conflicted(B));
  B.f.remove();
  const C = await open();
  r.ok('after reload: the other device\'s change is shown, editable again', titleOf(C, 'i09') === 'שונה במכשיר אחר' && clean(C));
  C.f.remove();

  r.ok('real itinerary doc untouched', (await realSnap()) === realBefore);
  return r.result();
}

export async function phaseLoad() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  const base = { items: { i01: { day: D(1), order: 0, title: 'מהשרת', desc: '', status: 'booked', url: '', extra: 'keep' } }, days: { [D(2)]: { title: 'שמור', future: 1 } }, futureField: { a: 1 } };
  const localCopy = { items: { i01: { day: D(1), order: 0, title: 'מקומי', desc: '', status: 'planned', url: '' } } };

  // slow load: inert + nothing saved by clicks made before it resolves
  await setDoc(ref(), base);
  localStorage.removeItem(LOCAL_KEY);
  let P = await open('loadtest=slow', false);
  r.ok('slow: cards inert with a loading notice', cardsInert(P) && !P.qq('#itinBanner').hidden && /טוען/.test(P.qq('#itinBanner').textContent));
  act(P, 'next', 'i01'); act(P, 'del', 'i02');
  for (let i = 0; i < 40 && !settled(P); i++) await sleep(200);
  await sleep(1200);
  r.ok('slow: pre-load clicks wrote nothing', canonJson((await getDoc(ref())).data()) === canonJson(base) && localStorage.getItem(LOCAL_KEY) === null);
  r.ok('slow: then shows the doc', titleOf(P, 'i01') === 'מהשרת' && P.qa('[data-item]').length === 1 && cardsFree(P));
  // unknown fields survive a save
  act(P, 'edit', 'i01'); setF(P, 'desc', 'נוסף'); act(P, 'save', 'i01');
  let d = await docWhen(x => x.items.i01.desc === 'נוסף');
  r.ok('unknown top-level, item and day fields are kept', d && d.futureField && d.futureField.a === 1 && d.items.i01.extra === 'keep' && d.days[D(2)].future === 1 && d.days[D(2)].title === 'שמור', d);
  P.f.remove();

  // failed load with a local copy: read-only, local shown, nothing written
  await setDoc(ref(), base);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(localCopy));
  P = await open('loadtest=fail');
  r.ok('fail: local copy shown read-only', titleOf(P, 'i01') === 'מקומי' && cardsInert(P) && /העותק האחרון/.test(P.qq('#itinBanner').textContent));
  act(P, 'next', 'i01'); act(P, 'edit', 'i01'); await sleep(1500);
  r.ok('fail: clicks write nothing (doc + local)', canonJson((await getDoc(ref())).data()) === canonJson(base) && localStorage.getItem(LOCAL_KEY) === JSON.stringify(localCopy));
  P.f.remove();

  // failed load, no local copy: the original itinerary, read-only
  localStorage.removeItem(LOCAL_KEY);
  P = await open('loadtest=fail');
  r.ok('fail, no local: seed shown read-only', P.qa('[data-item]').length === 14 && cardsInert(P) && /אין עותק שמור/.test(P.qq('#itinBanner').textContent));
  P.f.remove();

  // no doc yet + a local copy (e.g. edited offline before the first save): local wins
  await deleteDoc(ref());
  localStorage.setItem(LOCAL_KEY, JSON.stringify(localCopy));
  P = await open();
  r.ok('no doc: local copy loaded, editable', titleOf(P, 'i01') === 'מקומי' && cardsFree(P));
  await sleep(1500);
  r.ok('no doc: nothing written until an edit', !(await getDoc(ref())).exists());
  P.f.remove();

  await fresh();
  r.ok('real itinerary doc untouched', (await realSnap()) === realBefore);
  return r.result();
}

export async function phaseChecklist() {
  await guard();
  const r = reporter();
  const cref = doc(db, 'users', auth.currentUser.uid, 'state', 'checklist_test');
  const realC = doc(db, 'users', auth.currentUser.uid, 'state', 'checklist');
  const realBefore = canonJson((await getDoc(realC)).data() || null);
  // an old positional doc: item6 (Resident Advisor) checked, item0 (account, now deleted) checked
  await setDoc(cref, { item0: true, item6: true, item7: false });
  localStorage.removeItem('madrid.checklist.test');
  const P = await open();
  await sleep(1500);
  const checks = P.qa('#todo .check');
  r.ok('three open tasks left', checks.length === 3 && /ביטוח/.test(checks[0].textContent) && /Resident Advisor/.test(checks[1].textContent) && /לשאר נובמבר/.test(checks[2].textContent) && /15–30\.11/.test(checks[2].textContent) && checks[2].dataset.c === 'night14' && !/Workaway/.test(checks[2].textContent));
  r.ok('the obsolete flight item is gone', !/לסגור טיסות/.test(P.qq('#todo').textContent));
  r.ok('existing marks follow their task, not the position', !checks[0].classList.contains('on') && checks[1].classList.contains('on') && !checks[2].classList.contains('on'));
  checks[2].click();
  let d; for (let i = 0; i < 20; i++) { await sleep(250); d = (await getDoc(cref)).data(); if (d.night14) break; }
  r.ok('new task saves under its own key', d.night14 === true && d.item6 === true && d.item0 === true);
  P.f.remove();
  const Q = await open(); await sleep(1500);
  r.ok('reload: marks kept', Q.qa('#todo .check')[2].classList.contains('on') && Q.qa('#todo .check')[1].classList.contains('on'));
  Q.f.remove();
  await deleteDoc(cref);
  localStorage.removeItem('madrid.checklist.test');
  r.ok('real checklist doc untouched', canonJson((await getDoc(realC)).data() || null) === realBefore);
  return r.result();
}

/* Blocks of 4 (per part), collapsed lines, the default by date, what is
   remembered on this device, expand/collapse all, drag onto collapsed days,
   and that none of it is data (nothing reaches Firestore by itself). */
export async function phaseCollapse() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const head = (p, b) => p.qq(`#itin [data-bhead="${b}"]`);
  const line = (p, day) => p.qq(`#itin [data-cday="${day}"]`);

  // 1. default, nothing stored: only the block with today (14.11) is open
  let A = await open('', true, 1300, 'clear');
  r.ok('8 blocks: 1–4, 5–8, 9–12, 13–14 | 15–18 … 27–30', A.qa('#itin [data-block]').map(b => b.dataset.block).join() === BLOCK_IDS.join() && A.qa(`[data-block="${D(13)}"] .itin-day`).length === 2 && A.qa(`[data-block="${D(27)}"] .itin-day`).length === 4);
  r.ok('headers: range + days + items', /^13–14\.11/.test(head(A, D(13)).textContent) && /2 ימים · 2 פריטים/.test(head(A, D(13)).textContent) && /4 ימים · אין פריטים/.test(head(A, D(15)).textContent), head(A, D(13)).textContent);
  r.ok('default: only 13–14 (today) open, past blocks collapsed', openBlocks(A).join() === D(13) && head(A, D(13)).getAttribute('aria-expanded') === 'true' && head(A, D(1)).getAttribute('aria-expanded') === 'false');
  r.ok('today\'s block says so', /היום/.test(head(A, D(13)).textContent) && !/היום/.test(head(A, D(1)).textContent));
  r.ok('collapsed block: one line per day instead of the cards', A.qa(`[data-compact="${D(1)}"] [data-cday]`).length === 4 && A.qq(`[data-bbody="${D(1)}"]`).hidden && A.qq(`[data-compact="${D(13)}"]`).hidden);
  r.ok('part divider still between 14.11 and 15.11', A.qq('#itin > .itin-part.after').previousElementSibling.dataset.block === D(13) && A.qq('#itin > .itin-part.after').nextElementSibling.dataset.block === D(15));
  const dots = day => [...line(A, day).querySelectorAll('.itin-cdot')];
  r.ok('line 3.11: date, weekday, title, count, one green dot', line(A, D(3)).querySelector('.itin-cdate').textContent === '3.11' && line(A, D(3)).querySelector('.itin-cwd').textContent === 'ג׳' && line(A, D(3)).querySelector('.itin-ctitle').textContent === 'אתלטיקו–באיירן' && line(A, D(3)).querySelector('.itin-ccount').textContent === '1' && dots(D(3)).length === 1 && A.w.getComputedStyle(dots(D(3))[0]).backgroundColor === 'rgb(47, 111, 78)');
  r.ok('line 11.11: two items, two gold dots', line(A, D(11)).querySelector('.itin-ccount').textContent === '2' && dots(D(11)).length === 2 && dots(D(11)).every(x => x.dataset.st === 'optional'));
  r.ok('line 8.11: the Barcelona alt counted, hollow dot', dots(D(8)).length === 1 && dots(D(8))[0].classList.contains('alt'));
  r.ok('empty day: "אין פריטים", no count, no dots', line(A, D(16)).querySelector('.itin-ctitle').textContent === 'אין פריטים' && !line(A, D(16)).querySelector('.itin-ccount') && !line(A, D(16)).querySelector('.itin-cdots'));
  r.ok('line carries the day-type colour and the part-2 tone', A.w.getComputedStyle(line(A, D(3))).borderRightColor === 'rgb(196, 38, 46)' && line(A, D(16)).classList.contains('after') && A.w.getComputedStyle(line(A, D(16))).borderTopStyle === 'dashed');
  r.ok('line is labelled for screen readers', /^3\.11, יום ג׳: אתלטיקו–באיירן · פריט אחד \(1 סגור\)/.test(line(A, D(3)).getAttribute('aria-label')), line(A, D(3)).getAttribute('aria-label'));
  r.ok('desktop: collapsed lines 4 across, 48px tall', [...new Set(A.qa(`[data-compact="${D(1)}"] [data-cday]`).map(x => Math.round(x.getBoundingClientRect().top)))].length === 1 && A.qa('#itin [data-cday]').filter(x => x.offsetParent).every(x => x.getBoundingClientRect().height >= 44));
  r.ok('nothing stored until you choose', !localStorage.getItem(VIEW_KEY));

  // 2. one click toggles, remembered on this device
  head(A, D(1)).click();
  r.ok('click opens 1–4.11', openBlocks(A).join() === `${D(1)},${D(13)}` && head(A, D(1)).getAttribute('aria-expanded') === 'true' && A.qq(`[data-compact="${D(1)}"]`).hidden);
  head(A, D(13)).click();
  r.ok('click collapses today\'s block too', openBlocks(A).join() === D(1));
  r.ok('stored: only what was clicked', canonJson(storedView()) === canonJson({ [D(1)]: true, [D(13)]: false }), storedView());
  A.f.remove();
  A = await open('', true, 1300, null);
  r.ok('reload: same blocks open and closed', openBlocks(A).join() === D(1));
  A.f.remove();
  A = await open('today=2026-11-20', true, 1300, null);
  r.ok('next week: the new today block opens, the stored choices stay', openBlocks(A).join() === `${D(1)},${D(19)}`);
  A.f.remove();

  // 3. default by date
  for (const [today, want] of [['2026-11-20', D(19)], ['2026-11-30', D(27)], ['2026-11-01', D(1)], ['2026-10-20', D(1)], ['2026-12-05', '']]) {
    const P = await open(`today=${today}`, true, 1300, 'clear');
    r.ok(`default on ${today}: ${want || 'nothing'} open`, openBlocks(P).join() === want, openBlocks(P));
    P.f.remove();
  }

  // 4. expand all / collapse all, the line opens its block
  A = await open('', true, 1300, 'clear');
  A.qq('#itin [data-bact="all"][data-id="open"]').click();
  r.ok('expand all: 8 open, all 30 cards visible', openBlocks(A).length === 8 && A.qa('.itin-day').every(d => d.offsetParent) && Object.values(storedView()).filter(Boolean).length === 8);
  A.qq('#itin [data-bact="all"][data-id="close"]').click();
  r.ok('collapse all: none open (today\'s too), 30 lines', openBlocks(A).length === 0 && A.qa('#itin [data-cday]').filter(x => x.offsetParent).length === 30 && Object.values(storedView()).every(v => v === false));
  line(A, D(10)).click();
  r.ok('tapping the 10.11 line opens 9–12.11', openBlocks(A).join() === D(9) && A.w.document.activeElement === head(A, D(9)));
  await sleep(1200);
  r.ok('view changes write nothing to Firestore or the local data copy', !(await getDoc(ref())).exists() && localStorage.getItem(LOCAL_KEY) === null);

  // 5. "ליום הבא" into a collapsed block opens it and keeps focus on the item
  act(A, 'menu', 'i12'); act(A, 'next', 'i12');
  r.ok('next day into collapsed 13–14 opens it', mainIds(A, D(13)).join() === 'i13,i12' && openBlocks(A).join() === `${D(9)},${D(13)}` && A.w.document.activeElement && A.w.document.activeElement.dataset.id === 'i12');
  act(A, 'prev', 'i12');
  head(A, D(13)).click();

  // 6. drag onto a collapsed day line: end of that day, block stays collapsed
  const dt = new A.w.DataTransfer();
  const src = A.qq('[data-item="i10"]'), tgt = line(A, D(6)), tr = tgt.getBoundingClientRect();
  src.dispatchEvent(new A.w.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const over = new A.w.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tr.left + 30, clientY: tr.top + 10 });
  tgt.dispatchEvent(over);
  r.ok('dragover a collapsed line: accepted, highlighted, no drop line', over.defaultPrevented && tgt.classList.contains('drop-on') && !A.qq('.itin-dropline'));
  tgt.dispatchEvent(new A.w.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tr.left + 30, clientY: tr.top + 10 }));
  src.dispatchEvent(new A.w.DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  r.ok('dropped at the end of 6.11, 5–8 still collapsed, count updated', mainIds(A, D(6)).join() === 'i06,i10' && openBlocks(A).join() === D(9) && line(A, D(6)).querySelector('.itin-ccount').textContent === '2' && !A.qq('.drop-on, .dragging'));
  r.ok('the line confirms the drop', line(A, D(6)).classList.contains('dropped'));
  let d = await docWhen(x => x.items.i10.day === D(6));
  r.ok('drop on a collapsed line persisted', d && d.items.i10.day === D(6) && d.items.i10.order === 1);

  // 7. holding a drag over a collapsed header opens it (and nothing else moves)
  const dt2 = new A.w.DataTransfer();
  const s2 = A.qq('[data-item="i09"]'), h1 = head(A, D(1)), hr = h1.getBoundingClientRect();
  s2.dispatchEvent(new A.w.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt2 }));
  h1.dispatchEvent(new A.w.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2, clientX: hr.left + 40, clientY: hr.top + 10 }));
  r.ok('over a collapsed header: waiting, marked', h1.classList.contains('spring') && openBlocks(A).join() === D(9));
  await sleep(1600); // SPRING_MS is 600; timers in a background tab can run late
  r.ok('after the hold: 1–4.11 opens mid-drag', openBlocks(A).join() === `${D(1)},${D(9)}` && !h1.classList.contains('spring') && !!A.qq('[data-item="i09"].dragging'));
  const c3 = A.qq(`[data-list="${D(3)}"]`), c3r = c3.getBoundingClientRect();
  c3.dispatchEvent(new A.w.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt2, clientX: c3r.left + 20, clientY: c3r.bottom - 2 }));
  c3.dispatchEvent(new A.w.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt2, clientX: c3r.left + 20, clientY: c3r.bottom - 2 }));
  s2.dispatchEvent(new A.w.DragEvent('dragend', { bubbles: true, dataTransfer: dt2 }));
  r.ok('…and the item drops onto 3.11 inside it', mainIds(A, D(3)).join() === 'i03,i09');
  // a drag that only passes over a header does not open it
  const dt3 = new A.w.DataTransfer();
  const s3 = A.qq('[data-item="i09"]'), h5 = head(A, D(5)), h5r = h5.getBoundingClientRect();
  s3.dispatchEvent(new A.w.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt3 }));
  h5.dispatchEvent(new A.w.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt3, clientX: h5r.left + 40, clientY: h5r.top + 10 }));
  s3.dispatchEvent(new A.w.DragEvent('dragend', { bubbles: true, dataTransfer: dt3 }));
  await sleep(1600);
  r.ok('passing over a header without holding: stays collapsed', !openBlocks(A).includes(D(5)) && !A.qq('.spring'));
  await waitIdle(A);
  A.f.remove();

  // 8. read-only (failed load): the cards are inert, the view still works
  {
    const P = await open('loadtest=fail', true, 1300, 'none');
    r.ok('failed load: cards inert, headers/lines/tools not', cardsInert(P) && !isInert(head(P, D(1))) && !isInert(line(P, D(2))) && !isInert(P.qq('#itin [data-bact="all"]')));
    head(P, D(1)).click();
    r.ok('failed load: a block can still be opened to read', openBlocks(P).join() === D(1));
    line(P, D(6)).click();
    r.ok('failed load: and from its line', openBlocks(P).join() === `${D(1)},${D(5)}`);
    P.f.remove();
  }

  // 9. phone: one column, thumb-sized headers and lines, no sideways scroll
  const M = await open('', true, 390, 'clear');
  const visLines = M.qa('#itin [data-cday]').filter(x => x.offsetParent);
  r.ok('phone: one line per row', visLines.length === 28 && [...new Set(M.qa(`[data-compact="${D(1)}"] [data-cday]`).map(x => Math.round(x.getBoundingClientRect().left)))].length === 1);
  r.ok('phone: lines and headers >= 44px tall, full width', visLines.every(x => x.getBoundingClientRect().height >= 44 && x.getBoundingClientRect().width > 300) && M.qa('#itin [data-bhead]').every(x => x.getBoundingClientRect().height >= 44), visLines.map(x => Math.round(x.getBoundingClientRect().height)).slice(0, 4));
  r.ok('phone: expand/collapse all are tappable (>= 36px)', M.qa('#itin [data-bact="all"]').every(x => x.getBoundingClientRect().height >= 36));
  r.ok('phone: no horizontal page scroll', M.w.document.documentElement.scrollWidth <= M.w.innerWidth);
  M.qq('#itin [data-bact="all"][data-id="open"]').click();
  r.ok('phone, all open: still no horizontal scroll', M.w.document.documentElement.scrollWidth <= M.w.innerWidth);
  M.f.remove();

  localStorage.removeItem(VIEW_KEY);
  await fresh();
  r.ok('real itinerary doc untouched', (await realSnap()) === realBefore);
  return r.result();
}

export async function dropTestDoc() {
  await guard();
  await deleteDoc(ref());
  localStorage.removeItem(LOCAL_KEY);
  return !(await getDoc(ref())).exists();
}
