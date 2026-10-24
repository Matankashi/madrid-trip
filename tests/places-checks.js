/* Browser checks for the recommendations pool in dossier.html (#places,
   assets/places.js) and how it feeds the itinerary board. No framework.

   HOW TO RUN (against scratch docs, never the real ones)
   1. python3 tests/serve-test.py            (places.js    -> state/places_test,
                                              itinerary.js -> state/itinerary_test,
                                              dossier.js   -> state/checklist_test)
   2. Open http://localhost:8000/dossier.html in a Chrome that is signed in.
   3. In the console (or via automation) — each phase reseeds itself:
        const t = await import('/tests/places-checks.js');
        await t.phaseParse();   // Takeout CSV / Saved Places.json / coordinates (pure)
        await t.phasePool();    // collapsed list, categories, add/edit, custom categories
        await t.phaseBoard();   // chips, drag in/out, several days, היינו, delete block, slots
        await t.phaseImport();  // file import: preview, duplicates, nothing overwritten
        await t.phaseFilter();  // "Madrid and around" filter in the import preview
        await t.phaseMap();     // overlay map from a place / a category / a board item
        await t.phaseMobile();  // phone width: not sticky, thumb-size day chips, no h-scroll
        await t.phaseGuard();   // another device changed the pool -> refuse to save
        await t.phaseLoad();    // slow/failed pool load, local fallback, unknown fields kept
        await t.dropTestDoc();  // deletes places_test + itinerary_test + local test copies
   Every phase returns {passed, failed, failures:[...]} and checks at the end
   that the real state/places and state/itinerary docs are byte-identical to
   before (read only). Run phases one at a time (not as parallel calls), and
   in a hidden automation tab start with .then(x => window.__R = x) and poll. */

import { db, auth } from '/assets/firebase-init.js';
import { doc, getDoc, setDoc, deleteDoc } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCAL = { places: 'madrid.places.test', itinerary: 'madrid.itinerary.test' };
const canonJson = o => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
const isInert = el => !!el && !!el.closest('[inert]');
const D = n => `2026-11-${String(n).padStart(2, '0')}`;

async function guard() {
  const src = await (await fetch('/assets/places.js', { cache: 'no-store' })).text();
  const itin = await (await fetch('/assets/itinerary.js', { cache: 'no-store' })).text();
  if (!src.includes("'state', 'places_test')") || !itin.includes("'state', 'itinerary_test')")) {
    throw new Error('dossier scripts are not served by tests/serve-test.py - refusing to run');
  }
  if (!src.includes('__loadDoc(docRef)') || !src.includes("'placesload'")) throw new Error('serve-test.py places hook missing - restart the test server');
}
const uid = () => auth.currentUser.uid;
const pRef = () => doc(db, 'users', uid(), 'state', 'places_test');
const iRef = () => doc(db, 'users', uid(), 'state', 'itinerary_test');
const realSnap = async () => {
  const out = {};
  for (const name of ['places', 'itinerary']) { const s = await getDoc(doc(db, 'users', uid(), 'state', name)); out[name] = s.exists() ? canonJson(s.data()) : null; }
  return JSON.stringify(out);
};
const read = async ref => { const s = await getDoc(ref); return s.exists() ? s.data() : undefined; };
const docWhen = async (ref, pred) => { let d; for (let i = 0; i < 40; i++) { await sleep(250); d = await read(ref); if (d && pred(d)) break; } return d; };

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
const settledBanner = b => b && (b.hidden || b.classList.contains('failed'));
async function open(query = '', width, wait = true) {
  const f = await openFrame(query, width);
  const w = f.contentWindow, qq = s => w.document.querySelector(s), qa = s => [...w.document.querySelectorAll(s)];
  const p = { f, w, qq, qa };
  if (wait) for (let i = 0; i < 60 && !(settledBanner(qq('#placesBanner')) && settledBanner(qq('#itinBanner'))); i++) await sleep(200);
  return p;
}
const idle = p => (!p.w.__placesIdle || p.w.__placesIdle()) && (!p.w.__itinIdle || p.w.__itinIdle());
const waitIdle = async (...ps) => { await sleep(300); for (let i = 0; i < 80 && !ps.every(idle); i++) await sleep(150); };

const pact = (p, a, id, day) => {
  const b = p.qq(`#places [data-pact="${a}"][data-id="${id}"]` + (day ? `[data-day="${day}"]` : ''));
  if (!b) throw new Error(`no pool button ${a} ${id} ${day || ''}`);
  b.click();
};
const act = (p, a, id) => { const b = p.qq(`#itin [data-act="${a}"][data-id="${id}"]`); if (!b) throw new Error(`no board button ${a} ${id}`); b.click(); };
const setPf = (p, name, value) => { const el = p.qq(`[data-pform] [data-pf="${name}"]`); el.value = value; el.dispatchEvent(new p.w.Event('input', { bubbles: true })); el.dispatchEvent(new p.w.Event('change', { bubbles: true })); };
const setF = (p, name, value) => { const el = p.qq(`[data-form] [data-f="${name}"]`); el.value = value; el.dispatchEvent(new p.w.Event('change', { bubbles: true })); };
const poolIds = p => p.qa('#places [data-place]').map(x => x.dataset.place);
const mainIds = (p, day) => p.qa(`[data-list="${day}"] > [data-item]`).map(x => x.dataset.item);
const linkedOn = (p, day, pid) => p.qa(`[data-list="${day}"] > [data-item][data-placeid="${pid}"]`);
const placedDays = (p, pid) => { const m = p.qq(`#places [data-place="${pid}"] [data-mark="placed"] .mono`); return m ? m.textContent : ''; };
const openCat = (p, k) => { if (!p.qq('#places .pool-body')) pact(p, 'toggle', ''); if (p.qq(`[data-pact="cat"][data-id="${k}"]`).getAttribute('aria-pressed') !== 'true') pact(p, 'cat', k); };
const expand = (p, k, pid) => { openCat(p, k); if (p.qq(`[data-pact="expand"][data-id="${pid}"]`).getAttribute('aria-expanded') !== 'true') pact(p, 'expand', pid); };
// tap a day chip for a place (opens its category, the place and its chips first)
const tapDay = (p, k, pid, day) => { expand(p, k, pid); if (!p.qq(`[data-pact="day"][data-id="${pid}"]`)) pact(p, 'chips', pid); pact(p, 'day', pid, day); };

