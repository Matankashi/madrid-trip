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
        await t.dropTestDoc();   // deletes itinerary_test + the local test copy
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
async function open(query = '', wait = true, width) {
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
  r.ok('loads ready', A.qq('#itinBanner').hidden && !isInert(A.qq('#itin')), A.qq('#itinBanner').textContent);
  r.ok('14 day blocks, 1.11 to 14.11', A.qa('.itin-day').length === 14 && A.qq('.itin-day .itin-date').textContent === '1.11' && A.qa('.itin-date').pop().textContent === '14.11');
  r.ok('14 items (Thyssen on 11.11) + one alt occurrence', A.qa('[data-item]').length === 14 && mainIds(A, D(11)).join() === 'i11,i11b' && A.qq('[data-item="i11b"]').classList.contains('st-optional') && A.qa('[data-alt]').length === 1);
  r.ok('weekday: 1.11 is Sunday, 14.11 Saturday', A.qq('.itin-wd').textContent === 'יום א׳' && A.qa('.itin-wd').pop().textContent === 'יום ש׳');
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
  // layout: 7 across in two rows on desktop, wider than the text column
  const tops = P => [...new Set(P.qa('.itin-day').map(d => Math.round(d.getBoundingClientRect().top)))];
  const firstRow = P => P.qa('.itin-day').filter(d => Math.round(d.getBoundingClientRect().top) === tops(P)[0]).length;
  r.ok('desktop: 2 rows of 7', tops(A).length === 2 && firstRow(A) === 7, { rows: tops(A).length, first: firstRow(A) });
  r.ok('desktop: board breaks out of the 780px text column', A.qq('#itin').getBoundingClientRect().width > 1100, A.qq('#itin').getBoundingClientRect().width);
  r.ok('desktop: RTL — 1.11 is the right-most card', A.qq('[data-day="2026-11-01"]').getBoundingClientRect().right > A.qq('[data-day="2026-11-07"]').getBoundingClientRect().right);
  r.ok('desktop: no horizontal page scroll', A.w.document.documentElement.scrollWidth <= A.w.innerWidth);
  const badgesRow = A.qa('.itin-day').slice(0, 7).map(d => Math.round(d.querySelector('.itin-badge').getBoundingClientRect().bottom));
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
  r.ok('tile kind per day', kinds.join() === 'arrival,city,football,museum,daytrip,museum,football,football,city,daytrip,museum,city,night,open', kinds);
  r.ok('tile has a big icon and the kind colour', !!A.qq('[data-day="2026-11-03"] .itin-tile svg') && A.w.getComputedStyle(A.qq('[data-day="2026-11-03"] .itin-tile')).color === 'rgb(196, 38, 46)');
  // summary under the board, derived from the items
  const sum = st => A.qa(`[data-sum="${st}"] [data-sum-item]`).map(li => li.dataset.sumItem);
  r.ok('summary: booked = Onefam line + the three booked items', /Onefam/.test(A.qq('.sum.st-booked .sum-fixed').textContent) && sum('booked').join() === 'i01,i03,i07', sum('booked'));
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
  setF(A, 'title', 'בדיקה: רטירו'); setF(A, 'desc', 'תיאור בדיקה'); setF(A, 'status', 'optional'); setF(A, 'url', 'example.com/x');
  act(A, 'save', 'i02');
  r.ok('saved card shows the new values', titleOf(A, 'i02') === 'בדיקה: רטירו' && A.qq('[data-item="i02"]').classList.contains('st-optional') && A.qq('[data-item="i02"] .itin-badge').textContent === 'OPTIONAL' && A.qq('[data-item="i02"] .itin-points li').textContent === 'תיאור בדיקה' && A.qq('[data-item="i02"] .itin-link').href === 'https://example.com/x' && A.qq('[data-item="i02"] .itin-link').target === '_blank');
  r.ok('after saving, the card is back in the grid', A.qq(`[data-day="${D(2)}"]`).getBoundingClientRect().width < 300);
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
  r.ok('no previous day on 1.11, no next day on 14.11', A.qq('[data-act="prev"][data-id="i01"]').disabled && A.qq('[data-act="next"][data-id="i14"]').disabled);
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
  const conflicted = p => !p.qq('#itinBanner').hidden && p.qq('#itinBanner').textContent === MSG_CONFLICT && isInert(p.qq('#itin'));
  const clean = p => p.qq('#itinBanner').hidden && !isInert(p.qq('#itin'));

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
  r.ok('slow: inert with a loading notice', isInert(P.qq('#itin')) && !P.qq('#itinBanner').hidden && /טוען/.test(P.qq('#itinBanner').textContent));
  act(P, 'next', 'i01'); act(P, 'del', 'i02');
  for (let i = 0; i < 40 && !settled(P); i++) await sleep(200);
  await sleep(1200);
  r.ok('slow: pre-load clicks wrote nothing', canonJson((await getDoc(ref())).data()) === canonJson(base) && localStorage.getItem(LOCAL_KEY) === null);
  r.ok('slow: then shows the doc', titleOf(P, 'i01') === 'מהשרת' && P.qa('[data-item]').length === 1 && !isInert(P.qq('#itin')));
  // unknown fields survive a save
  act(P, 'edit', 'i01'); setF(P, 'desc', 'נוסף'); act(P, 'save', 'i01');
  let d = await docWhen(x => x.items.i01.desc === 'נוסף');
  r.ok('unknown top-level, item and day fields are kept', d && d.futureField && d.futureField.a === 1 && d.items.i01.extra === 'keep' && d.days[D(2)].future === 1 && d.days[D(2)].title === 'שמור', d);
  P.f.remove();

  // failed load with a local copy: read-only, local shown, nothing written
  await setDoc(ref(), base);
  localStorage.setItem(LOCAL_KEY, JSON.stringify(localCopy));
  P = await open('loadtest=fail');
  r.ok('fail: local copy shown read-only', titleOf(P, 'i01') === 'מקומי' && isInert(P.qq('#itin')) && /העותק האחרון/.test(P.qq('#itinBanner').textContent));
  act(P, 'next', 'i01'); act(P, 'edit', 'i01'); await sleep(1500);
  r.ok('fail: clicks write nothing (doc + local)', canonJson((await getDoc(ref())).data()) === canonJson(base) && localStorage.getItem(LOCAL_KEY) === JSON.stringify(localCopy));
  P.f.remove();

  // failed load, no local copy: the original itinerary, read-only
  localStorage.removeItem(LOCAL_KEY);
  P = await open('loadtest=fail');
  r.ok('fail, no local: seed shown read-only', P.qa('[data-item]').length === 14 && isInert(P.qq('#itin')) && /אין עותק שמור/.test(P.qq('#itinBanner').textContent));
  P.f.remove();

  // no doc yet + a local copy (e.g. edited offline before the first save): local wins
  await deleteDoc(ref());
  localStorage.setItem(LOCAL_KEY, JSON.stringify(localCopy));
  P = await open();
  r.ok('no doc: local copy loaded, editable', titleOf(P, 'i01') === 'מקומי' && !isInert(P.qq('#itin')));
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
  r.ok('three open tasks left', checks.length === 3 && /ביטוח/.test(checks[0].textContent) && /Resident Advisor/.test(checks[1].textContent) && /14\.11/.test(checks[2].textContent));
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

export async function dropTestDoc() {
  await guard();
  await deleteDoc(ref());
  localStorage.removeItem(LOCAL_KEY);
  return !(await getDoc(ref())).exists();
}
