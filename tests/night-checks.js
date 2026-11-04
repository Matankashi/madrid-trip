/* Browser checks for night mode (assets/night.js + :root[data-theme="night"]).
   No framework, no build step, and nothing here reads or writes Firestore docs:
   it only looks at colours and at the clock.

   HOW TO RUN
   1. python3 tests/serve-test.py           (night.js gets a test clock)
   2. Open http://localhost:8000/budget.html in a Chrome that is signed in.
   3. In the console (or via automation):
        const t = await import('/tests/night-checks.js');
        await t.phaseClock();   // 08:00 and 20:00 boundaries, an open page flips by itself
        await t.phaseColours(); // no stray colours in the sheet, day palette unchanged, contrast
   Each phase returns {passed, failed, failures:[...]}. */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function reporter() {
  const failures = []; let passed = 0;
  return {
    ok(name, cond, detail) { if (cond) passed++; else failures.push(detail === undefined ? name : `${name}: ${JSON.stringify(detail)}`); },
    result() { return { passed, failed: failures.length, failures }; }
  };
}

async function guard() {
  const src = await (await fetch('/assets/night.js', { cache: 'no-store' })).text();
  if (!src.includes('__testHour()')) throw new Error('night.js is not served by tests/serve-test.py - refusing to run');
}

function frame(path) {
  return new Promise(resolve => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:700px;opacity:0;pointer-events:none';
    f.onload = () => resolve(f);
    f.src = path;
    document.body.appendChild(f);
  });
}

const isNight = w => w.document.documentElement.getAttribute('data-theme') === 'night';

export async function phaseClock() {
  await guard();
  const r = reporter();
  const expected = { 0: true, 3: true, 7: true, 8: false, 12: false, 19: false, 20: true, 23: true };
  for (const [hour, night] of Object.entries(expected)) {
    const f = await frame(`/login.html?hour=${hour}`);
    r.ok(`${hour}:00 is ${night ? 'night' : 'day'}`, isNight(f.contentWindow) === night);
    f.remove();
  }

  // an open page crosses a boundary: back to the tab re-checks, without a reload
  const f = await frame('/login.html?hour=19');
  const w = f.contentWindow;
  r.ok('open page starts in day', !isNight(w));
  w.__nightHour = 20;
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  r.ok('crossing 20:00 turns it to night', isNight(w));
  const bg = w.getComputedStyle(w.document.body).backgroundColor;
  r.ok('the page really is dark', bg === 'rgb(14, 21, 34)', bg);
  w.__nightHour = 8;
  w.dispatchEvent(new w.Event('focus'));
  r.ok('crossing 08:00 turns it back to day', !isNight(w));
  f.remove();

  // the attribute is on the page before the sheet applies, so no light flash
  const html = await (await fetch('/login.html', { cache: 'no-store' })).text();
  r.ok('night.js is loaded before the stylesheet', html.indexOf('assets/night.js') > -1 && html.indexOf('assets/night.js') < html.indexOf('assets/styles.css'));
  for (const page of ['index.html', 'dossier.html', 'budget.html', 'login.html']) {
    const src = await (await fetch('/' + page, { cache: 'no-store' })).text();
    r.ok(`${page} loads night.js as a plain script`, src.includes('<script src="assets/night.js"></script>'));
  }
  return r.result();
}

const DAY = {
  '--ink': '#0F1E38', '--paper': '#F4F2EC', '--rojo': '#C4262E', '--slate': '#5B6472', '--line': '#D8D4C8',
  '--gold': '#C9962C', '--green': '#2F6F4E', '--blue': '#3D6E8C', '--plum': '#8C3B4A', '--sand': '#A9A497',
  '--purple': '#7A5C99', '--surface': '#fff', '--on-ink': '#fff', '--note-bg': '#fffdf7'
};
// text colours must stay readable on every background they can sit on at night
const TEXT = ['--ink', '--rojo', '--slate', '--gold', '--green', '--blue', '--plum', '--purple'];
const BACKS = ['--paper', '--surface', '--note-bg'];

function luminance(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export async function phaseColours() {
  await guard();
  const r = reporter();
  const css = await (await fetch('/assets/styles.css', { cache: 'no-store' })).text();

  // every literal colour lives in the two token blocks at the top of the sheet
  const tokensEnd = css.indexOf('/* המפה:');
  r.ok('token blocks found', tokensEnd > 0);
  const stray = css.slice(tokensEnd).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || [];
  r.ok('no literal colours below the token blocks', stray.length === 0, stray);

  // and every token of the day block also has a night value, except fixed ones
  const blockOf = sel => { const i = css.indexOf(sel); return css.slice(i, css.indexOf('}', i)); };
  const dayBlock = blockOf(':root{'), nightBlock = blockOf(':root[data-theme="night"]{');
  const names = b => [...b.matchAll(/(--[a-z-]+):/g)].map(m => m[1]);
  const skip = new Set(['--font-display', '--font-body', '--font-mono', '--max-width', '--radius']);
  const missing = names(dayBlock).filter(n => !skip.has(n) && !names(nightBlock).includes(n));
  r.ok('every day colour has a night value', missing.length === 0, missing);

  // the day palette did not move
  const day = await frame('/login.html?hour=12');
  const ds = day.contentWindow.getComputedStyle(day.contentDocument.documentElement);
  for (const [k, v] of Object.entries(DAY)) {
    r.ok(`day ${k} unchanged`, ds.getPropertyValue(k).trim().toLowerCase() === v.toLowerCase(), ds.getPropertyValue(k));
  }
  day.remove();

  const night = await frame('/login.html?hour=21');
  const ns = night.contentWindow.getComputedStyle(night.contentDocument.documentElement);
  const v = k => ns.getPropertyValue(k).trim();
  for (const t of TEXT) for (const b of BACKS) {
    const c = contrast(v(t), v(b));
    r.ok(`night ${t} on ${b} is readable (4.5:1)`, c >= 4.5, c.toFixed(2));
  }
  const onInk = contrast(v('--on-ink'), v('--ink'));
  r.ok('night text on an ink fill is readable', onInk >= 4.5, onInk.toFixed(2));
  const onGreen = contrast(v('--on-ink'), v('--green'));
  r.ok('night tick on a green fill is readable', onGreen >= 4.5, onGreen.toFixed(2));
  r.ok('native controls go dark at night', ns.colorScheme === 'dark', ns.colorScheme);
  night.remove();

  await sleep(0);
  return r.result();
}