function dragEl(p, src, target, where) {
  const w = p.w, r = target.getBoundingClientRect();
  const x = r.left + r.width / 2, y = where === 'top' ? r.top + 2 : r.bottom - 2;
  const dt = new w.DataTransfer();
  src.dispatchEvent(new w.DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const over = new w.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
  target.dispatchEvent(over);
  const accepted = over.defaultPrevented;
  target.dispatchEvent(new w.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  src.dispatchEvent(new w.DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return accepted;
}
const dayCard = (p, day) => p.qq(`.itin-day[data-day="${day}"]`);

const FIXTURE = () => ({
  places: {
    p_hola: { name: 'Hola Coffee', cat: 'cafe', hood: 'לבפיס', note: 'פלאט וייט · ללכת מוקדם', url: 'https://www.google.com/maps/place/Hola+Coffee/data=!4m2!3m1!1s0xd42287e5e1a6e2b:0x8b4ad7c2a6a51a1c', lat: 40.4106, lng: -3.6995, createdAt: 1, source: 'manual' },
    p_toma: { name: 'Toma Café', cat: 'cafe', hood: '', note: '', url: '', createdAt: 2, source: 'manual' },
    p_botin: { name: 'Sobrino de Botín', cat: 'food', hood: 'לה לטינה', note: 'המסעדה העתיקה בעולם', url: '', lat: 40.4142, lng: -3.7079, createdAt: 3, source: 'manual', future: 'keep me' },
    p_jazz: { name: 'Café Central', cat: 'c_bars', hood: 'הוארטס', note: 'ג׳אז', url: '', lat: 40.4146, lng: -3.7015, createdAt: 4, source: 'manual' }
  },
  cats: { c_bars: { label: 'ג׳אז וברים', createdAt: 10 } },
  futureTop: { x: 1 }
});
async function fresh(withItin) {
  await setDoc(pRef(), FIXTURE());
  await deleteDoc(iRef());
  if (withItin) await setDoc(iRef(), withItin);
  localStorage.removeItem(LOCAL.places); localStorage.removeItem(LOCAL.itinerary);
}
const closeAll = () => document.querySelectorAll('iframe').forEach(f => f.remove());
async function finish(r, realBefore) {
  r.ok('real places + itinerary docs untouched', (await realSnap()) === realBefore);
  closeAll();
  return r.result();
}

/* ---------- 1. pure parsing (same module instance as this page) ---------- */
export async function phaseParse() {
  await guard();
  const r = reporter();
  const { __test: t } = await import('/assets/places.js');
  const csv = '﻿Title,Note,URL,Tags,Comment\r\n\r\n'
    + 'Hola Coffee,"great flat white, go early",https://www.google.com/maps/place/Hola+Coffee/data=!4m2!3m1!1s0xd42287e5e1a6e2b:0x8b4ad7c2a6a51a1c,,\r\n'
    + '"Toma Café","line one\nline two ""quoted""","https://www.google.com/maps/place/Toma+Caf%C3%A9/@40.4271,-3.7073,17z/data=!3m1!4b1!4m6!3m5!1s0xd42288:0x1!8m2!3d40.427123!4d-3.705456",,also the cake\r\n'
    + ',,"https://www.google.com/maps/search/40.4153,-3.6845",,\r\n'
    + ',,,,\r\n';
  const rows = t.rowsFromCsv(csv);
  r.ok('csv: BOM + blank rows', rows.length === 3, rows.length);
  r.ok('csv: quoted comma', rows[0].note === 'great flat white, go early', rows[0].note);
  r.ok('csv: /place/ link without !3d has no coords', rows[0].coords === null, rows[0].coords);
  r.ok('csv: newline + "" in a note, Comment appended', rows[1].note === 'line one\nline two "quoted" · also the cake', rows[1].note);
  r.ok('csv: !3d!4d wins over @', rows[1].coords && rows[1].coords.lat === 40.427123 && rows[1].coords.lng === -3.705456, rows[1].coords);
  r.ok('csv: dropped pin /search/lat,lng', rows[2].coords && rows[2].coords.lat === 40.4153, rows[2].coords);
  const j1 = JSON.stringify({ type: 'FeatureCollection', features: [
    { geometry: { coordinates: [-3.6921, 40.4138], type: 'Point' }, properties: { google_maps_url: 'http://maps.google.com/?cid=1234567890', location: { address: 'C. de Ruiz de Alarcón, 23, Retiro, 28014 Madrid, Spain', country_code: 'ES', name: 'Museo del Prado' } }, type: 'Feature' },
    { geometry: { coordinates: [0, 0], type: 'Point' }, properties: { google_maps_url: 'http://maps.google.com/?q=40.4200,-3.7000', location: {} }, type: 'Feature' },
    { geometry: { coordinates: [0, 0], type: 'Point' }, properties: { google_maps_url: 'http://maps.google.com/?cid=999', location: { address: 'Calle Mayor 1, Madrid' }, Comment: 'nice' }, type: 'Feature' }
  ] });
  const r1 = t.rowsFromJson(j1);
  r.ok('json (current): name, address, [lng,lat] flipped', r1[0].name === 'Museo del Prado' && r1[0].coords.lat === 40.4138 && r1[0].coords.lng === -3.6921 && /Retiro/.test(r1[0].address), r1[0]);
  r.ok('json: [0,0] = no coords, ?q=lat,lng in the url used', r1[1].coords && r1[1].coords.lat === 40.42, r1[1]);
  r.ok('json: [0,0] + cid url = no coords, Comment kept', r1[2].coords === null && r1[2].note === 'nice', r1[2]);
  const r2 = t.rowsFromJson(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-3.7038, 40.4168] }, properties: { 'Google Maps URL': 'http://maps.google.com/?cid=42', Location: { Address: 'Puerta del Sol, Madrid', 'Business Name': 'Puerta del Sol', 'Geo Coordinates': { Latitude: '40.4168', Longitude: '-3.7038' } }, Title: 'Puerta del Sol' } }] }));
  r.ok('json (older shape): Business Name / Address / coords', r2[0].name === 'Puerta del Sol' && r2[0].address === 'Puerta del Sol, Madrid' && r2[0].coords.lat === 40.4168, r2[0]);
  const err = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
  r.ok('csv without a name column -> clear error', /Title/.test(err(() => t.rowsFromCsv('foo,bar\n1,2'))));
  r.ok('json without features -> clear error', /features/.test(err(() => t.rowsFromJson('{"a":1}'))));
  r.ok('broken json -> clear error', /JSON/.test(err(() => t.rowsFromJson('{bad'))));
  r.ok('coords text: comma / space / junk / out of range / 0,0', !!t.parseCoords('40.4168, -3.7038') && !!t.parseCoords('40.4168 -3.7038') && !t.parseCoords('abc') && !t.parseCoords('140, 3') && !t.parseCoords('0, 0'));
  r.ok('url: %2C query / @ only / short link / broken %', t.coordsFromUrl('https://www.google.com/maps/search/?api=1&query=40.41%2C-3.70').lat === 40.41 && t.coordsFromUrl('https://www.google.com/maps/@40.43,-3.69,15z').lng === -3.69 && t.coordsFromUrl('https://maps.app.goo.gl/AbCdEf') === null && t.coordsFromUrl('https://x.com/%E0%A4%A') === null);
  r.ok('distance: Toledo ~67 km, Segovia ~68 km, Barcelona ~500 km', Math.abs(t.distKm({ lat: 40.4168, lng: -3.7038 }, { lat: 39.8628, lng: -4.0273 }) - 67) < 5 && Math.abs(t.distKm({ lat: 40.4168, lng: -3.7038 }, { lat: 40.9429, lng: -4.1088 }) - 68) < 5 && t.distKm({ lat: 40.4168, lng: -3.7038 }, { lat: 41.3874, lng: 2.1686 }) > 450);
  const A1 = x => t.areaOf(Object.assign({ name: '', address: '', note: '', coords: null }, x));
  r.ok('area: coords decide (in/out), text ignored when coords exist', A1({ coords: { lat: 40.42, lng: -3.70 } }) === 'in' && A1({ coords: { lat: 36.11, lng: -115.17 }, address: 'Madrid' }) === 'out');
  r.ok('area: no coords -> Madrid / nearby city / Hebrew in name, address or note', A1({ address: 'C. Mayor, 1, 28013 Madrid, Spain' }) === 'in' && A1({ address: 'Calle Real, Alcalá de Henares' }) === 'in' && A1({ name: 'טיול לטולדו' }) === 'in' && A1({ note: 'near Segovia aqueduct' }) === 'in');
  r.ok('area: address elsewhere -> out; nothing to go on -> unknown', A1({ address: '3570 S Las Vegas Blvd, NV 89109' }) === 'out' && A1({ name: 'North District' }) === 'unknown' && A1({ name: 'בני דן תל אביב יפו' }) === 'unknown');
  r.ok('area: no false hits inside other words (Pintor, Parlament)', A1({ address: 'Calle del Pintor, Valencia' }) === 'out' && A1({ address: 'Parlament de Catalunya, Barcelona' }) === 'out');
  r.ok('json: Google\'s "No location information" comment is not kept as a note', t.rowsFromJson(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { Comment: 'No location information is available for this saved place', location: { name: 'North District' } } }] }))[0].note === '');
  r.ok('name from url', t.nameFromUrl('https://www.google.com/maps/place/Caf%C3%A9+Comercial/data=x') === 'Café Comercial' && t.nameFromUrl('http://maps.google.com/?q=Mercado+de+San+Miguel') === 'Mercado de San Miguel' && t.nameFromUrl('http://maps.google.com/?q=40.1,-3.2') === '');
  return r.result();
}

