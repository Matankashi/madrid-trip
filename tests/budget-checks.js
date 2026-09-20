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
        await t.dropTestDoc();                // deletes budget_test
   Every function returns {passed, failed, failures:[...]}.

   seed()/dropTestDoc() throw unless the served budget.js really targets
   budget_test, so running this against a normally served page is refused. */

import { db, auth } from '/assets/firebase-init.js';
import { doc, getDoc, setDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

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
const readDoc = async () => { await sleep(1800); return (await getDoc(ref())).data(); };

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
    values: { days: '12', nights: '11', tripCount: '2', flight: '486', airport: '', nightly: '', daily: '', barca: '1053.8', ucl: '', tour: '', metro: '', trip: '', museums: '', shirt: '', scale: '', internet: '', misc: '50', u_t1: '100', u_t2: '20', u_orphan: '999' },
    currencies: { flight: 'ILS', airport: 'EUR', nightly: 'EUR', daily: 'EUR', barca: 'ILS', ucl: 'EUR', tour: 'EUR', metro: 'EUR', trip: 'EUR', museums: 'EUR', shirt: 'EUR', scale: 'EUR', internet: 'EUR', misc: 'EUR', u_t1: 'EUR', u_t2: 'USD', u_orphan: 'EUR' }
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
const EXPECTED_RESERVE_USED = 50 + 100 + 20 / 1.1; // misc + user rows (shirt/scale/internet are 0 here)

export async function seed() {
  await guard();
  await setDoc(ref(), FIXTURE);
  return 'seeded budget_test';
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
    r.ok(`${t}: zero-preset fixed rows hidden`, ['shirt', 'scale', 'internet'].every(id => !shown(q(`[data-item="${id}"]`))));
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
