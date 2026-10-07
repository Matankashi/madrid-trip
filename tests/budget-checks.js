/* Browser regression checks for budget.html. No framework, no build step.

   HOW TO RUN (against a scratch doc, never the real one)
   1. python3 tests/serve-test.py            (rewrites the doc to state/budget_test)
   2. Open http://localhost:8000/budget.html in a Chrome that is signed in.
   3. In the console (or via automation):
        const t = await import('/tests/budget-checks.js');
        await t.seed();                       // writes the fixture into budget_test
        location.reload();                    // then, after it loads:
        const t = await import('/tests/budget-checks.js');
        await t.phaseA();                     // main checks; leaves one row behind
        location.reload();                    // then, after it loads:
        const t = await import('/tests/budget-checks.js');
        await t.phaseB();                     // persistence checks + cleanup
        await t.seed(); location.reload();    // fresh fixture, then after it loads:
        await t.phaseC();                     // row details, links, edit mode, rename, CSS
        await t.seedLegacy(); location.reload();   // a v1.10-shaped doc (no userRows/rowMeta)
        await t.phaseLegacy();                // old documents still load fine
        await t.phaseLoad();                  // load-time overwrite paths (reseeds itself, ~20s)
        await t.phaseStay();                  // flat accommodation total + lock (reseeds itself)
        await t.phaseMigrate();               // shirt/scale/internet -> user rows (reseeds itself)
        await t.phaseGuard();                 // another tab/device changed the doc -> refuse to save (reseeds itself)
        await t.phaseRename();                // rename built-in rows (reseeds itself)
        await t.dropTestDoc();                // deletes budget_test
   Every function returns {passed, failed, failures:[...]}.

   seed()/dropTestDoc() throw unless the served budget.js really targets
   budget_test, so running this against a normally served page is refused. */