/* ---------- 2. the pool itself ---------- */
export async function phasePool() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const A = await open();
  r.ok('loads ready, banner hidden, not inert', A.qq('#placesBanner').hidden && !isInert(A.qq('#places')));
  r.ok('closed by default: one line, no body', !A.qq('#places .pool-body') && A.qq('.pool-toggle').getAttribute('aria-expanded') === 'false');
  r.ok('closed bar shows the count', /4 מקומות/.test(A.qq('.pool-count').textContent), A.qq('.pool-count').textContent);
  r.ok('closed bar is one calm line (<= 50px)', A.qq('#places').getBoundingClientRect().height <= 50, A.qq('#places').getBoundingClientRect().height);
  r.ok('sits above the board, inside section 08', A.qq('#plan #places') && (A.qq('#places').compareDocumentPosition(A.qq('#itin')) & 4));
  r.ok('desktop: sticky, same width as the board', A.w.getComputedStyle(A.qq('#places')).position === 'sticky' && Math.abs(A.qq('#places').getBoundingClientRect().width - A.qq('#itin').getBoundingClientRect().width) < 2);
  pact(A, 'toggle', '');
  const chips = A.qa('.pool-chip[data-pact="cat"]').map(c => c.dataset.id);
  r.ok('one click opens: 7 built-in + custom, "אחר" last', A.qq('#places .pool-body') && chips.join() === 'cafe,food,parks,museums,music,hoods,c_bars,other', chips);
  r.ok('chip labels + counts', A.qa('.pool-chip[data-pact="cat"]').map(c => c.textContent).slice(0, 2).join('|') === 'קפה2|אוכל1' && /ג׳אז וברים1/.test(A.qq('[data-pact="cat"][data-id="c_bars"]').textContent));
  r.ok('no category open yet (calm, not a wall of cards)', !A.qq('.pool-cat') && !A.qa('#places [data-place]').length);
  pact(A, 'cat', 'cafe');
  r.ok('category opens: places sorted by neighbourhood, unknown hood last', poolIds(A).join() === 'p_hola,p_toma', poolIds(A));
  pact(A, 'cat', 'food');
  r.ok('switching category shows only that one', poolIds(A).join() === 'p_botin');
  pact(A, 'cat', 'food');
  r.ok('clicking the open chip closes it', !A.qq('.pool-cat'));
  expand(A, 'cafe', 'p_hola');
  const det = A.qq('[data-place="p_hola"] .pool-detail');
  r.ok('expand: note, link, actions', det && /פלאט וייט/.test(det.textContent) && det.querySelector('.itin-link') && ['chips', 'map', 'been', 'edit', 'del'].every(a => det.querySelector(`[data-pact="${a}"]`)));
  expand(A, 'cafe', 'p_toma');
  r.ok('no coordinates -> no map button', !A.qq('[data-place="p_toma"] [data-pact="map"]') && !!A.qq('[data-place="p_toma"] [data-pact="edit"]'));

  // manual add: required name, link check, coords from a Google Maps link
  pact(A, 'new', 'cafe');
  r.ok('add form opens with the open category preselected', A.qq('[data-pform="new"] [data-pf="cat"]').value === 'cafe');
  A.qq('[data-pact="psave"][data-id="new"]').click();
  r.ok('empty name rejected', /צריך שם/.test(A.qq('[data-pform="new"] .linkerr').textContent));
  setPf(A, 'name', 'Café Comercial'); setPf(A, 'url', 'javascript:alert(1)');
  A.qq('[data-pact="psave"][data-id="new"]').click();
  r.ok('bad link rejected', /הקישור לא תקין/.test(A.qq('[data-pform="new"] .linkerr').textContent));
  setPf(A, 'url', 'https://www.google.com/maps/place/Caf%C3%A9+Comercial/@40.43,-3.70,17z/data=!4m6!3m5!1s0xd4228:0x9!8m2!3d40.4313!4d-3.7022');
  setPf(A, 'coords', '40.4 / nope');
  A.qq('[data-pact="psave"][data-id="new"]').click();
  r.ok('bad coordinates rejected', /קואורדינטות/.test(A.qq('[data-pform="new"] .linkerr').textContent));
  setPf(A, 'coords', ''); setPf(A, 'hood', 'מלסניה'); setPf(A, 'note', 'קפה היסטורי');
  A.qq('[data-pact="psave"][data-id="new"]').click();
  const added = poolIds(A).find(id => !['p_hola', 'p_toma'].includes(id));
  r.ok('added, shown in its category', added && /Café Comercial/.test(A.qq(`[data-place="${added}"]`).textContent));
  await waitIdle(A);
  let d = await docWhen(pRef(), x => x.places && x.places[added]);
  r.ok('saved with coords from the link (!3d!4d)', d && d.places[added].lat === 40.4313 && d.places[added].lng === -3.7022 && d.places[added].source === 'manual', d && d.places[added]);
  r.ok('unknown fields kept (top + inside a place)', d && d.futureTop && d.futureTop.x === 1 && d.places.p_botin.future === 'keep me');

  // edit: hood moves it; the rest stays
  r.ok('before: לבפיס, מלסניה, then no neighbourhood', poolIds(A).join() === ['p_hola', added, 'p_toma'].join(), poolIds(A));
  expand(A, 'cafe', 'p_toma');
  pact(A, 'edit', 'p_toma');
  r.ok('edit form replaces the row in place', !!A.qq('[data-pform="p_toma"]') && !A.qq('#places [data-place="p_toma"]'));
  setPf(A, 'hood', 'ארגואייס'); setPf(A, 'coords', '40.4268, -3.7038');
  A.qq('[data-pact="psave"][data-id="p_toma"]').click();
  r.ok('edit saved, re-sorted by neighbourhood (א first)', poolIds(A).join() === ['p_toma', 'p_hola', added].join(), poolIds(A));
  r.ok('map button appears once there are coordinates', !!A.qq('[data-place="p_toma"] [data-pact="map"]'));
  // Escape cancels without saving
  pact(A, 'edit', 'p_toma');
  setPf(A, 'name', 'SHOULD NOT SAVE');
  A.qq('[data-pform="p_toma"] [data-pf="name"]').dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  r.ok('Escape cancels the edit', !A.qq('[data-pform]') && /Toma Café/.test(A.qq('[data-place="p_toma"]').textContent));

  // custom categories
  pact(A, 'catnew', '');
  A.qq('[data-cf="label"]').value = 'קפה'; A.qq('[data-cf="label"]').dispatchEvent(new A.w.Event('input', { bubbles: true }));
  pact(A, 'catsave', 'new');
  r.ok('duplicate category name rejected', /כבר יש קטגוריה/.test((A.qq('[data-cform="new"] .linkerr') || {}).textContent || ''));
  A.qq('[data-cf="label"]').value = 'מאפיות'; A.qq('[data-cf="label"]').dispatchEvent(new A.w.Event('input', { bubbles: true }));
  pact(A, 'catsave', 'new');
  const newCat = A.qa('.pool-chip[data-pact="cat"]').map(c => c.dataset.id).find(k => k.startsWith('c_') && k !== 'c_bars');
  r.ok('new category added before "אחר" and opened', newCat && A.qa('.pool-chip[data-pact="cat"]').map(c => c.dataset.id).slice(-2).join() === `${newCat},other` && A.qq(`[data-cat="${newCat}"]`));
  pact(A, 'catdel', newCat);
  r.ok('empty category deleted', !A.qq(`[data-pact="cat"][data-id="${newCat}"]`));
  openCat(A, 'c_bars');
  r.ok('built-in categories have no rename/delete', (openCat(A, 'cafe'), !A.qq('[data-pact="catdel"][data-id="cafe"]') && !A.qq('[data-pact="catrename"][data-id="cafe"]')));
  openCat(A, 'c_bars');
  pact(A, 'catdel', 'c_bars');
  r.ok('non-empty category cannot be deleted', /העבירו אותם/.test((A.qq('[data-cat="c_bars"] .pool-block') || {}).textContent || '') && !!A.qq('[data-pact="cat"][data-id="c_bars"]'));
  pact(A, 'catblockok', 'c_bars');
  pact(A, 'catrename', 'c_bars');
  A.qq('[data-cf="label"]').value = 'ג׳אז'; A.qq('[data-cf="label"]').dispatchEvent(new A.w.Event('input', { bubbles: true }));
  A.qq('[data-cf="label"]').dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  r.ok('custom category renamed with Enter', /^ג׳אז1$/.test(A.qq('[data-pact="cat"][data-id="c_bars"]').textContent));
  await waitIdle(A);
  d = await docWhen(pRef(), x => x.cats && !x.cats[newCat] && x.cats.c_bars.label === 'ג׳אז' && x.places.p_toma.hood === 'ארגואייס');
  r.ok('categories saved (custom kept, empty one gone)', d && d.cats.c_bars && d.cats.c_bars.label === 'ג׳אז' && !d.cats[newCat] && d.places.p_jazz.cat === 'c_bars');

  // reload: same pool from the doc
  closeAll();
  const B = await open();
  pact(B, 'toggle', '');
  r.ok('after reload: 5 places, open state not stored (closed until clicked)', /5 מקומות/.test(B.qq('.pool-count').textContent));
  return finish(r, realBefore);
}

