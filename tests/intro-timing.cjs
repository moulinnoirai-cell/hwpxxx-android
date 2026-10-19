// Measures the file-access intro in a real browser against 05_TRANSITIONS.md.
// Needs tests/preview-server.mjs running and playwright-core with a local Chrome/Edge:
//   node tests/intro-timing.cjs [http://localhost:8765] [path-to-playwright-core]
const base = process.argv[2] || 'http://localhost:8765';
const { chromium } = require(process.argv[3] || 'playwright-core');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
  const page = await browser.newPage({ viewport: { width: 393, height: 800 }, deviceScaleFactor: 2 });
  await page.goto(base + '/__grant?0');
  await page.goto(base);
  await page.waitForSelector('.hw-onboarding');
  check('intro shown without permission, list tools hidden', await page.$eval('.hw-tools', e => e.hidden));

  // Same top, line height and art height on all three screens.
  const geo = await page.$$eval('[data-slide]', slides => slides.map(s => {
    const r = n => n.getBoundingClientRect(), h = s.querySelector('h2'), p = s.querySelector('.hw-intro-subtitle'), art = s.querySelector('.hw-collection,.hw-flat-scene');
    return { h2: [Math.round(r(h).top), Math.round(r(h).height)], sub: [Math.round(r(p).top), Math.round(r(p).height)], art: Math.round(r(art).height), text: h.innerText + ' / ' + p.innerText };
  }));
  check('titles and subtitles aligned on all screens', geo.every(g => JSON.stringify([g.h2, g.sub]) === JSON.stringify([geo[0].h2, geo[0].sub])), JSON.stringify(geo.map(g => [g.h2, g.sub])));
  check('art height 264px on all screens', geo.every(g => g.art === 264), geo.map(g => g.art).join(','));
  check('exact copy', geo.map(g => g.text.replace(/\n/g, '|')).join(' ## ') ===
    '한글 문서를|한곳에 모아보세요 / 폴더마다 흩어진 문서를|한눈에 찾아볼 수 있어요. ## 보안걱정 끝!|문서 유출 없어요. / 인터넷 연결 없이,|문서 작업은 자유롭게. ## 광고 없이|완전 무료 / 결제 걱정 없이|문서에만 집중하세요.',
    geo.map(g => g.text).join(' ## '));
  const ring = await page.$eval('.hw-circle-ring', e => { const s = getComputedStyle(e), r = e.getBoundingClientRect(); return [s.borderTopWidth, Math.round(r.width), Math.round(r.height)]; });
  const slash = await page.$eval('.hw-circle-slash', e => getComputedStyle(e).height);
  check('screen 2 ring is a 220px circle with 6px stroke and 6px slash', ring[0] === '6px' && ring[1] === 220 && ring[2] === 220 && slash === '6px', JSON.stringify([ring, slash]));

  // One full automatic cycle: sample opacities every frame for ~19 s.
  const ctaBefore = await page.$eval('[data-action="allow"]', e => e.getBoundingClientRect().top);
  const samples = await page.evaluate(() => new Promise(done => {
    const slides = [...document.querySelectorAll('[data-slide]')], ad = document.querySelector('.hw-free-ad-stage'), price = document.querySelector('.hw-free-price-stage'), out = [], t0 = performance.now();
    (function tick() {
      const t = performance.now() - t0;
      out.push([t, ...slides.map(s => +getComputedStyle(s).opacity), +getComputedStyle(ad).opacity, +getComputedStyle(price).opacity, document.querySelector('[data-action="allow"]').getBoundingClientRect().top]);
      if (t < 19500) requestAnimationFrame(tick); else done(out);
    })();
  }));
  const visible = s => s.slice(1, 4).map((o, i) => o > 0.01 ? i : -1).filter(i => i >= 0);
  check('never two screens visible at once', samples.every(s => visible(s).length <= 1), samples.filter(s => visible(s).length > 1).length + ' frames');
  check('AD and 0원 never visible together', samples.every(s => !(s[4] > 0.01 && s[5] > 0.01 && s[3] > 0.01)));
  check('CTA does not move', samples.every(s => Math.abs(s[6] - ctaBefore) < 0.5));
  // Find each fade: last frame fully visible -> first frame hidden (out), then hidden -> fully visible (in).
  const fades = [];
  for (let from = 0; from < 3; from++) {
    const to = (from + 1) % 3, o = samples.findIndex((s, i) => i > 0 && samples[i - 1][1 + from] > 0.99 && s[1 + from] < 0.99);
    if (o < 0) continue;
    const hidden = samples.findIndex((s, i) => i >= o && s[1 + from] < 0.01), shown = samples.findIndex((s, i) => i >= hidden && s[1 + to] > 0.99);
    fades.push({ from, to, out: Math.round(samples[hidden][0] - samples[o][0]), in: Math.round(samples[shown][0] - samples[hidden][0]), at: Math.round(samples[o][0]) });
  }
  check('fade out ~160ms and fade in ~240ms', fades.length >= 3 && fades.every(f => f.out >= 120 && f.out <= 230 && f.in >= 200 && f.in <= 320), JSON.stringify(fades));
  const holds = fades.slice(1).map((f, i) => f.at - (fades[i].at + fades[i].out + fades[i].in));
  check('hold after fade-in 5600 (screen 2) / 6000 (screen 3)', holds.length >= 2 && Math.abs(holds[0] - 5600) < 250 && Math.abs(holds[1] - 6000) < 250, holds.join(','));

  // Rapid taps go to the last destination without overlapping screens.
  const tap = await page.evaluate(async () => {
    const slides = [...document.querySelectorAll('[data-slide]')], frames = [];
    let run = true; (function tick() { if (!run) return; frames.push(slides.map(s => +getComputedStyle(s).opacity)); requestAnimationFrame(tick); })();
    const cur = +document.querySelector('.hw-onboarding').dataset.introStage, a = (cur + 1) % 3, b = (cur + 2) % 3;
    document.querySelector(`[data-page="${a}"]`).click(); await new Promise(r => setTimeout(r, 40)); document.querySelector(`[data-page="${b}"]`).click();
    await new Promise(r => setTimeout(r, 1200)); run = false;
    return { target: b, stage: +document.querySelector('.hw-onboarding').dataset.introStage, overlap: frames.filter(f => f.filter(o => o > 0.01).length > 1).length };
  });
  check('rapid taps end on the last tapped screen, no overlap', tap.stage === tap.target && tap.overlap === 0, JSON.stringify(tap));

  // Settings popup freezes timer and motion; closing resumes.
  await page.click('[data-action="settings"]');
  const pausedState = await page.evaluate(async () => { const s = document.querySelector('.hw-onboarding').dataset.introStage; await new Promise(r => setTimeout(r, 6500)); return { same: s === document.querySelector('.hw-onboarding').dataset.introStage, running: document.getAnimations().filter(a => a.playState === 'running' && a.effect?.target?.closest?.('.hw-onboarding')).length }; });
  check('settings popup pauses the intro', pausedState.same && pausedState.running === 0, JSON.stringify(pausedState));
  await page.click('#sheet [data-action="close"]');

  // Reduced motion: no movement or fades, static complete art, messages still alternate.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  const reduced = await page.evaluate(async () => {
    document.querySelector('[data-page="0"]').click(); await new Promise(r => setTimeout(r, 300));
    // Step-eased keyframes are the instant AD/0원 swap, not motion.
    const moving = document.getAnimations().filter(a => a.playState === 'running' && a.effect?.target?.closest?.('.hw-onboarding') && a.effect.getKeyframes().some(k => !(k.easing || '').startsWith('steps'))).length;
    return { moving, collected: document.querySelector('.hw-collect-destination').classList.contains('hw-collected') };
  });
  check('reduced motion shows a static finished picture', reduced.moving === 0 && reduced.collected, JSON.stringify(reduced));

  // Granting access removes the intro and lists documents.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => __mock.grant(true));
  await page.waitForSelector('.hw-doc', { timeout: 5000 }).catch(() => {});
  check('after grant: no intro, documents listed', !(await page.$('.hw-onboarding')) && (await page.$$('.hw-doc')).length > 0);
  await page.screenshot({ path: 'tests/out-library.png' });
  await page.evaluate(() => __mock.grant(false));
  await page.waitForSelector('.hw-onboarding');
  for (const [n, name] of [[0, 'collect'], [1, 'security'], [2, 'free']]) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click(`[data-page="${n}"]`); await page.waitForTimeout(3200);
    await page.screenshot({ path: `tests/out-intro-${name}.png` });
  }
  await browser.close();
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
})();