import { db, auth } from '/assets/firebase-init.js';
import { doc, getDoc, setDoc, deleteDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = s => document.querySelector(s);

async function guard() {
  const src = await (await fetch('/assets/budget.js', { cache: 'no-store' })).text();
  if (!src.includes("'state', 'budget_test')")) {
    throw new Error("budget.js is not served by tests/serve-test.py (doc is not budget_test) - refusing to run");
  }
  return src;
}
const ref = () => doc(db, 'users', auth.currentUser.uid, 'state', 'budget_test');
// waits until no page (this one or a test iframe) has a save pending — see __budgetIdle in serve-test.py
const allIdle = () => [window, ...[...document.querySelectorAll('iframe')].map(f => f.contentWindow)].every(w => !w.__budgetIdle || w.__budgetIdle());
const readDoc = async () => { await sleep(300); for (let i = 0; i < 80 && !allIdle(); i++) await sleep(150); return (await getDoc(ref())).data(); };

function reporter() {
  const failures = []; let passed = 0;
  return {
    ok(name, cond, detail) { if (cond) passed++; else failures.push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`); },
    result() { return { passed, failed: failures.length, failures }; }
  };
}

const FIXTURE = {
  tier: 'custom', showTierRefs: true,
  userRows: {
    u_t1: { label: 'בדיקה 1', group: 'trips', createdAt: 1 },
    u_t2: { label: 'בדיקה 2', group: 'misc', createdAt: 2 }
  },
  custom: {
    // every fixed row is listed explicitly (as in the real doc): a row missing here would
    // fall back to the HTML default and change the totals
    values: { days: '12', nights: '11', tripCount: '2', flight: '486', airport: '', nightly: '', daily: '', barca: '1053.8', ucl: '', tour: '', metro: '', trip: '', museums: '', misc: '50', u_t1: '100', u_t2: '20', u_orphan: '999' },
    currencies: { flight: 'ILS', airport: 'EUR', nightly: 'EUR', daily: 'EUR', barca: 'ILS', ucl: 'EUR', tour: 'EUR', metro: 'EUR', trip: 'EUR', museums: 'EUR', misc: 'EUR', u_t1: 'EUR', u_t2: 'USD', u_orphan: 'EUR' }
  },
  rowMeta: {
    flight: { desc: 'אל על · הלוך', url: 'https://example.com/flight', zz_future: 'keep' },
    barca: { url: 'booking.com/x?y=1' },
    u_t1: { desc: 'תיאור פנימי', url: 'javascript:alert(1)' },
    museums: { desc: 'רק תיאור' },
    u_orphan: { desc: 'יתום' }
  },
  toggles: { trip: true, tour: false, ucl: true },
  locks: {
    flight: { amount: '486', currency: 'ILS', rate: 3.5, chargedOn: '2026-09-10' },
    u_t2: { amount: '20', currency: 'USD', rate: 1.1, chargedOn: '2026-09-20' },
    u_orphan: { amount: '999', currency: 'EUR', rate: 1, chargedOn: '2026-09-20' }
  },
  rates: { usd: { value: '1.1', updatedAt: '2026-09-01' }, ils: { value: '3.5', updatedAt: '2026-09-01' } },
  zz_future: { keep: true }
};
// custom total: flight lock 486/3.5 + barca 1053.8/3.5 + misc 50 + u_t1 100 + u_t2 lock 20/1.1
const EXPECTED_CUSTOM_TOTAL = 486 / 3.5 + 1053.8 / 3.5 + 50 + 100 + 20 / 1.1;
const EXPECTED_RESERVE_USED = 50 + 100 + 20 / 1.1; // misc + user rows

export async function seed() {
  await guard();
  await setDoc(ref(), FIXTURE);
  return 'seeded budget_test';
}

// the shape written by v1.10 and earlier: no userRows, no rowMeta
const LEGACY = {
  tier: 'custom', showTierRefs: true,
  custom: {
    values: { days: '12', nights: '11', tripCount: '2', flight: '486', airport: '', nightly: '', daily: '', barca: '1053.8', ucl: '', tour: '', metro: '', trip: '', museums: '', shirt: '', scale: '', internet: '', misc: '' },
    currencies: { flight: 'ILS', airport: 'EUR', nightly: 'EUR', daily: 'EUR', barca: 'ILS', ucl: 'EUR', tour: 'EUR', metro: 'EUR', trip: 'EUR', museums: 'EUR', shirt: 'EUR', scale: 'EUR', internet: 'EUR', misc: 'EUR' }
  },
  toggles: { trip: true, tour: false, ucl: true },
  locks: { flight: { amount: '486', currency: 'ILS', rate: 3.5, chargedOn: '2026-09-10' } },
  rates: { usd: { value: '1.1', updatedAt: '2026-09-01' }, ils: { value: '3.5', updatedAt: '2026-09-01' } }
};

export async function seedLegacy() {
  await guard();
  await setDoc(ref(), LEGACY);
  return 'seeded legacy budget_test';
}

export async function dropTestDoc() {
  await guard();
  await deleteDoc(ref());
  return 'deleted budget_test';
}

function presetsFrom(src) {
  return (new Function('return ' + src.match(/const PRESETS = (\{[\s\S]*?\n\});/)[1]))();
}
const rate = c => c === 'USD' ? parseFloat(q('#rateUsd').value) : c === 'ILS' ? parseFloat(q('#rateIls').value) : 1;
function expectedPresetTotal(P, t) {
  const tog = { ucl: true, tour: false, trip: true };
  let tot = 0;
  Object.keys(P[t]).forEach(id => {
    if (id === 'tripCount') return;
    if (id in tog && !tog[id]) return;
    let a = P[t][id];
    if (id === 'nightly') a *= 11;
    if (id === 'daily') a *= 12;
    if (id === 'trip') a *= P[t].tripCount;
    tot += a;
  });
  return Math.round(tot);
}
const totalNum = () => parseInt(q('#totEur').textContent.replace(/[^0-9-]/g, ''), 10);
const shown = el => !!el && el.style.display !== 'none';

export async function phaseA() {
  const src = await guard();
  const r = reporter();
  const P = presetsFrom(src);
  // the page normalises the doc on its first save (fills in every fixed row's
  // value/currency), so take the baseline after one harmless save (net-zero toggle)
  q('[data-tog="tour"]').click(); await sleep(150); q('[data-tog="tour"]').click();
  const d0 = await readDoc();
  r.ok('fixture loaded (tier custom)', d0.tier === 'custom', d0.tier);

  // 1. custom view with user rows present
  r.ok('user rows rendered', !!q('[data-item="u_t1"]') && !!q('[data-item="u_t2"]'));
  r.ok('user row in the right group (trips)', q('[data-item="u_t1"]').parentElement === q('[data-pct="trips"]').closest('h2').nextElementSibling);
  r.ok('orphan id not rendered', !q('[data-item="u_orphan"]'));
  r.ok('custom total counts user rows, ignores orphan lock', Math.abs(totalNum() - Math.round(EXPECTED_CUSTOM_TOTAL)) <= 1, { shown: q('#totEur').textContent, expected: Math.round(EXPECTED_CUSTOM_TOTAL) });
  // regression for presetTotalEur reading preset[id] of a user row: the totals go NaN and
  // buildTierCompareText silently degrades to just "€N" with no comparison at all
  r.ok('tier comparison still compares against the tiers with user rows present', /(מתחת ל|מעל |בין |בדיוק כמו)/.test(q('#tierCompare').textContent) && !/NaN/.test(q('#tierCompare').textContent), q('#tierCompare').textContent);
  const usedMatch = q('#reserveLine').textContent.match(/€([0-9,]+) מתוך/);
  r.ok('reserve line = misc + user rows', usedMatch && Math.abs(parseInt(usedMatch[1].replace(/,/g, ''), 10) - Math.round(EXPECTED_RESERVE_USED)) <= 1, q('#reserveLine').textContent);
  r.ok('user row reference says reserve (no per-row figures)', /נספר ברזרבה/.test(q('[data-tier-ref="u_t1"]').textContent) && !/€\d+ · €\d+/.test(q('[data-tier-ref="u_t1"]').textContent), q('[data-tier-ref="u_t1"]').textContent);
  r.ok('locked user row: delete disabled', q('[data-delbtn="u_t2"]').disabled === true);

  // 2. preset tiers: totals exact (regression: presetTotalEur must not read user rows), rows hidden
  for (const t of ['lean', 'mid', 'rich']) {
    q(`.tier[data-tier="${t}"]`).click(); await sleep(300);
    r.ok(`${t}: total is the exact original plan`, totalNum() === expectedPresetTotal(P, t), { shown: q('#totEur').textContent, expected: expectedPresetTotal(P, t) });
    r.ok(`${t}: user rows hidden`, !shown(q('[data-item="u_t1"]')) && !shown(q('[data-item="u_t2"]')));
    r.ok(`${t}: shirt/scale/internet are no longer fixed rows`, ['shirt', 'scale', 'internet'].every(id => !q(`[data-item="${id}"]`)));
    r.ok(`${t}: emptied group header hidden, populated group visible`, !shown(q('[data-pct="pre"]').closest('h2')) && shown(q('[data-pct="metro"]').closest('h2')));
    r.ok(`${t}: add buttons hidden`, [...document.querySelectorAll('[data-addwrap]')].every(w => w.style.display === 'none'));
    r.ok(`${t}: no visible NaN`, !/NaN/.test(document.body.innerText));
  }
  const dPreset = await readDoc();
  const canon = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
  r.ok('preset tier changed only `tier` in Firestore', canon({ ...dPreset, tier: 'custom' }) === canon(d0), 'docs differ beyond tier');
  q('.tier[data-tier="custom"]').click(); await sleep(300);
  r.ok('back in custom: user rows and groups visible again', shown(q('[data-item="u_t1"]')) && shown(q('[data-pct="pre"]').closest('h2')));

  // 3. delete flow on an UNLOCKED user row: cancel keeps, confirm deletes everything in one save
  q('[data-delbtn="u_t1"]').click(); await sleep(100);
  r.ok('inline confirm appears', !q('[data-delconfirm="u_t1"]').hidden && q('[data-delbtn="u_t1"]').hidden);
  q('[data-delno="u_t1"]').click(); await sleep(100);
  r.ok('"no" cancels', !!q('[data-item="u_t1"]') && q('[data-delconfirm="u_t1"]').hidden);
  q('[data-delbtn="u_t2"]').click(); await sleep(100);
  r.ok('locked row cannot enter delete flow', q('[data-delconfirm="u_t2"]').hidden && !!q('[data-item="u_t2"]'));
  q('[data-delbtn="u_t1"]').click(); await sleep(100);
  q('[data-delyes="u_t1"]').click();
  const dDel = await readDoc();
  r.ok('deleted row gone from DOM', !q('[data-item="u_t1"]'));
  r.ok('delete removed definition, value, currency and lock together', !('u_t1' in (dDel.userRows || {})) && !('u_t1' in dDel.custom.values) && !('u_t1' in dDel.custom.currencies) && !('u_t1' in dDel.locks));
  r.ok('other user row and its lock untouched', dDel.userRows.u_t2 && dDel.locks.u_t2 && dDel.custom.values.u_t2 === '20');
  r.ok('orphan lock preserved, not counted', dDel.locks.u_orphan && dDel.custom.values.u_orphan === '999' && Math.abs(totalNum() - Math.round(EXPECTED_CUSTOM_TOTAL - 100)) <= 1, { total: q('#totEur').textContent });
  r.ok('unknown top-level field preserved', dDel.zz_future && dDel.zz_future.keep === true);

  // 4. unlock then delete the previously locked row
  q('[data-lockbtn="u_t2"]').click(); await sleep(100);
  r.ok('unlocked: delete enabled', q('[data-delbtn="u_t2"]').disabled === false);
  q('[data-delbtn="u_t2"]').click(); await sleep(50); q('[data-delyes="u_t2"]').click();
  const dDel2 = await readDoc();
  r.ok('unlock-then-delete leaves no residue', !('u_t2' in (dDel2.userRows || {})) && !('u_t2' in dDel2.locks) && !('u_t2' in dDel2.custom.values) && !('u_t2' in dDel2.custom.currencies));

  // 5. add a row through the UI; it stays for phase B
  q('[data-addrow="ball"]').click(); await sleep(100);
  const form = q('[data-addform="ball"]');
  r.ok('add form opens', !form.hidden);
  form.querySelector('input').value = '  שורה חדשה <b>x</b>  ';
  form.requestSubmit(); await sleep(200);
  const newRow = [...document.querySelectorAll('[data-user-row]')].find(x => x.querySelector('.name').textContent === 'שורה חדשה <b>x</b>');
  r.ok('label trimmed and rendered as text, not HTML', !!newRow && !newRow.querySelector('.name b'));
  r.ok('new row lands in the chosen group', newRow && newRow.parentElement === q('[data-pct="ball"]').closest('h2').nextElementSibling);
  const dAdd = await readDoc();
  const newId = newRow && newRow.dataset.item;
  r.ok('new row persisted (definition, value, currency)', newId && dAdd.userRows[newId] && dAdd.userRows[newId].group === 'ball' && newId in dAdd.custom.values && dAdd.custom.currencies[newId] === 'EUR');
  r.ok('new id is namespaced u_', /^u_[a-z0-9]+$/.test(newId || ''));
  // give it a locked charge so phase B can check the lock round-trips
  const inp = q(`[data-in="${newId}"]`); inp.value = '40'; inp.dispatchEvent(new Event('input', { bubbles: true }));
  q(`[data-lockbtn="${newId}"]`).click();
  const dLock = await readDoc();
  r.ok('lock on a user row stored in locks[id]', dLock.locks[newId] && dLock.locks[newId].amount === '40');
  return r.result();
}

export async function phaseB() {
  await guard();
  const r = reporter();
  const d = await readDoc();
  const ids = Object.keys(d.userRows || {});
  r.ok('exactly one user row survived', ids.length === 1, ids);
  const id = ids[0];
  r.ok('row reloaded from Firestore into the right group', !!q(`[data-item="${id}"]`) && q(`[data-item="${id}"]`).parentElement === q('[data-pct="ball"]').closest('h2').nextElementSibling);
  r.ok('reloaded row is locked and its delete is disabled', q(`[data-item="${id}"]`).classList.contains('locked') && q(`[data-delbtn="${id}"]`).disabled);
  r.ok('deleted rows did not come back', !q('[data-item="u_t1"]') && !q('[data-item="u_t2"]'));
  r.ok('orphan lock still preserved after reload + save', d.locks.u_orphan && d.zz_future && d.zz_future.keep);
  r.ok('total after reload has no NaN', !/NaN/.test(document.body.innerText));
  // cleanup the leftover row
  q(`[data-lockbtn="${id}"]`).click(); await sleep(100);
  q(`[data-delbtn="${id}"]`).click(); await sleep(50); q(`[data-delyes="${id}"]`).click();
  const d2 = await readDoc();
  r.ok('final delete clears everything', !(id in d2.userRows) && !(id in d2.locks) && !(id in d2.custom.values) && !(id in d2.custom.currencies));
  return r.result();
}

const vis = el => !!el && el.getClientRects().length > 0;
const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const cs = el => getComputedStyle(el).display;

export async function phaseC() {
  await guard();
  const r = reporter();
  // ---- 1. display: links, descriptions, nothing extra when empty
  const a = q('[data-link-view="flight"]');
  r.ok('row with a link shows a tappable link', vis(a) && a.getAttribute('href') === 'https://example.com/flight', a && a.getAttribute('href'));
  r.ok('link opens in a new tab, safely', a.target === '_blank' && /noopener/.test(a.rel) && /noreferrer/.test(a.rel), a.rel);
  r.ok('link is phone-sized (>= 40px tall)', a.getBoundingClientRect().height >= 40, a.getBoundingClientRect().height);
  r.ok('link shows the host', /example\.com/.test(a.textContent), a.textContent);
  r.ok('description shown next to the link', q('[data-desc-view="flight"]').textContent === 'אל על · הלוך' && vis(q('[data-desc-view="flight"]')));
  const b = q('[data-link-view="barca"]');
  r.ok('link without a scheme gets https://', vis(b) && b.getAttribute('href') === 'https://booking.com/x?y=1', b && b.getAttribute('href'));
  const bad = q('[data-link-view="u_t1"]');
  r.ok('javascript: URL is never rendered as a link', !vis(bad) && !bad.hasAttribute('href'));
  r.ok('description-only row: text shown, no link', vis(q('[data-desc-view="museums"]')) && !vis(q('[data-link-view="museums"]')));
  r.ok('row with no details shows nothing extra (zero height)', q('[data-meta="airport"]').getBoundingClientRect().height === 0 && !vis(q('[data-desc-view="airport"]')) && !vis(q('[data-link-view="airport"]')) && !vis(q('[data-meta-edit="airport"]')));
  r.ok('user rows get the same details UI', !!q('[data-meta="u_t1"]') && !!q('[data-desc-in="u_t2"]'));

  // ---- 2. edit mode (custom only)
  // no global checkbox any more: each row has its own button, inside the row
  r.ok('global edit checkbox is gone', !q('#metaToggle') && !q('#metaToggleWrap'));
  const ROWS = ['airport', 'flight', 'misc', 'u_t1', 'u_t2'];
  r.ok('every row (fixed and user) has its own details button, inside the row, visible in custom', ROWS.every(id => { const b = q(`[data-metabtn="${id}"]`); return vis(b) && b.closest('[data-item]') === q(`[data-item="${id}"]`); }));
  r.ok('editors hidden by default', ROWS.every(id => !vis(q(`[data-meta-edit="${id}"]`))));
  r.ok('button says add when the row has no details, edit when it has', q('[data-metabtn="airport"]').textContent === '＋ תיאור וקישור' && q('[data-metabtn="flight"]').textContent === 'ערוך תיאור וקישור');
  q('[data-metabtn="airport"]').click(); await sleep(100);
  r.ok('one button opens only its own row, focused on the description', vis(q('[data-meta-edit="airport"]')) && !vis(q('[data-meta-edit="flight"]')) && document.activeElement === q('[data-desc-in="airport"]') && q('[data-metabtn="airport"]').getAttribute('aria-expanded') === 'true');
  q('[data-metabtn="airport"]').click(); await sleep(100);
  r.ok('clicking again closes it', !vis(q('[data-meta-edit="airport"]')) && q('[data-metabtn="airport"]').textContent === '＋ תיאור וקישור');
  ROWS.forEach(id => q(`[data-metabtn="${id}"]`).click()); await sleep(150);
  r.ok('all opened: every row (fixed and user) shows the two inputs', ['airport', 'flight', 'misc', 'u_t1', 'u_t2'].every(id => vis(q(`[data-desc-in="${id}"]`)) && vis(q(`[data-link-in="${id}"]`))));
  r.ok('inputs hold the saved values', q('[data-desc-in="flight"]').value === 'אל על · הלוך' && q('[data-link-in="barca"]').value === 'booking.com/x?y=1');
  setVal(q('[data-desc-in="airport"]'), '  מטרו לעיר  ');
  setVal(q('[data-link-in="airport"]'), 'https://maps.google.com/?q=Atocha');
  let d = await readDoc();
  r.ok('description and link persist to Firestore (trimmed)', d.rowMeta.airport && d.rowMeta.airport.desc === 'מטרו לעיר' && d.rowMeta.airport.url === 'https://maps.google.com/?q=Atocha', d.rowMeta.airport);
  r.ok('new link renders immediately', vis(q('[data-link-view="airport"]')) && q('[data-link-view="airport"]').getAttribute('href').startsWith('https://maps.google.com'));
  setVal(q('[data-link-in="airport"]'), 'not a url');
  await sleep(150);
  r.ok('invalid link: error shown, no link rendered', vis(q('[data-link-err="airport"]')) && !vis(q('[data-link-view="airport"]')) && q('[data-link-in="airport"]').classList.contains('invalid'));
  d = await readDoc();
  r.ok('invalid text is kept as typed (nothing lost mid-edit)', d.rowMeta.airport.url === 'not a url');
  // what counts as a link: only http(s) with a real host and no spaces. Free text must never become a link.
  const cases = [
    ['hostel booking', false], ['booking', false], ['javascript:alert(1)', false], ['data:text/html,hi', false],
    ['ftp://example.com/a', false], ['example.com/a b', false], ['https://', false],
    ['http://example.com', true], ['HTTPS://Example.COM/x?y=1#z', true], ['www.booking.com/hotel/x', true], ['https://maps.app.goo.gl/abc', true]
  ];
  for (const [text, shouldLink] of cases) {
    setVal(q('[data-link-in="airport"]'), text); await sleep(40);
    r.ok(`link check ${JSON.stringify(text)} -> ${shouldLink ? 'link' : 'no link'}`, vis(q('[data-link-view="airport"]')) === shouldLink, q('[data-link-view="airport"]').getAttribute('href'));
  }
  setVal(q('[data-link-in="airport"]'), 'not a url'); await sleep(40);
  setVal(q('[data-desc-in="airport"]'), ''); setVal(q('[data-link-in="airport"]'), '');
  d = await readDoc();
  r.ok('clearing both removes the entry', !('airport' in d.rowMeta));
  // locked row: details stay editable, lock untouched
  const lockBefore = JSON.stringify(Object.fromEntries(Object.entries(d.locks.flight).sort()));
  setVal(q('[data-desc-in="flight"]'), 'אישור טיסה');
  d = await readDoc();
  r.ok('locked row: description editable, lock unchanged', d.rowMeta.flight.desc === 'אישור טיסה' && JSON.stringify(Object.fromEntries(Object.entries(d.locks.flight).sort())) === lockBefore);
  r.ok('unknown field inside a rowMeta entry preserved', d.rowMeta.flight.zz_future === 'keep');
  r.ok('orphan rowMeta entry preserved', d.rowMeta.u_orphan && d.rowMeta.u_orphan.desc === 'יתום');

  // ---- 3. preset tiers: read-only, links still usable
  q('.tier[data-tier="mid"]').click(); await sleep(250);
  r.ok('preset tier: details buttons and editors hidden', !vis(q('[data-metabtn="flight"]')) && !vis(q('[data-metabtn="u_t2"]')) && !vis(q('[data-meta-edit="flight"]')));
  r.ok('preset tier: existing link still shown', vis(q('[data-link-view="flight"]')));
  r.ok('preset tier: lock buttons hidden (CSS hidden-attribute fix)', [...document.querySelectorAll('[data-lockbtn]')].every(x => cs(x) === 'none'));
  r.ok('preset tier: "show reference values" checkbox hidden', cs(q('#refToggleWrap')) === 'none');
  r.ok('preset tier: rename/delete UI hidden', !vis(q('[data-delwrap="u_t1"]')) || cs(q('[data-delwrap="u_t1"]')) === 'none');
  q('.tier[data-tier="custom"]').click(); await sleep(250);
  r.ok('custom: lock buttons and reference toggle visible again', vis(q('[data-lockbtn="flight"]')) && vis(q('#refToggleWrap')));

  // ---- 4. the original bug: charge-date field on UNLOCKED rows
  r.ok('unlocked row: charge-date field hidden', cs(q('[data-lockdatewrap="airport"]')) === 'none' && !vis(q('[data-lockdate="airport"]')));
  r.ok('locked row: charge-date field visible', vis(q('[data-lockdate="flight"]')));

  // ---- 5. rename (user rows here; fixed rows in phaseRename)
  r.ok('fixed rows have a rename control too, but no delete', !!q('[data-renbtn="flight"]') && !q('[data-delbtn="flight"]'));
  const before = (await readDoc()).userRows.u_t1;
  q('[data-renbtn="u_t1"]').click(); await sleep(100);
  const rf = q('[data-renform="u_t1"]');
  r.ok('rename form opens with the current name', !rf.hidden && rf.querySelector('input').value === 'בדיקה 1');
  q('[data-ren-in="u_t1"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(100);
  r.ok('Escape cancels', rf.hidden && q('[data-item="u_t1"] .name').textContent === 'בדיקה 1');
  q('[data-renbtn="u_t1"]').click(); await sleep(50);
  rf.querySelector('input').value = '   '; rf.requestSubmit(); await sleep(100);
  r.ok('empty name is ignored', q('[data-item="u_t1"] .name').textContent === 'בדיקה 1' && rf.hidden);
  q('[data-renbtn="u_t1"]').click(); await sleep(50);
  rf.querySelector('input').value = '  מלון <i>חדש</i>  '; rf.requestSubmit();
  d = await readDoc();
  const nm = q('[data-item="u_t1"] .name');
  r.ok('renamed: trimmed, shown as text not HTML', nm.textContent === 'מלון <i>חדש</i>' && !nm.querySelector('i'));
  r.ok('rename persisted; group, createdAt, value, currency untouched', d.userRows.u_t1.label === 'מלון <i>חדש</i>' && d.userRows.u_t1.group === before.group && d.userRows.u_t1.createdAt === before.createdAt && d.custom.values.u_t1 === '100' && d.custom.currencies.u_t1 === 'EUR');
  r.ok('rename kept the details', d.rowMeta.u_t1 && d.rowMeta.u_t1.desc === 'תיאור פנימי');
  q('[data-renbtn="u_t2"]').click(); await sleep(50);
  q('[data-renform="u_t2"]').querySelector('input').value = 'נעולה'; q('[data-renform="u_t2"]').requestSubmit();
  d = await readDoc();
  r.ok('locked user row can be renamed; its lock is untouched', d.userRows.u_t2.label === 'נעולה' && d.locks.u_t2.amount === '20' && d.locks.u_t2.currency === 'USD');

  // ---- 6. deleting a user row also removes its details
  q('[data-delbtn="u_t1"]').click(); await sleep(50); q('[data-delyes="u_t1"]').click();
  d = await readDoc();
  r.ok('delete removed the row and its rowMeta entry together', !('u_t1' in d.userRows) && !('u_t1' in d.rowMeta));
  r.ok('no NaN anywhere', !/NaN/.test(document.body.innerText));
  return r.result();
}

/* ---- load-time overwrite paths (regressions found 2026-10-07) ----
   1. A tier/toggle click before the initial load resolved used to save the
      HTML defaults over the whole doc (locks, userRows, rowMeta all gone).
   2. A failed load used to fall back to the local copy, and the next edit
      saved that stale copy over the doc.
   Each check opens budget.html in an iframe with ?loadtest=slow|fail (see
   serve-test.py), pokes at it with scripted clicks/inputs — which bypass
   `inert` on purpose, so the save gate itself is what's tested, not only
   the blocked UI — and asserts the doc and the local copy are unchanged. */
const LOCAL_KEY = 'madrid.budget.test';
const canonJson = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
const isInert = el => !!el && !!el.closest('[inert]');

function openFrame(query) {
  return new Promise(resolve => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:0;top:0;width:420px;height:700px;opacity:0;pointer-events:none';
    f.onload = () => resolve(f);
    f.src = '/budget.html?' + query;
    document.body.appendChild(f);
  });
}

// the exact "misc blank + ILS" signature, plus a tier switch and a toggle
async function poke(w) {
  const d = w.document, qq = s => d.querySelector(s);
  qq('.tier[data-tier="custom"]').click(); await sleep(50);
  qq('[data-tog="tour"]').click(); await sleep(50);
  const misc = qq('[data-in="misc"]'); misc.value = ''; misc.dispatchEvent(new w.Event('input', { bubbles: true }));
  const cur = qq('[data-cur="misc"]'); cur.value = 'ILS'; cur.dispatchEvent(new w.Event('change', { bubbles: true }));
}

export async function phaseLoad() {
  await guard();
  const src = await (await fetch('/assets/budget.js', { cache: 'no-store' })).text();
  if (!src.includes('__loadDoc(docRef)')) throw new Error('serve-test.py load hook missing - restart the test server');
  const r = reporter();

  // 1. interaction before the load resolves
  await setDoc(ref(), FIXTURE);
  localStorage.removeItem(LOCAL_KEY);
  const d0 = (await getDoc(ref())).data();
  let f = await openFrame('loadtest=slow');
  await sleep(800);
  let w = f.contentWindow, qq = s => w.document.querySelector(s);
  r.ok('slow: loading notice shown', !!qq('#loadBanner') && !qq('#loadBanner').hidden, qq('#loadBanner') && qq('#loadBanner').textContent);
  r.ok('slow: calculator inert while loading', isInert(qq('.tiers')) && isInert(qq('[data-in="misc"]')) && isInert(qq('[data-tog="tour"]')));
  await poke(w);
  await sleep(4500); // load resolves at ~3s, plus the 800ms debounce and margin
  r.ok('slow: pre-load clicks did not overwrite the doc', canonJson((await getDoc(ref())).data()) === canonJson(d0));
  r.ok('slow: pre-load clicks did not write the local copy', localStorage.getItem(LOCAL_KEY) === null);
  r.ok('slow: the saved doc is shown, not the defaults', qq('[data-in="misc"]').value === '50' && qq('[data-cur="misc"]').value === 'EUR' && qq('[data-item="flight"]').classList.contains('locked') && qq('.tier[data-tier="custom"]').getAttribute('aria-pressed') === 'true', { misc: qq('[data-in="misc"]').value, cur: qq('[data-cur="misc"]').value });
  r.ok('slow: interactive once loaded', !isInert(qq('.tiers')) && !isInert(qq('[data-in="misc"]')) && !!qq('#loadBanner') && qq('#loadBanner').hidden);
  const misc = qq('[data-in="misc"]'); misc.value = '51'; misc.dispatchEvent(new w.Event('input', { bubbles: true }));
  r.ok('slow: edits after load still save', (await readDoc()).custom.values.misc === '51');
  f.remove();

  // 2. failed load with a stale local copy on the device
  await setDoc(ref(), FIXTURE);
  const d1 = (await getDoc(ref())).data();
  const stale = JSON.parse(JSON.stringify(FIXTURE));
  stale.locks = {}; stale.userRows = {}; stale.custom.values.misc = ''; stale.custom.currencies.misc = 'ILS';
  const staleJson = JSON.stringify(stale);
  localStorage.setItem(LOCAL_KEY, staleJson);
  f = await openFrame('loadtest=fail');
  await sleep(1200);
  w = f.contentWindow; qq = s => w.document.querySelector(s);
  r.ok('fail: read-only notice shown', !!qq('#loadBanner') && !qq('#loadBanner').hidden && /לקריאה בלבד/.test(qq('#loadBanner').textContent), qq('#loadBanner') && qq('#loadBanner').textContent);
  r.ok('fail: calculator inert', isInert(qq('.tiers')) && isInert(qq('[data-in="misc"]')) && isInert(qq('[data-lockbtn="flight"]')));
  await poke(w);
  await sleep(2000);
  r.ok('fail: edits did not save the stale copy over the doc', canonJson((await getDoc(ref())).data()) === canonJson(d1));
  r.ok('fail: local copy untouched', localStorage.getItem(LOCAL_KEY) === staleJson);
  f.remove();
  localStorage.removeItem(LOCAL_KEY);
  return r.result();
}

/* ---- accommodation is a flat total in custom (2026-10-07) ----
   The stay was paid as one charge for the whole stay, so in custom the
   `nightly` row is a total: it must count once, the lock button must store
   it as is, and the nights field must not move it. The presets stay per
   night, so a preset tier still multiplies. */
export async function phaseStay() {
  const src = await guard();
  const P = presetsFrom(src);
  const r = reporter();
  const fx = JSON.parse(JSON.stringify(FIXTURE));
  fx.custom.values.nightly = '3122'; fx.custom.currencies.nightly = 'ILS';
  await setDoc(ref(), fx);
  localStorage.removeItem(LOCAL_KEY);
  const f = await openFrame('');
  const w = f.contentWindow, qq = s => w.document.querySelector(s);
  for (let i = 0; i < 30 && !qq('#loadBanner').hidden; i++) await sleep(200);
  const total = () => parseInt(qq('#totEur').textContent.replace(/[^0-9-]/g, ''), 10);
  const setNights = async n => { const el = qq('#nights'); el.value = String(n); el.dispatchEvent(new w.Event('input', { bubbles: true })); await sleep(150); };
  const expected = Math.round(EXPECTED_CUSTOM_TOTAL + 3122 / 3.5);

  r.ok('stay row renamed', qq('[data-item="nightly"] .name').textContent === 'לינה 1–8.11' && /7 לילות · סכום כולל ששולם/.test(qq('[data-item="nightly"] .hint').textContent));
  r.ok('unlocked: ₪3,122 counts once', Math.abs(total() - expected) <= 1 && qq('[data-amt="nightly"]').textContent === '₪3,122', { shown: qq('#totEur').textContent, amt: qq('[data-amt="nightly"]').textContent, expected });
  await setNights(20);
  r.ok('unlocked: nights does not move the total', Math.abs(total() - expected) <= 1, qq('#totEur').textContent);
  await setNights(11);

  qq('[data-lockbtn="nightly"]').click();
  const d = await readDoc();
  r.ok('lock button stores the flat total', d.locks.nightly && d.locks.nightly.amount === '3122' && d.locks.nightly.currency === 'ILS' && d.locks.nightly.rate === 3.5, d.locks.nightly);
  r.ok('locked: counts once', Math.abs(total() - expected) <= 1, qq('#totEur').textContent);
  await setNights(5);
  r.ok('locked: nights does not move the total', Math.abs(total() - expected) <= 1, qq('#totEur').textContent);
  await setNights(11);

  qq('.tier[data-tier="mid"]').click(); await sleep(300);
  r.ok('preset tier still multiplies per night', total() === expectedPresetTotal(P, 'mid') && qq('[data-amt="nightly"]').textContent === '₪' + Math.round(P.mid.nightly * 3.5 * 11).toLocaleString('en-US'), { shown: qq('#totEur').textContent, amt: qq('[data-amt="nightly"]').textContent });
  qq('.tier[data-tier="custom"]').click(); await sleep(300);
  r.ok('back in custom: still the flat total', Math.abs(total() - expected) <= 1, qq('#totEur').textContent);
  f.remove();
  localStorage.removeItem(LOCAL_KEY);
  return r.result();
}

/* ---- shirt/scale/internet -> user rows (v1.15) ----
   A v1.14-shaped doc (the three as fixed rows, all locked, like the real
   doc) must move over exactly: same values, currencies, locks, rowMeta,
   same total and reserve; old keys gone after the first save; a second
   load must not duplicate; old keys written back by a stale tab must not
   override the migrated row; a migrated row that was deleted stays
   deleted. */
const MIGRATE_FX = (() => {
  const fx = JSON.parse(JSON.stringify(FIXTURE));
  Object.assign(fx.custom.values, { shirt: '159', scale: '25.3', internet: '32.25', u_t3: '0' });
  Object.assign(fx.custom.currencies, { shirt: 'ILS', scale: 'ILS', internet: 'USD', u_t3: 'EUR' });
  Object.assign(fx.locks, {
    shirt: { amount: '159', currency: 'ILS', rate: 3.5, chargedOn: '2026-09-19' },
    scale: { amount: '25.3', currency: 'ILS', rate: 3.5, chargedOn: '2026-09-18' },
    internet: { amount: '32.25', currency: 'USD', rate: 1.1, chargedOn: '2026-09-17' }
  });
  Object.assign(fx.rowMeta, { shirt: { desc: 'חולצה', zz_future: 'keep' }, internet: { url: 'https://example.com/esim' } });
  fx.userRows.u_t3 = { label: 'בדיקה 3', group: 'pre', createdAt: 10 };
  return fx;
})();
const MIGRATED_EXTRA = 159 / 3.5 + 25.3 / 3.5 + 32.25 / 1.1;

async function frameReady(f) {
  const qq = s => f.contentWindow.document.querySelector(s);
  for (let i = 0; i < 40 && !(qq('#loadBanner') && qq('#loadBanner').hidden); i++) await sleep(200);
  return qq;
}

export async function phaseMigrate() {
  const src = await guard();
  const P = presetsFrom(src);
  const r = reporter();
  r.ok('PRESETS no longer list shirt/scale/internet', ['lean', 'mid', 'rich'].every(t => !['shirt', 'scale', 'internet'].some(k => k in P[t])));
  await setDoc(ref(), MIGRATE_FX);
  localStorage.removeItem(LOCAL_KEY);
  const d0 = (await getDoc(ref())).data();
  let f = await openFrame('');
  let qq = await frameReady(f);
  const total = () => parseInt(qq('#totEur').textContent.replace(/[^0-9-]/g, ''), 10);
  const rowsOf = key => qq(`[data-pct="${key}"]`).closest('h2').nextElementSibling;
  const expected = Math.round(EXPECTED_CUSTOM_TOTAL + MIGRATED_EXTRA);
  const save = async () => { qq('[data-tog="tour"]').click(); await sleep(150); qq('[data-tog="tour"]').click(); return readDoc(); };

  // 1. first load: everything moved, nothing written yet
  r.ok('no fixed shirt/scale/internet rows', ['shirt', 'scale', 'internet'].every(id => !qq(`[data-item="${id}"]`)));
  r.ok('migrated rows have their labels', qq('[data-item="u_shirt"] .name').textContent === 'חולצת משחק' && qq('[data-item="u_scale"] .name').textContent === 'משקל ידני למזוודה' && qq('[data-item="u_internet"] .name').textContent === 'אינטרנט');
  const pre = [...rowsOf('pre').querySelectorAll('[data-item]')].map(x => x.dataset.item);
  const met = [...rowsOf('metro').querySelectorAll('[data-item]')].map(x => x.dataset.item);
  r.ok('groups and order kept (migrated rows before newer user rows)', JSON.stringify(pre) === JSON.stringify(['u_shirt', 'u_scale', 'u_t3']) && JSON.stringify(met) === JSON.stringify(['metro', 'u_internet']), { pre, met });
  r.ok('all three still locked with the same amounts', ['u_shirt', 'u_scale', 'u_internet'].every(id => qq(`[data-item="${id}"]`).classList.contains('locked')) && qq('[data-amt="u_shirt"]').textContent === '₪159' && qq('[data-amt="u_scale"]').textContent === '₪25' && qq('[data-amt="u_internet"]').textContent === '$32', ['u_shirt', 'u_scale', 'u_internet'].map(id => qq(`[data-amt="${id}"]`).textContent));
  r.ok('charge dates kept', qq('[data-lockdate="u_shirt"]').value === '2026-09-19' && qq('[data-lockdate="u_scale"]').value === '2026-09-18' && qq('[data-lockdate="u_internet"]').value === '2026-09-17');
  r.ok('total unchanged by the move', Math.abs(total() - expected) <= 1, { shown: qq('#totEur').textContent, expected });
  const used = qq('#reserveLine').textContent.match(/€([0-9,]+) מתוך/);
  r.ok('still counted against the reserve', used && Math.abs(parseInt(used[1].replace(/,/g, ''), 10) - Math.round(EXPECTED_RESERVE_USED + MIGRATED_EXTRA)) <= 1, qq('#reserveLine').textContent);
  r.ok('details kept; hint becomes the description when there was none', qq('[data-link-view="u_internet"]').getAttribute('href') === 'https://example.com/esim' && qq('[data-desc-view="u_shirt"]').textContent === 'חולצה' && qq('[data-desc-view="u_scale"]').textContent === 'לפני הטיסה');
  r.ok('loading alone writes nothing', canonJson((await getDoc(ref())).data()) === canonJson(d0));

  // 2. first save persists the new shape and drops the old keys
  const d1 = await save();
  const MAP = { shirt: 'u_shirt', scale: 'u_scale', internet: 'u_internet' };
  r.ok('user row definitions saved', canonJson(d1.userRows.u_shirt) === canonJson({ label: 'חולצת משחק', group: 'pre', createdAt: 1 }) && d1.userRows.u_scale.group === 'pre' && d1.userRows.u_internet.group === 'metro', d1.userRows);
  r.ok('values, currencies, locks moved exactly', Object.entries(MAP).every(([o, n]) => d1.custom.values[n] === d0.custom.values[o] && d1.custom.currencies[n] === d0.custom.currencies[o] && canonJson(d1.locks[n]) === canonJson(d0.locks[o])));
  r.ok('rowMeta moved exactly (unknown fields too)', canonJson(d1.rowMeta.u_shirt) === canonJson(d0.rowMeta.shirt) && canonJson(d1.rowMeta.u_internet) === canonJson(d0.rowMeta.internet) && d1.rowMeta.u_scale.desc === 'לפני הטיסה');
  r.ok('old keys gone everywhere', Object.keys(MAP).every(o => !(o in d1.custom.values) && !(o in d1.custom.currencies) && !(o in d1.locks) && !(o in d1.rowMeta)));
  r.ok('everything else untouched', canonJson(d1.locks.flight) === canonJson(d0.locks.flight) && canonJson(d1.locks.u_t2) === canonJson(d0.locks.u_t2) && canonJson(d1.locks.u_orphan) === canonJson(d0.locks.u_orphan) && d1.custom.values.misc === '50' && d1.zz_future && d1.zz_future.keep === true);
  f.remove();

  // 3. second load: no duplicates
  f = await openFrame(''); qq = await frameReady(f);
  const count = id => qq('body').querySelectorAll(`[data-item="${id}"]`).length;
  r.ok('second load: exactly one of each, nothing new', ['u_shirt', 'u_scale', 'u_internet'].every(id => count(id) === 1) && qq('body').querySelectorAll('[data-user-row]').length === Object.keys(d1.userRows).length);
  r.ok('second load: total unchanged', Math.abs(total() - expected) <= 1, qq('#totEur').textContent);
  f.remove();

  // 4. a stale (v1.14) tab writes the old keys back from its HTML defaults
  await updateDoc(ref(), 'custom.values.shirt', '0', 'custom.currencies.shirt', 'EUR');
  f = await openFrame(''); qq = await frameReady(f);
  r.ok('stale old keys: the migrated row wins', count('shirt') === 0 && count('u_shirt') === 1 && qq('[data-amt="u_shirt"]').textContent === '₪159' && Math.abs(total() - expected) <= 1);
  const d2 = await save();
  r.ok('stale old keys dropped on save, migrated row intact', !('shirt' in d2.custom.values) && !('shirt' in d2.custom.currencies) && d2.custom.values.u_shirt === '159' && canonJson(d2.locks.u_shirt) === canonJson(d0.locks.shirt));

  // 5. a deleted migrated row stays deleted
  qq('[data-lockbtn="u_scale"]').click(); await sleep(100);
  qq('[data-delbtn="u_scale"]').click(); await sleep(100);
  qq('[data-delyes="u_scale"]').click();
  const d3 = await readDoc();
  r.ok('migrated row can be deleted', !('u_scale' in d3.userRows) && !('u_scale' in d3.custom.values) && !('u_scale' in d3.locks));
  f.remove();
  f = await openFrame(''); qq = await frameReady(f);
  r.ok('deleted migrated row does not come back', count('u_scale') === 0 && count('scale') === 0);

  // 6. preset tiers still show the exact original plan
  qq('.tier[data-tier="mid"]').click(); await sleep(300);
  r.ok('mid: exact original plan, migrated rows hidden', total() === expectedPresetTotal(P, 'mid') && ['u_shirt', 'u_internet'].every(id => qq(`[data-item="${id}"]`).style.display === 'none'), qq('#totEur').textContent);
  f.remove();
  localStorage.removeItem(LOCAL_KEY);
  return r.result();
}

export async function phaseLegacy() {
  await guard();
  const r = reporter();
  const MIGRATED = ['u_internet', 'u_scale', 'u_shirt'];
  const userRowIdsShown = () => [...document.querySelectorAll('[data-user-row]')].map(x => x.dataset.item).sort();
  r.ok('legacy doc rendered (fixed rows present; only the three migrated user rows)', !!q('[data-item="flight"]') && JSON.stringify(userRowIdsShown()) === JSON.stringify(MIGRATED), userRowIdsShown());
  r.ok('legacy doc: no details shown except the migrated hints', [...document.querySelectorAll('[data-desc-view],[data-link-view]')].filter(vis).every(el => MIGRATED.includes(el.dataset.descView)));
  r.ok('legacy doc: total is right (flight 486/3.5 + barca 1053.8/3.5)', Math.abs(totalNum() - Math.round(486 / 3.5 + 1053.8 / 3.5)) <= 1, q('#totEur').textContent);
  r.ok('legacy doc: no NaN', !/NaN/.test(document.body.innerText));
  q('[data-tog="tour"]').click(); await sleep(150); q('[data-tog="tour"]').click();
  const d = await readDoc();
  r.ok('legacy doc after a save: only the three migrated rows and their hints, nothing else invented', JSON.stringify(Object.keys(d.userRows || {}).sort()) === JSON.stringify(MIGRATED) && JSON.stringify(Object.keys(d.rowMeta || {}).sort()) === JSON.stringify(MIGRATED) && d.rowMeta.u_scale.desc === 'לפני הטיסה', { userRows: Object.keys(d.userRows || {}), rowMeta: d.rowMeta });
  // a first detail on a legacy doc
  q('[data-metabtn="barca"]').click(); await sleep(100);
  setVal(q('[data-link-in="barca"]'), 'https://example.com/ticket');
  const d2 = await readDoc();
  r.ok('first link on a legacy doc persists', d2.rowMeta.barca && d2.rowMeta.barca.url === 'https://example.com/ticket');
  return r.result();
}

/* ---- save guard (2026-10-07) ----
   Every save writes the whole doc, so a page loaded before a change made
   elsewhere used to overwrite it (that is how a lock and a link were lost).
   Now a save is refused, and the page goes read-only with a notice, when
   the doc on the server is not what this page loaded or last wrote. */
export async function phaseGuard() {
  await guard();
  const r = reporter();
  await setDoc(ref(), FIXTURE);
  localStorage.removeItem(LOCAL_KEY);
  const MSG = 'השתנה במכשיר אחר — רענן';
  const open = async () => { const f = await openFrame(''); const qq = await frameReady(f); return { f, w: f.contentWindow, qq }; };
  const edit = (p, id, v) => { const el = p.qq(`[data-in="${id}"]`); el.value = v; el.dispatchEvent(new p.w.Event('input', { bubbles: true })); };
  const conflicted = p => !p.qq('#loadBanner').hidden && p.qq('#loadBanner').textContent === MSG && isInert(p.qq('[data-in="misc"]'));
  const clean = p => p.qq('#loadBanner').hidden && !isInert(p.qq('[data-in="misc"]'));
  // a guarded save is a read + a write; poll instead of a fixed wait (the test tab may be throttled)
  const docWhen = async pred => { let d; for (let i = 0; i < 40; i++) { await sleep(250); d = (await getDoc(ref())).data(); if (d && pred(d)) break; } return d; };

  // 1. one tab: many saves in a row, including a lock (numbers) and a link, never a false conflict
  const A = await open();
  edit(A, 'misc', '60'); let d = await docWhen(x => x.custom.values.misc === '60');
  r.ok('single tab: first save goes through', d.custom.values.misc === '60' && clean(A));
  edit(A, 'misc', '61'); await sleep(100); edit(A, 'misc', '62'); d = await docWhen(x => x.custom.values.misc === '62');
  r.ok('single tab: next saves go through too', d.custom.values.misc === '62' && clean(A));
  A.qq('[data-lockbtn="misc"]').click(); d = await docWhen(x => x.locks.misc);
  r.ok('single tab: lock saves', d.locks.misc && d.locks.misc.amount === '62' && clean(A), d.locks.misc);
  A.qq('[data-metabtn="misc"]').click(); await sleep(50);
  const li = A.qq('[data-link-in="misc"]'); li.value = 'https://example.com/r'; li.dispatchEvent(new A.w.Event('input', { bubbles: true }));
  d = await docWhen(x => x.rowMeta.misc);
  r.ok('single tab: link on a locked row saves', d.rowMeta.misc && d.rowMeta.misc.url === 'https://example.com/r' && clean(A));
  A.qq('[data-lockbtn="misc"]').click(); await sleep(50);
  // quick edits while a save is in flight must not trip the guard either
  for (const v of ['63', '64', '65']) { edit(A, 'misc', v); await sleep(900); }
  d = await docWhen(x => x.custom.values.misc === '65');
  r.ok('single tab: edits during an in-flight save do not conflict', d.custom.values.misc === '65' && clean(A), { misc: d.custom.values.misc, banner: A.qq('#loadBanner').textContent });

  // 2. two tabs: the one that loaded earlier is refused
  const B = await open();
  B.qq('[data-lockbtn="u_t1"]').click(); d = await docWhen(x => x.locks.u_t1);
  r.ok('tab B (fresh) locks a row', d.locks.u_t1 && clean(B));
  const before = canonJson(d);
  edit(A, 'daily', '40'); for (let i = 0; i < 40 && !conflicted(A); i++) await sleep(250);
  d = (await getDoc(ref())).data();
  r.ok('tab A (stale) is refused: doc unchanged, B\'s lock kept', canonJson(d) === before && d.locks.u_t1);
  r.ok('tab A shows the notice and goes read-only', conflicted(A), A.qq('#loadBanner').textContent);
  edit(A, 'daily', '41'); await readDoc();
  r.ok('tab A stays refused on further edits', canonJson((await getDoc(ref())).data()) === before);
  r.ok('tab B unaffected', clean(B));
  A.f.remove(); B.f.remove();

  // 3. an old tab without the guard (blind whole-doc write) is also detected
  const C = await open();
  const old = (await getDoc(ref())).data(); old.custom.values.metro = '99';
  await setDoc(ref(), old);
  edit(C, 'museums', '10'); for (let i = 0; i < 40 && !conflicted(C); i++) await sleep(250);
  d = (await getDoc(ref())).data();
  r.ok('blind write elsewhere: this tab is refused, the other write survives', d.custom.values.metro === '99' && d.custom.values.museums !== '10' && conflicted(C));
  C.f.remove();

  // 4. coming back to the tab shows the notice before any edit
  const D = await open();
  const old2 = (await getDoc(ref())).data(); old2.custom.values.metro = '98';
  await setDoc(ref(), old2);
  D.w.dispatchEvent(new D.w.Event('focus')); for (let i = 0; i < 40 && !conflicted(D); i++) await sleep(250);
  r.ok('focus after a change elsewhere: notice shown without editing', conflicted(D));
  D.f.remove();
  const E = await open();
  E.w.dispatchEvent(new E.w.Event('focus')); await sleep(1500);
  r.ok('focus with no change elsewhere: no notice', clean(E));
  E.f.remove();

  // 5. no doc yet: the first save creates it
  await deleteDoc(ref());
  const F = await open();
  edit(F, 'misc', '7'); d = await docWhen(x => x.custom.values.misc === '7');
  r.ok('no doc yet: first save creates it', d && d.custom.values.misc === '7' && clean(F));
  F.f.remove();
  localStorage.removeItem(LOCAL_KEY);
  return r.result();
}

/* ---- rename built-in rows (2026-10-07) ----
   Every row can be renamed, not only user rows. A fixed row's name lives in
   rowLabels[id]; the id, PRESETS, reference line, value, currency, lock and
   details never move. An empty name on a fixed row restores the original. */
export async function phaseRename() {
  await guard();
  const r = reporter();
  const fx = JSON.parse(JSON.stringify(FIXTURE));
  fx.rowLabels = { zz_gone: 'שורה שכבר לא קיימת' };
  await setDoc(ref(), fx);
  localStorage.removeItem(LOCAL_KEY);
  let f = await openFrame('');
  let w = f.contentWindow, qq = s => w.document.querySelector(s);
  for (let i = 0; i < 30 && !qq('#loadBanner').hidden; i++) await sleep(200);
  const name = id => qq(`[data-item="${id}"] .name`).textContent;
  const rename = async (id, text) => {
    qq(`[data-renbtn="${id}"]`).click(); await sleep(50);
    const form = qq(`[data-renform="${id}"]`);
    form.querySelector('input').value = text; form.requestSubmit(); await sleep(50);
  };
  const totalBefore = qq('#totEur').textContent;
  const refBefore = qq('[data-tier-ref="flight"]').textContent;

  r.ok('every fixed cost row has a rename button, next to its details button', ['flight', 'airport', 'nightly', 'daily', 'barca', 'ucl', 'tour', 'metro', 'trip', 'museums', 'misc'].every(id => { const b = qq(`[data-renbtn="${id}"]`); return !!b && b.parentElement === qq(`[data-metabtn="${id}"]`).parentElement; }));
  qq('[data-renbtn="airport"]').click(); await sleep(50);
  const form = qq('[data-renform="airport"]');
  r.ok('rename form opens with the current name, original as placeholder', !form.hidden && form.querySelector('input').value === 'נמל תעופה ↔ העיר' && form.querySelector('input').placeholder === 'נמל תעופה ↔ העיר');
  qq('[data-ren-in="airport"]').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(50);
  r.ok('Escape cancels', form.hidden && name('airport') === 'נמל תעופה ↔ העיר');

  await rename('airport', '  מונית לנמל <b>תעופה</b> 1.11  ');
  let d = await readDoc();
  r.ok('renamed: trimmed, shown as text not HTML', name('airport') === 'מונית לנמל <b>תעופה</b> 1.11' && !qq('[data-item="airport"] .name b'));
  r.ok('rename persisted in rowLabels', d.rowLabels && d.rowLabels.airport === 'מונית לנמל <b>תעופה</b> 1.11', d.rowLabels);
  r.ok('value, currency, rowMeta untouched; no other row renamed', d.custom.values.airport === '' && d.custom.currencies.airport === 'EUR' && !('airport' in d.rowMeta) && Object.keys(d.rowLabels).sort().join() === 'airport,zz_gone');
  r.ok('unknown rowLabels entry preserved', d.rowLabels.zz_gone === 'שורה שכבר לא קיימת');

  // locked fixed row: name changes, lock / total / reference do not
  const lockBefore = canonJson(d.locks.flight);
  await rename('flight', 'טיסה הלוך · אל על');
  d = await readDoc();
  r.ok('locked fixed row can be renamed; lock untouched', d.rowLabels.flight === 'טיסה הלוך · אל על' && canonJson(d.locks.flight) === lockBefore && qq('[data-item="flight"]').classList.contains('locked'));
  r.ok('rename does not move the total or the reference line', qq('#totEur').textContent === totalBefore && qq('[data-tier-ref="flight"]').textContent === refBefore, { total: qq('#totEur').textContent, ref: qq('[data-tier-ref="flight"]').textContent });
  r.ok('rename kept the details', d.rowMeta.flight.desc === 'אל על · הלוך' && d.rowMeta.flight.url === 'https://example.com/flight');

  // user rows still rename as before (into userRows, not rowLabels)
  await rename('u_t1', 'שורה שלי');
  d = await readDoc();
  r.ok('user row rename still goes to userRows', d.userRows.u_t1.label === 'שורה שלי' && !('u_t1' in d.rowLabels));
  await rename('u_t1', '   ');
  r.ok('user row: empty name still ignored', name('u_t1') === 'שורה שלי');

  // reload: names come back from the doc
  f.remove();
  f = await openFrame(''); w = f.contentWindow; qq = s => w.document.querySelector(s);
  for (let i = 0; i < 30 && !qq('#loadBanner').hidden; i++) await sleep(200);
  r.ok('after reload: both renames shown', name('airport') === 'מונית לנמל <b>תעופה</b> 1.11' && name('flight') === 'טיסה הלוך · אל על' && name('nightly') === 'לינה 1–8.11');

  // preset tier: new name shown, rename hidden; back to custom: visible again
  qq('.tier[data-tier="mid"]').click(); await sleep(250);
  const hiddenRen = el => !el || !el.getClientRects().length;
  r.ok('preset tier: renamed label shown, rename control hidden', name('airport') === 'מונית לנמל <b>תעופה</b> 1.11' && hiddenRen(qq('[data-renbtn="airport"]')));
  qq('.tier[data-tier="custom"]').click(); await sleep(250);
  r.ok('custom: rename control visible again', !hiddenRen(qq('[data-renbtn="airport"]')));

  // empty name on a fixed row = back to the original; so is typing the original
  await rename('airport', '');
  await rename('flight', 'טיסה הלוך');
  d = await readDoc();
  r.ok('empty name restores the original and removes the entry', name('airport') === 'נמל תעופה ↔ העיר' && !('airport' in d.rowLabels));
  r.ok('typing the original name removes the entry', name('flight') === 'טיסה הלוך' && !('flight' in d.rowLabels));
  r.ok('no NaN anywhere', !/NaN/.test(w.document.body.innerText));
  f.remove();
  localStorage.removeItem(LOCAL_KEY);
  return r.result();
}