/* ---------- 3. the pool feeding the board ---------- */
export async function phaseBoard() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const A = await open();
  expand(A, 'cafe', 'p_hola');
  pact(A, 'chips', 'p_hola');
  r.ok('"הוסף ליום" opens 14 day chips', A.qa('[data-place="p_hola"] .pool-day').length === 14);
  pact(A, 'day', 'p_hola', D(3));
  pact(A, 'day', 'p_hola', D(9));
  r.ok('chip -> placed on 3.11 and 9.11', linkedOn(A, D(3), 'p_hola').length === 1 && linkedOn(A, D(9), 'p_hola').length === 1);
  r.ok('chips show where it is', A.qa('[data-place="p_hola"] .pool-day[aria-pressed="true"]').map(b => b.dataset.day).join() === `${D(3)},${D(9)}`);
  r.ok('"משובץ" derived: 3.11, 9.11', placedDays(A, 'p_hola') === '3.11, 9.11', placedDays(A, 'p_hola'));
  const card = linkedOn(A, D(3), 'p_hola')[0];
  r.ok('board item: live name, neighbourhood + note points, link, gold OPTIONAL', card && card.querySelector('.itin-title').textContent === 'Hola Coffee' && [...card.querySelectorAll('.itin-points li')].map(li => li.textContent).join('|') === 'לבפיס|פלאט וייט|ללכת מוקדם' && card.querySelector('.itin-link') && card.classList.contains('st-optional') && card.querySelector('.itin-badge').textContent === 'OPTIONAL');
  r.ok('board item: category in the meta line, pin icon on the neighbourhood', /קפה/.test(card.querySelector('.itin-meta').textContent) && card.querySelector('.itin-points li').dataset.icon === 'pin');
  r.ok('appended after the day\'s own item', mainIds(A, D(3))[0] === 'i03' && mainIds(A, D(3)).length === 2);
  await waitIdle(A);
  let it = await docWhen(iRef(), x => Object.values(x.items || {}).filter(v => v.placeId === 'p_hola').length === 2);
  const placed = it ? Object.values(it.items).filter(v => v.placeId === 'p_hola') : [];
  r.ok('itinerary doc: two separate items, same placeId, title copy, optional', placed.length === 2 && placed.every(v => v.title === 'Hola Coffee' && v.status === 'optional') && placed.map(v => v.day).sort().join() === `${D(3)},${D(9)}`, placed);
  r.ok('seed kept alongside (first write)', it && it.items.i01 && it.items.i07.altDay === D(8));

  // chip again = remove from that day; the place stays
  pact(A, 'day', 'p_hola', D(3));
  r.ok('second tap removes it from 3.11 only', linkedOn(A, D(3), 'p_hola').length === 0 && linkedOn(A, D(9), 'p_hola').length === 1 && placedDays(A, 'p_hola') === '9.11');
  r.ok('…and it is still in the pool', poolIds(A).includes('p_hola'));

  // drag pool -> day 5 (top = before the day's item), then again -> refused
  const src = () => A.qq('#places [data-place="p_hola"]');
  r.ok('drag into 5.11 accepted', dragEl(A, src(), A.qq(`[data-list="${D(5)}"] [data-item="i05"]`), 'top'));
  r.ok('dropped at the drop position (before i05)', mainIds(A, D(5)).length === 2 && linkedOn(A, D(5), 'p_hola')[0].dataset.item === mainIds(A, D(5))[0], mainIds(A, D(5)));
  dragEl(A, src(), dayCard(A, D(5)), 'bottom');
  r.ok('same place twice on one day is refused', linkedOn(A, D(5), 'p_hola').length === 1);
  r.ok('drop line cleaned up', !A.qq('.itin-dropline'));
  // board linked item onto the pool = remove from that day
  const onFive = linkedOn(A, D(5), 'p_hola')[0];
  const ok5 = dragEl(A, onFive, A.qq('#places'), 'top');
  r.ok('drag board item onto the pool -> removed from 5.11', ok5 && linkedOn(A, D(5), 'p_hola').length === 0 && poolIds(A).includes('p_hola'));
  r.ok('pool drop hint cleared', !A.qq('#places').classList.contains('dropzone'));
  // a hand-typed board item dropped on the pool does nothing
  r.ok('regular board item is not accepted by the pool', !dragEl(A, A.qq('[data-item="i02"]'), A.qq('#places'), 'top') && !!A.qq('[data-item="i02"]'));
  // moving a linked item with the day buttons onto a day that already has it is refused
  tapDay(A, 'cafe', 'p_hola', D(10));
  act(A, 'menu', linkedOn(A, D(9), 'p_hola')[0].dataset.item);
  act(A, 'next', linkedOn(A, D(9), 'p_hola')[0].dataset.item);
  r.ok('"ליום הבא" onto a day that already has it is refused', linkedOn(A, D(9), 'p_hola').length === 1 && linkedOn(A, D(10), 'p_hola').length === 1);
  tapDay(A, 'cafe', 'p_hola', D(10));

  // היינו: set from the pool, shown on the board, survives removal
  pact(A, 'been', 'p_hola');
  const nine = () => linkedOn(A, D(9), 'p_hola')[0];
  r.ok('"היינו" set: pool mark + board mark', A.qq('[data-place="p_hola"] [data-mark="been"]') && /היינו/.test(nine().querySelector('.itin-meta').textContent));
  act(A, 'menu', nine().dataset.item);
  r.ok('linked menu: הסר מהיום / היינו / בהמלצות / על המפה, no hard delete', ['unplace', 'been', 'reveal', 'map'].every(a => nine().querySelector(`[data-act="${a}"]`)) && !nine().querySelector('[data-act="del"]'));
  const nineId = nine().dataset.item;
  act(A, 'unplace', nineId);
  r.ok('removed from 9.11 via the menu, no confirm needed', !A.qq(`[data-item="${nineId}"]`) && !placedDays(A, 'p_hola'));
  await waitIdle(A);
  let pd = await docWhen(pRef(), x => x.places.p_hola.been === true);
  r.ok('"היינו" still set after removal (places doc, with date)', pd && pd.places.p_hola.been === true && /^\d{4}-\d{2}-\d{2}$/.test(pd.places.p_hola.beenOn));
  // been from the board menu (other place)
  tapDay(A, 'food', 'p_botin', D(4));
  const botin = () => linkedOn(A, D(4), 'p_botin')[0];
  act(A, 'menu', botin().dataset.item);
  act(A, 'been', botin().dataset.item);
  r.ok('"היינו" from the board menu marks the place in the pool', !!A.qq('[data-place="p_botin"] [data-mark="been"]'));

  // delete is blocked while placed, then confirm-only
  pact(A, 'del', 'p_botin');
  r.ok('delete blocked: "מופיע ב-4.11 — הסר משם קודם"', /מופיע ב-4\.11 — הסר משם קודם/.test((A.qq('[data-block="p_botin"]') || {}).textContent || '') && !A.qq('[data-pact="delyes"][data-id="p_botin"]'));
  pact(A, 'delno', 'p_botin');
  tapDay(A, 'food', 'p_botin', D(4));
  pact(A, 'del', 'p_botin');
  r.ok('unplaced -> explicit confirm', !!A.qq('[data-pact="delyes"][data-id="p_botin"]') && poolIds(A).includes('p_botin'));
  pact(A, 'delno', 'p_botin');
  r.ok('"לא" keeps it', poolIds(A).includes('p_botin'));
  pact(A, 'del', 'p_botin'); pact(A, 'delyes', 'p_botin');
  r.ok('"כן" deletes it', !A.qq('[data-place="p_botin"]'));

  // edit a placed place -> every day updates; the title copy follows on the next save
  tapDay(A, 'cafe', 'p_hola', D(12));
  pact(A, 'edit', 'p_hola');
  setPf(A, 'name', 'Hola Coffee Lavapiés');
  A.qq('[data-pact="psave"][data-id="p_hola"]').click();
  r.ok('rename shows on the board at once', linkedOn(A, D(12), 'p_hola')[0].querySelector('.itin-title').textContent === 'Hola Coffee Lavapiés');
  await waitIdle(A);
  it = await docWhen(iRef(), x => Object.values(x.items).some(v => v.placeId === 'p_hola' && v.title === 'Hola Coffee Lavapiés'));
  r.ok('title copy in the itinerary doc follows', !!it);

  // slots: sort within a day, unslotted last, ↑/↓ only inside a slot
  act(A, 'menu', 'i11b'); act(A, 'edit', 'i11b');
  setF(A, 'slot', 'morning');
  act(A, 'save', 'i11b');
  r.ok('slot morning moves Thyssen above the unslotted item', mainIds(A, D(11)).join() === 'i11b,i11', mainIds(A, D(11)));
  r.ok('slot shown above the title', A.qq('[data-item="i11b"] .itin-meta').textContent === 'בוקר');
  tapDay(A, 'cafe', 'p_hola', D(11));
  const holaOn11 = linkedOn(A, D(11), 'p_hola')[0].dataset.item;
  act(A, 'menu', holaOn11); act(A, 'edit', holaOn11);
  r.ok('linked edit form: no title/desc/url, has day + slot + status', !A.qq('[data-form] [data-f="title"]') && !A.qq('[data-form] [data-f="url"]') && ['day', 'slot', 'status'].every(f => A.qq(`[data-form] [data-f="${f}"]`)));
  setF(A, 'slot', 'evening');
  act(A, 'save', holaOn11);
  r.ok('morning, evening, then unslotted', mainIds(A, D(11)).join() === `i11b,${holaOn11},i11`, mainIds(A, D(11)));
  act(A, 'menu', 'i11');
  r.ok('↑ disabled across a slot boundary', A.qq('[data-item="i11"] [data-act="up"]').disabled);
  r.ok('day badge and title still there for linked edit', /Hola Coffee Lavapiés/.test(A.qq(`[data-item="${holaOn11}"] .itin-title`).textContent) && /ערב · קפה/.test(A.qq(`[data-item="${holaOn11}"] .itin-meta`).textContent));
  await waitIdle(A);
  it = await docWhen(iRef(), x => x.items.i11b.slot === 'morning' && x.items[holaOn11] && x.items[holaOn11].slot === 'evening');
  r.ok('slot saved on both', !!it);

  // reload: placements + been come back
  closeAll();
  const B = await open();
  r.ok('after reload: placements on 11.11 and 12.11, slots kept', linkedOn(B, D(11), 'p_hola').length === 1 && linkedOn(B, D(12), 'p_hola').length === 1 && mainIds(B, D(11)).join() === `i11b,${holaOn11},i11`);
  expand(B, 'cafe', 'p_hola');
  r.ok('after reload: "משובץ 11.11, 12.11" + "היינו"', placedDays(B, 'p_hola') === '11.11, 12.11' && !!B.qq('[data-place="p_hola"] [data-mark="been"]'));
  // reveal from the board opens the pool on that place
  pact(B, 'toggle', '');
  act(B, 'menu', holaOn11); act(B, 'reveal', holaOn11);
  r.ok('"בהמלצות" opens the pool on that place', B.qq('[data-pact="expand"][data-id="p_hola"]').getAttribute('aria-expanded') === 'true');
  return finish(r, realBefore);
}

/* ---------- 4. file import ---------- */
function choose(p, name, text) {
  const input = p.qq('[data-pimport="file"]');
  const dt = new p.w.DataTransfer();
  dt.items.add(new p.w.File([text], name, { type: name.endsWith('.json') ? 'application/json' : 'text/csv' }));
  input.files = dt.files;
  input.dispatchEvent(new p.w.Event('change', { bubbles: true }));
}
export async function phaseImport() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const A = await open();
  pact(A, 'toggle', '');
  pact(A, 'import', '');
  const box = () => A.qq('[data-import]');
  r.ok('import screen says which file has coordinates', /Saved Places\.json/.test(box().textContent) && /הקובץ היחיד עם קואורדינטות/.test(box().textContent) && /בלי מיקום/.test(box().textContent));
  choose(A, 'notes.txt', 'just,some\nrandom,text');
  await sleep(300);
  r.ok('wrong file -> clear error, nothing imported', /Title/.test((box().querySelector('.linkerr') || {}).textContent || '') && !box().querySelector('[data-pact="impok"]'));
  const csv = 'Title,Note,URL,Tags,Comment\n'
    + 'Hola Coffee,dup by name,,,\n'
    + 'Federal Café,brunch,https://www.google.com/maps/place/Federal/data=!4m2!3m1!1s0xd4228a:0x77,,\n'
    + 'Misión Café,,"https://www.google.com/maps/place/Mision/@40.42,-3.71,17z/data=!3m1!4b1!4m6!3m5!1s0xd4228b:0x78!8m2!3d40.4232!4d-3.7104",,\n'
    + 'Federal Café,again in the same file,,,\n';
  choose(A, 'Coffee Madrid.csv', csv);
  await sleep(300);
  const sum = () => (A.qq('[data-impsum]') || {}).textContent || '';
  const cnt = () => (A.qq('[data-impcount]') || {}).textContent || '';
  r.ok('preview: 4 rows, 2 new, 2 already there', /4 שורות: 2 חדשים/.test(sum()) && /2 כבר במאגר/.test(sum()), sum());
  r.ok('preview: both kept (a Madrid list), 1 with location', /נשמרים 2 \(1 עם מיקום\)/.test(cnt()) && /מסוננים 0/.test(cnt()), cnt());
  r.ok('category guessed from the file name (קפה)', A.qq('[data-pimport="cat"]').value === 'cafe');
  const before = await read(pRef());
  r.ok('nothing written before confirming', canonJson(before) === canonJson(FIXTURE()));
  pact(A, 'impok', '');
  r.ok('imported into קפה, category opened', /4/.test(A.qq('[data-pact="cat"][data-id="cafe"]').textContent) && A.qq('[data-cat="cafe"]'));
  await waitIdle(A);
  const d = await docWhen(pRef(), x => Object.keys(x.places).length === 6);
  const added = d ? Object.values(d.places).filter(p => p.source === 'takeout-csv') : [];
  r.ok('2 places added from takeout-csv', added.length === 2 && added.map(p => p.name).sort().join() === 'Federal Café,Misión Café', added);
  r.ok('coords from the !3d!4d link, none for the other', added.find(p => p.name === 'Misión Café').lat === 40.4232 && added.find(p => p.name === 'Federal Café').lat === undefined);
  r.ok('existing places untouched', d && canonJson(d.places.p_hola) === canonJson(FIXTURE().places.p_hola));
  // Saved Places.json -> chosen category, address kept
  pact(A, 'import', '');
  choose(A, 'Saved Places.json', JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-3.6921, 40.4138] }, properties: { google_maps_url: 'http://maps.google.com/?cid=1', location: { name: 'Museo del Prado', address: 'C. de Ruiz de Alarcón, 23, 28014 Madrid' } } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-3.6946, 40.4080] }, properties: { google_maps_url: 'http://maps.google.com/?cid=2', location: { name: 'Museo Reina Sofía', address: 'C. de Sta. Isabel, 52, Madrid' } } }
  ] }));
  await sleep(300);
  r.ok('json preview: 2 new, both in Madrid with location', /2 חדשים/.test(sum()) && /נשמרים 2 \(2 עם מיקום\)/.test(cnt()), [sum(), cnt()]);
  A.qq('[data-pimport="cat"]').value = 'museums';
  A.qq('[data-pimport="cat"]').dispatchEvent(new A.w.Event('change', { bubbles: true }));
  pact(A, 'impok', '');
  await waitIdle(A);
  const d2 = await docWhen(pRef(), x => Object.values(x.places).filter(p => p.cat === 'museums').length === 2);
  const mus = d2 ? Object.values(d2.places).filter(p => p.cat === 'museums') : [];
  r.ok('json imported into the chosen category with address + coords', mus.length === 2 && mus.every(p => p.address && p.lat && p.source === 'takeout-json'), mus);
  // same json again: all duplicates, no import button
  pact(A, 'import', '');
  choose(A, 'Saved Places.json', JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-3.6921, 40.4138] }, properties: { google_maps_url: 'http://maps.google.com/?cid=1', location: { name: 'Museo del Prado' } } }] }));
  await sleep(300);
  r.ok('importing again: 0 new, nothing to confirm', /0 חדשים/.test(sum()) && !A.qq('[data-pact="impok"]') && !A.qq('[data-pimport="filter"]'));
  pact(A, 'impcancel', '');
  return finish(r, realBefore);
}

/* ---------- 4b. the "Madrid and around" import filter ---------- */
export async function phaseFilter() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const A = await open();
  pact(A, 'toggle', '');
  pact(A, 'import', '');
  const cnt = () => (A.qq('[data-impcount]') || {}).textContent || '';
  const filterBox = () => A.qq('[data-pimport="filter"]');
  const NOLOC = 'No location information is available for this saved place';
  const feat = (name, coords, address, comment) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords || [0, 0] }, properties: Object.assign({ google_maps_url: 'http://maps.google.com/?cid=' + encodeURIComponent(name), location: Object.assign({ name }, address ? { address } : {}) }, comment ? { Comment: comment } : {}) });
  // the shapes from the real export: far places with coords, nameless-ish ones without, an address in Madrid without coords
  const json = JSON.stringify({ type: 'FeatureCollection', features: [
    feat('Museo del Prado', [-3.6921, 40.4138], 'C. de Ruiz de Alarcón, 23, 28014 Madrid, Spain'),
    feat('Catedral de Toledo', [-4.0237, 39.8569], 'C. Cardenal Cisneros, 1, 45002 Toledo, Spain'),
    feat('Sagrada Família', [2.1744, 41.4036], 'C/ de Mallorca, 401, 08013 Barcelona, Spain'),
    feat('Caesars Palace', [-115.176141, 36.117261], '3570 S Las Vegas Blvd, Paradise, NV 89109, United States'),
    feat('Casa Labra', null, 'C. de Tetuán, 12, 28013 Madrid, Spain'),
    feat('Le Comptoir', null, '9 Carrefour de l\'Odéon, 75006 Paris, France'),
    feat('North District', null, null, NOLOC),
    feat('בני דן תל אביב יפו', null, null, NOLOC)
  ] });
  choose(A, 'Saved Places.json', json);
  await sleep(300);
  r.ok('filter shown and on by default', filterBox() && filterBox().checked);
  r.ok('kept 3 (Prado, Toledo, Casa Labra), 2 with location', /נשמרים 3 \(2 עם מיקום\)/.test(cnt()), cnt());
  r.ok('filtered 5: 3 outside the area, 2 with nothing to go on', /מסוננים 5 \(3 מחוץ לאזור, 2 בלי מיקום או כתובת\)/.test(cnt()), cnt());
  const outList = (A.qq('[data-impout] div') || {}).textContent || '';
  r.ok('"מה סונן" lists them', ['Sagrada Família', 'Caesars Palace', 'Le Comptoir', 'North District', 'בני דן תל אביב יפו'].every(n => outList.includes(n)) && !outList.includes('Prado'), outList);
  r.ok('import button counts only what is kept', /ייבוא 3/.test(A.qq('[data-pact="impok"]').textContent));
  filterBox().click();
  r.ok('filter off: all 8 kept, "בלי סינון"', !filterBox().checked && /נשמרים 8 \(4 עם מיקום\)/.test(cnt()) && /בלי סינון/.test(cnt()) && /ייבוא 8/.test(A.qq('[data-pact="impok"]').textContent), cnt());
  filterBox().click();
  r.ok('back on: 3 again', /נשמרים 3/.test(cnt()));
  r.ok('nothing written during the preview', canonJson(await read(pRef())) === canonJson(FIXTURE()));
  pact(A, 'impok', '');
  await waitIdle(A);
  let d = await docWhen(pRef(), x => Object.values(x.places).filter(p => p.source === 'takeout-json').length === 3);
  const got = d ? Object.values(d.places).filter(p => p.source === 'takeout-json').map(p => p.name).sort() : [];
  r.ok('only the 3 Madrid-area places were saved', got.join() === 'Casa Labra,Catedral de Toledo,Museo del Prado', got);
  // the saved list "madrid": no coords, no addresses -> kept because the list is Madrid's
  pact(A, 'import', '');
  choose(A, 'madrid.csv', 'Title,Note,URL,Tags,Comment\nCafé de Oriente,,https://www.google.com/maps/place/Cafe+de+Oriente/data=!4m2!3m1!1s0xd4228:0x10,,\nLa Venencia,jerez,https://www.google.com/maps/place/La+Venencia/data=!4m2!3m1!1s0xd4228:0x11,,\nEl Rastro,domingo,,,\n');
  await sleep(300);
  r.ok('madrid.csv: all 3 kept, 0 filtered, note about keeping them', /נשמרים 3 \(0 עם מיקום\)/.test(cnt()) && /מסוננים 0/.test(cnt()) && /נשמרו כי זו רשימה של מדריד/.test(A.qq('[data-import]').textContent), cnt());
  pact(A, 'impcancel', '');
  // the same rows in a list that is not called madrid -> filtered as unknown unless the text says Madrid
  pact(A, 'import', '');
  choose(A, 'Want to go.csv', 'Title,Note,URL\nCafé de Oriente,,\nTemplo de Debod,mirador Madrid,\n');
  await sleep(300);
  r.ok('other list: only the row that mentions Madrid is kept', /נשמרים 1/.test(cnt()) && /מסוננים 1/.test(cnt()), cnt());
  pact(A, 'impcancel', '');
  return finish(r, realBefore);
}

/* ---------- 5. map ---------- */
export async function phaseMap() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const A = await open();
  r.ok('Leaflet not loaded until a map is opened', !A.w.L);
  r.ok('no map inside cards', !A.qa('#itin .leaflet-container, #places .leaflet-container').length);
  openCat(A, 'cafe');
  r.ok('category map button: 1 of 2 with location', /1\/2/.test(A.qq('[data-pact="catmap"][data-id="cafe"]').textContent));
  pact(A, 'catmap', 'cafe');
  const dlg = A.qq('#placesMap');
  for (let i = 0; i < 50 && A.qq('#placesMapBox').dataset.markers === undefined; i++) await sleep(200);
  r.ok('overlay opens, Leaflet loads (SRI ok)', dlg.open && !!A.w.L && A.qq('#placesMapBox .leaflet-container, #placesMapBox.leaflet-container'));
  r.ok('category map: 1 marker, note about the place without location', A.qq('#placesMapBox').dataset.markers === '1' && /מקום אחד בלי מיקום/.test(A.qq('#placesMapNote').textContent));
  r.ok('OSM attribution shown', /OpenStreetMap/.test(A.qq('.leaflet-control-attribution').textContent));
  A.qq('[data-mapclose]').click();
  r.ok('closes', !dlg.open);
  expand(A, 'food', 'p_botin');
  pact(A, 'map', 'p_botin');
  // the previous map's popup lingers until clearLayers runs — wait for this one
  for (let i = 0; i < 20 && !/Sobrino/.test((A.qq('.leaflet-popup') || {}).textContent || ''); i++) await sleep(150);
  r.ok('single place: 1 marker, popup with the name', A.qq('#placesMapBox').dataset.markers === '1' && /Sobrino de Botín/.test((A.qq('.leaflet-popup') || {}).textContent || ''));
  A.qq('[data-mapclose]').click();
  tapDay(A, 'food', 'p_botin', D(6));
  const item = linkedOn(A, D(6), 'p_botin')[0].dataset.item;
  act(A, 'menu', item); act(A, 'map', item);
  await sleep(500);
  r.ok('from a board item that came from the pool', dlg.open && /Sobrino de Botín/.test(A.qq('#placesMapTitle').textContent));
  A.qq('[data-mapclose]').click();
  return finish(r, realBefore);
}

/* ---------- 6. phone width ---------- */
export async function phaseMobile() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const M = await open('', 390);
  r.ok('phone: not sticky', M.w.getComputedStyle(M.qq('#places')).position !== 'sticky');
  expand(M, 'cafe', 'p_hola');
  pact(M, 'chips', 'p_hola');
  const chips = M.qa('[data-place="p_hola"] .pool-day');
  r.ok('phone: 14 day chips, each >= 40px tall and >= 36px wide', chips.length === 14 && chips.every(c => c.getBoundingClientRect().height >= 40 && c.getBoundingClientRect().width >= 36), chips.map(c => Math.round(c.getBoundingClientRect().width)));
  r.ok('phone: no horizontal page scroll with the pool open', M.w.document.documentElement.scrollWidth <= M.w.innerWidth, [M.w.document.documentElement.scrollWidth, M.w.innerWidth]);
  pact(M, 'day', 'p_hola', D(2));
  r.ok('phone: tap places it', linkedOn(M, D(2), 'p_hola').length === 1);
  await waitIdle(M);
  return finish(r, realBefore);
}

/* ---------- 7. another device changed the pool ---------- */
export async function phaseGuard() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  await fresh();
  const A = await open();
  const B = await open();
  expand(B, 'cafe', 'p_toma');
  pact(B, 'been', 'p_toma');
  await waitIdle(B);
  await docWhen(pRef(), x => x.places.p_toma.been);
  expand(A, 'cafe', 'p_hola');
  pact(A, 'been', 'p_hola');
  await waitIdle(A);
  for (let i = 0; i < 20 && A.qq('#placesBanner').hidden; i++) await sleep(200);
  r.ok('stale page refuses to save: conflict banner', !A.qq('#placesBanner').hidden && A.qq('#placesBanner').textContent === 'ההמלצות השתנו במכשיר אחר — רענן');
  r.ok('pool read-only, board still editable', isInert(A.qq('#places')) && !isInert(A.qq('#itin')));
  const d = await read(pRef());
  r.ok('the other device\'s change survives, the stale one did not land', d.places.p_toma.been === true && !d.places.p_hola.been);
  // focus check: a page that loaded before a remote change shows the banner on return
  const C = await open();
  await setDoc(pRef(), Object.assign(await read(pRef()), { touched: 1 }));
  C.w.dispatchEvent(new C.w.Event('focus'));
  for (let i = 0; i < 20 && C.qq('#placesBanner').hidden; i++) await sleep(200);
  r.ok('on focus: banner before typing', !C.qq('#placesBanner').hidden);
  return finish(r, realBefore);
}

/* ---------- 8. load states ---------- */
export async function phaseLoad() {
  await guard();
  const r = reporter();
  const realBefore = await realSnap();
  // a board that already has a pool item, so we can see it without the pool
  await fresh({ items: { x1: { day: D(3), order: 0, title: 'Hola Coffee', desc: '', status: 'optional', url: '', placeId: 'p_hola', future: 'f' } }, days: {} });
  const S = await open('placesload=slow', 1300, false);
  await sleep(1000);
  r.ok('slow: pool inert with a loading banner', isInert(S.qq('#places')) && /טוען את ההמלצות/.test(S.qq('#placesBanner').textContent));
  S.qq('.pool-toggle').click();
  r.ok('slow: clicks before load do nothing', !S.qq('#places .pool-body'));
  for (let i = 0; i < 40 && !S.qq('#placesBanner').hidden; i++) await sleep(200);
  r.ok('slow: ready after load', S.qq('#placesBanner').hidden && !isInert(S.qq('#places')));
  closeAll();
  // failed with no local copy: board still shows the item by its title copy
  const F = await open('placesload=fail');
  r.ok('failed: banner, pool read-only, board fine', F.qq('#placesBanner').classList.contains('failed') && isInert(F.qq('#places')) && !isInert(F.qq('#itin')));
  r.ok('failed: board item shows its title copy, no "not found" note', /Hola Coffee/.test(F.qq('[data-item="x1"] .itin-title').textContent) && !F.qq('[data-item="x1"] .itin-gone'));
  act(F, 'menu', 'x1');
  r.ok('failed: "היינו" unavailable on the board', !F.qq('[data-item="x1"] [data-act="been"]') || F.qq('[data-item="x1"] [data-act="been"]').disabled);
  closeAll();
  // local fallback after a good load
  const G = await open();
  r.ok('normal load: board item reads the live place', [...G.qq('[data-item="x1"]').querySelectorAll('.itin-points li')].length === 3);
  pact(G, 'toggle', '');
  await waitIdle(G);
  closeAll();
  localStorage.setItem(LOCAL.places, JSON.stringify(FIXTURE()));
  const L = await open('placesload=fail');
  r.ok('failed with a local copy: the local pool is shown, read-only', /4 מקומות/.test(L.qq('.pool-count').textContent) && /העותק האחרון/.test(L.qq('#placesBanner').textContent));
  closeAll();
  // place deleted elsewhere: the board item stays, with a note
  const doc0 = FIXTURE(); delete doc0.places.p_hola;
  await setDoc(pRef(), doc0);
  const X = await open();
  r.ok('place missing from the pool: item stays with its title + note', /Hola Coffee/.test(X.qq('[data-item="x1"] .itin-title').textContent) && !!X.qq('[data-item="x1"] .itin-gone'));
  act(X, 'menu', 'x1');
  r.ok('…and can still be removed from the day', !!X.qq('[data-item="x1"] [data-act="unplace"]'));
  // unknown fields inside a board item survive a save
  act(X, 'menu', 'x1'); act(X, 'edit', 'x1');
  setF(X, 'slot', 'noon');
  act(X, 'save', 'x1');
  await waitIdle(X);
  const it = await docWhen(iRef(), x => x.items.x1 && x.items.x1.slot === 'noon');
  r.ok('board item: unknown field + placeId + title copy kept on save', it && it.items.x1.future === 'f' && it.items.x1.placeId === 'p_hola' && it.items.x1.title === 'Hola Coffee');
  return finish(r, realBefore);
}

export async function dropTestDoc() {
  await guard();
  await deleteDoc(pRef());
  await deleteDoc(iRef());
  localStorage.removeItem(LOCAL.places); localStorage.removeItem(LOCAL.itinerary);
  closeAll();
  return 'places_test + itinerary_test deleted';
}
