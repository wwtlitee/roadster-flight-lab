import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const URL = process.env.ROADSTER_TEST_URL || 'http://127.0.0.1:5188';
const output = path.resolve(process.env.ROADSTER_TEST_OUTPUT || 'output/browser-final');
const STEP_MS = 1000 / 120;
const jetKeys = [...'qweasdzxc'];
let desktopCamera = null;
function assertCamera(state) {
  assert.equal(state.cameraMode, 'wide-follow');
  assert.equal(state.camera.fov, 30.5 + 9.5 * state.camera.blend, 'the original wide lens eases into the jet-control lens');
  if (state.flightTime === 0) {
    assert.equal(state.shot, 'fixed-wide');
    assert.deepEqual(state.camera.target, [0, 10, 40], 'retain the original video wide-shot target');
    const fit = Math.max(1, 1.78 / state.camera.aspect);
    assert.deepEqual(state.camera.position, [-37 * fit, 10 + 1.8 * fit, 40 - 61 * fit], 'retain the original video wide-shot position with portrait fitting');
    if (desktopCamera && state.camera.aspect === desktopCamera.aspect) assert.deepEqual(state.camera, desktopCamera, 'approach and climb remain at the same fixed wide view');
  } else {
    assert.ok(state.camera.blend > 0, 'the camera starts approaching on the first airborne frame');
    assert.ok(['flight-transition', 'flight-follow'].includes(state.shot));
    if (state.flightTime >= 0.75) {
      assert.equal(state.shot, 'flight-follow');
      assert.equal(state.camera.blend, 1);
      const distance = Math.hypot(...state.camera.position.map((value, index) => value - state.camera.target[index]));
      if (state.flightTime >= 1.4) assert.ok(distance < (state.camera.aspect > 1 ? 22 : 34), 'side-roll and jet control use a closer camera after the immediate eased approach');
    }
  }
}

const report = { url: URL, startedAt: new Date().toISOString(), browser: 'isolated headless Chromium', checks: [], screenshots: [], errors: [], warnings: [], results: {} };
await mkdir(output, { recursive: true });
async function installedChromium() {
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  if (existsSync(chromium.executablePath())) return chromium.executablePath();
  if (!process.env.LOCALAPPDATA) return undefined;
  const cache = path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  const versions = (await readdir(cache).catch(() => [])).filter((name) => /^chromium-\d+$/.test(name))
    .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]));
  for (const version of versions) {
    for (const folder of ['chrome-win64', 'chrome-win']) {
      const candidate = path.join(cache, version, folder, 'chrome.exe');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
const browserArgs = ['--enable-webgl', '--disable-dev-shm-usage'];
if (process.env.ROADSTER_SOFTWARE_WEBGL === '1') browserArgs.push('--use-angle=swiftshader');
const browser = await chromium.launch({ executablePath: await installedChromium(), headless: true, args: browserArgs });
report.browserVersion = browser.version();
const contexts = [];

function checked(name) { report.checks.push(name); console.log(`PASS ${name}`); }
function watch(page, label) {
  page.on('pageerror', (error) => report.errors.push({ page: label, type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push({ page: label, type: 'console', message: message.text() });
    if (message.type() === 'warning') report.warnings.push({ page: label, message: message.text() });
  });
  page.on('requestfailed', (request) => report.errors.push({ page: label, type: 'network', url: request.url(), message: request.failure()?.errorText }));
}
const read = (page) => page.evaluate(() => JSON.parse(window.render_game_to_text()));
const advance = (page, ms = STEP_MS) => page.evaluate((duration) => window.advanceTime(duration), ms);
const advanceRead = (page, ms = STEP_MS) => page.evaluate((duration) => {
  window.advanceTime(duration);
  return JSON.parse(window.render_game_to_text());
}, ms);
async function open(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.advanceTime === 'function');
  await advance(page, 0);
  await page.waitForFunction(() => window.render_game_to_text && JSON.parse(window.render_game_to_text()).model?.status === 'ready', null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#control-car')?.dataset.ready === 'true', null, { timeout: 30000 });
  await advance(page, 0);
  assert.equal((await read(page)).mode, 'running', 'model readiness starts driving without an intro or start button');
  assert.equal((await read(page)).phase, 'ground');
}
async function assertCleanPlayfield(page) {
  const visibleText = await page.locator('body').innerText();
  assert.doesNotMatch(visibleText, /控制权|由你控制|由你驾驶|你来开|先松开驾驶键|翻正车身|稳住，准备落地|对准轨道，向前开/);
  for (const selector of ['#menu', '#start-btn', '#flight-banner', '#mission-title', '#mission-tip', '#phase-label', '#help-screen']) {
    assert.equal(await page.locator(selector).isVisible(), false, `${selector} must not cover the playing scene`);
  }
}
async function assertControlLayout(page, mode) {
  assert.equal(await page.locator('#jet-panel').getAttribute('data-mode'), mode);
  const expected = mode === 'drive' ? [...'wasd'] : jetKeys;
  const visible = [];
  const boxes = {};
  for (const key of jetKeys) {
    const button = page.locator(`#jet-${key}`);
    if (await button.isVisible()) {
      visible.push(key);
      const box = await button.boundingBox();
      boxes[key] = { ...box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
    }
  }
  assert.deepEqual(visible.sort(), [...expected].sort(), `${mode} exposes exactly the relevant driving or jet keys`);
  const panel = await page.locator('#jet-panel').boundingBox();
  const car = await page.locator('#control-car').boundingBox();
  const viewport = page.viewportSize();
  assert.ok(panel && car && car.height > car.width, 'a portrait top-view car is visible inside the control panel');
  assert.ok(panel.y > viewport.height / 2 && panel.y + panel.height <= viewport.height, 'controls fit the bottom half of the viewport');
  assert.ok(Math.abs(panel.x + panel.width / 2 - viewport.width / 2) < panel.width * 0.05, 'controls are horizontally centered');
  const cx = car.x + car.width / 2;
  const cy = car.y + car.height / 2;
  const centeredX = (key) => Math.abs(boxes[key].cx - cx) < boxes[key].width / 2;
  const centeredY = (key) => Math.abs(boxes[key].cy - cy) < boxes[key].height / 2;
  assert.ok(centeredX('w') && boxes.w.cy < cy, 'W sits above the car center');
  assert.ok(boxes.a.cx < cx && boxes.d.cx > cx && centeredY('a') && centeredY('d'), 'A and D flank the car');
  if (mode === 'drive') {
    assert.ok(centeredX('s') && boxes.s.cy > cy, 'driving S sits below the car center');
  } else {
    assert.ok(centeredX('s') && centeredY('s'), 'main jet S overlays the center of the car');
    for (const row of ['qwe', 'asd', 'zxc']) {
      const [left, middle, right] = [...row].map((key) => boxes[key]);
      assert.ok(left.cx < middle.cx && middle.cx < right.cx, `${row} follows left-center-right order`);
      assert.ok(Math.max(left.cy, middle.cy, right.cy) - Math.min(left.cy, middle.cy, right.cy) < middle.height / 2, `${row} shares a row`);
    }
    assert.ok(boxes.q.cy < boxes.a.cy && boxes.a.cy < boxes.z.cy, 'front, middle and rear jets follow the car length');
  }
  for (const [key, box] of Object.entries(boxes)) {
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${key} fits the viewport`);
  }
  await assertCleanPlayfield(page);
}
async function screenshot(page, name) {
  // Camera interpolation and GPU submission may settle; physics stays on the manual clock.
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  report.screenshots.push(`${name}.png`);
}
async function releaseAll(page) {
  for (const key of jetKeys) await page.keyboard.up(`Key${key.toUpperCase()}`);
}
async function driveToAir(page, capture = false) {
  await page.keyboard.down('KeyW');
  const shots = new Set();
  for (let frame = 0; frame < 100; frame += 1) {
    const state = await advanceRead(page, 50);
    assertCamera(state);
    if (capture && state.phase === 'climb') {
      const name = state.trackAngle > 2.85 ? '06-inverted-170-approach' : state.trackAngle > 1.85 && state.trackAngle < 2.5 ? '05-climb-fixed-wide' : state.trackAngle > 0.6 && state.trackAngle < 1.4 ? '04-climb-wide' : null;
      if (name && !shots.has(name)) { shots.add(name); await screenshot(page, name); }
    }
    if (state.phase === 'air') {
      if (capture) {
        await assertControlLayout(page, 'air');
        await screenshot(page, '07-inverted-release');
      }
      return state;
    }
  }
  throw new Error('Continuous player W did not drive through the curve and take off within 5 seconds');
}
function assertFrozen(before, after) {
  assert.deepEqual(after.player, before.player);
  assert.equal(after.elapsed, before.elapsed);
  assert.equal(after.flightTime, before.flightTime);
  assert.equal(after.fuel, before.fuel);
}
function feedbackKeys(state, targetRoll = 0) {
  const keys = new Set();
  const roll = -12 * (state.player.roll - targetRoll) - 1.5 * state.angular.roll;
  if (roll < -0.04) keys.add('a');
  else if (roll > 0.04) keys.add('d');
  if (Math.abs(state.player.roll - targetRoll) < 0.2) {
    const pitch = -5 * state.player.pitch - 2 * state.angular.pitch;
    if (pitch < -0.04) keys.add('x');
    else if (pitch > 0.04) keys.add('w');
  }
  const desiredVelocity = -Math.min(5.5, 1.5 + Math.sqrt(6 * Math.max(0, state.player.position.y)));
  if (Math.cos(state.player.pitch) * Math.cos(state.player.roll) > (targetRoll ? 0.85 : 0.98) && state.player.velocity.y < desiredVelocity) keys.add('s');
  return keys;
}
function forwardVector(state) {
  const [x, y, z, w] = state.player.orientation;
  assert.ok(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-10, 'flight quaternion stays normalized');
  return { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) };
}
async function flyWithKeyboard(page) {
  let previousKeys = new Set();
  const usedKeys = new Set();
  let state = await read(page);
  let balancedShot = false;
  let landingShot = false;
  let sideRollShot = false;
  const initialForward = forwardVector(state);
  assert.ok(initialForward.z < -0.98, 'release points away from the track');
  report.results.forward = { release: initialForward, maximumZ: initialForward.z, samples: 0 };
  for (let frame = 0; frame < 1200; frame += 1) {
    if (state.phase === 'landed' || state.phase === 'crashed') {
      await releaseAll(page);
      if (state.phase === 'landed') {
        report.results.forward.touchdown = forwardVector(state);
        report.results.forward.usedKeys = [...usedKeys];
        assert.ok(report.results.forward.touchdown.z < -0.9, 'the upright car lands with its nose facing away from the track');
        assert.ok(['a', 'd', 's', 'w', 'x'].every((key) => usedKeys.has(key)), 'side-roll, counter-roll, pitch trim and descent control all use actual keys');
        assert.equal(state.mode, 'running', 'touchdown must remain visible before the result modal');
        assert.equal(state.result.success, true);
        assert.ok(state.result.tilt <= state.limits.tilt && state.result.verticalSpeed <= state.limits.verticalSpeed);
        await assertCleanPlayfield(page);
        await page.keyboard.down('KeyS');
        const frozen = await advanceRead(page, 200);
        assertFrozen(state, frozen);
        assert.deepEqual(frozen.heldKeys, []);
        assert.deepEqual(frozen.activeJets, []);
        assert.equal(await page.locator('#jet-s').getAttribute('aria-pressed'), 'false');
        await page.keyboard.up('KeyS');
        await screenshot(page, '11-touchdown-before-result');
        checked('touchdown preserves the unobstructed scene and locks jet input before the score dialog');
      }
      await advance(page, 2000);
      return read(page);
    }
    assertCamera(state);
    if (state.phase === 'contact') {
      await releaseAll(page); previousKeys = new Set();
      assert.deepEqual(state.activeJets, []);
      const geometry = await page.evaluate(() => window.inspect_vehicle_geometry());
      assert.ok(geometry.minimumY >= -0.035, `actual GLB must remain above the floor: ${geometry.minimumY}`);
      report.results.contact ||= { frames: 0, minimumMeshY: Infinity, peakUpwardSpeed: 0, first: state };
      report.results.contact.frames++;
      report.results.contact.minimumMeshY = Math.min(report.results.contact.minimumMeshY, geometry.minimumY);
      report.results.contact.peakUpwardSpeed = Math.max(report.results.contact.peakUpwardSpeed, state.player.velocity.y);
      if (report.results.contact.frames === 1) await screenshot(page, '10b-first-wheel-contact');
      if (report.results.contact.frames === 20) await screenshot(page, '10c-contact-rebound');
      state = await advanceRead(page, 1000 / 60);
      continue;
    }
    assert.equal(state.phase, 'air');
    const next = feedbackKeys(state);
    const beforeForward = forwardVector(state);
    for (const key of previousKeys) if (!next.has(key)) await page.keyboard.up(`Key${key.toUpperCase()}`);
    for (const key of next) if (!previousKeys.has(key)) await page.keyboard.down(`Key${key.toUpperCase()}`);
    next.forEach((key) => usedKeys.add(key));
    previousKeys = next;
    state = await advanceRead(page, 1000 / 60);
    const afterForward = forwardVector(state);
    report.results.forward.maximumZ = Math.max(report.results.forward.maximumZ, afterForward.z);
    report.results.forward.samples += 1;
    if (state.phase === 'air') assert.ok(afterForward.z < -0.98, 'side-roll recovery must never turn the nose back toward the track');
    if (state.phase === 'air' && !usedKeys.has('w') && !usedKeys.has('x')) {
      assert.ok(Math.hypot(afterForward.x - beforeForward.x, afterForward.y - beforeForward.y, afterForward.z - beforeForward.z) < 1e-10, 'pure side jets rotate around the unchanged forward axis');
    }
    if (!sideRollShot && Math.abs(state.player.roll) < 1.75 && Math.abs(state.player.roll) > 1.3) {
      sideRollShot = true;
      report.results.forward.sideRoll = { direction: afterForward, roll: state.player.roll, pitch: state.player.pitch };
      await screenshot(page, '08b-side-roll-90-degrees');
    }
    if (!balancedShot && state.flightTime > 1.2 && Math.abs(state.player.pitch) < 0.244 && Math.abs(state.player.roll) < 0.08) {
      balancedShot = true;
      await screenshot(page, '09-balanced-flight');
    }
    if (!landingShot && state.phase === 'air' && state.altitude < 3) {
      landingShot = true;
      await screenshot(page, '10-landing-continuous-follow');
    }
    if (frame > 0 && frame % 120 === 0) console.log(`FLIGHT ${state.flightTime.toFixed(2)}s height=${state.altitude.toFixed(2)}m pitch=${(state.player.pitch * 180 / Math.PI).toFixed(1)}deg`);
  }
  throw new Error(`Keyboard feedback did not finish; used keys: ${[...usedKeys].join(',')}`);
}

async function imperfectLanding(page) {
  let state = await read(page), previous = new Set();
  const evidence = { wheelSequences: [], minimumMeshY: Infinity, peakUpwardSpeed: 0 };
  let photographed = false;
  for (let frame = 0; frame < 1500; frame++) {
    assertCamera(state);
    if (['landed', 'crashed'].includes(state.phase)) break;
    const next = state.phase === 'air' ? feedbackKeys(state, 20 * Math.PI / 180) : new Set();
    for (const key of previous) if (!next.has(key)) await page.keyboard.up(`Key${key.toUpperCase()}`);
    for (const key of next) if (!previous.has(key)) await page.keyboard.down(`Key${key.toUpperCase()}`);
    previous = next;
    state = await advanceRead(page, 1000 / 60);
    if (state.phase === 'contact') {
      evidence.first ||= state;
      const wheels = [...state.contact.wheels].sort().join(',');
      if (wheels !== evidence.wheelSequences.at(-1)) evidence.wheelSequences.push(wheels);
      const geometry = await page.evaluate(() => window.inspect_vehicle_geometry());
      assert.ok(geometry.projectedCorners.every(([x, y]) => Math.abs(x) < 1 && Math.abs(y) < 1), 'the continuous close follow view contains the whole landed car');
      evidence.minimumMeshY = Math.min(evidence.minimumMeshY, geometry.minimumY);
      evidence.peakUpwardSpeed = Math.max(evidence.peakUpwardSpeed, state.player.velocity.y);
      assert.ok(geometry.minimumY >= -0.035, `angled GLB must remain above floor: ${geometry.minimumY}`);
      if (!photographed) { photographed = true; await screenshot(page, '16-angled-first-contact'); }
    }
  }
  await releaseAll(page);
  assert.equal(state.phase, 'landed', JSON.stringify(state.result));
  assert.ok(state.result.tilt > 14 && state.result.tilt < 35, 'an ordinary landing angle outside the old hard limit is exercised');
  assert.ok(state.result.score > 0 && state.result.score < 1000, 'imperfect landing has a positive partial score');
  assert.equal(state.contact.wheels.length, 4, 'the car naturally comes down onto all four wheels');
  assert.ok(state.contact.rolloutTime >= 1.2, 'the wheels keep rolling before the result appears');
  assert.ok(evidence.wheelSequences.some((value) => value && value.split(',').length < 4), 'fewer than four wheels make first contact');
  assert.ok(evidence.peakUpwardSpeed > 0.05, 'the angled collision has a physical rebound');
  const firstPosition = evidence.first.player.position;
  const forward = forwardVector(evidence.first);
  const delta = { x: state.player.position.x - firstPosition.x, z: state.player.position.z - firstPosition.z };
  evidence.forwardRollDistance = delta.x * forward.x + delta.z * forward.z;
  assert.ok(evidence.forwardRollDistance > 0.2, 'the landed car visibly rolls forward');
  await screenshot(page, '17-angled-settled-rollout');
  await advance(page, 2000); state = await read(page);
  assert.equal(state.mode, 'result');
  assert.equal(state.best.normal, state.result.score, 'a partial landing score is saved in a fresh profile');
  evidence.final = state;
  report.results.imperfect = evidence;
  await screenshot(page, '18-angled-partial-score');
}

try {
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  contexts.push(desktopContext);
  const page = await desktopContext.newPage();
  watch(page, 'desktop');
  await open(page);
  report.assetSource = await page.evaluate(async () => {
    const response = await fetch(new globalThis.URL('./assets/roadster.source.json', location.href));
    if (!response.ok) throw new Error(`Model source receipt returned HTTP ${response.status}`);
    return response.json();
  });
  assert.equal(report.assetSource.assetRevision, 'user-reference-wedge-20261016');
  report.model = (await read(page)).model;
  desktopCamera = (await read(page)).camera;
  assertCamera(await read(page));
  for (const [dimension, expected] of [['length', 4.7], ['width', 2.1], ['height', 1.2]]) {
    assert.ok(Math.abs(report.model[dimension] - expected) < 0.02, `${dimension} must match the shared vehicle dimensions`);
  }
  await assertControlLayout(page, 'drive');
  await screenshot(page, '01-auto-start-desktop');
  checked('model readiness starts driving directly with bottom-centered WASD around the car and no instruction overlay');

  await page.keyboard.press('Escape');
  assert.equal((await read(page)).mode, 'paused');
  await page.locator('[data-difficulty="practice"]').click();
  assert.equal((await read(page)).difficulty, 'practice');
  assert.ok((await read(page)).limits.tilt > 32);
  assert.equal((await read(page)).mode, 'paused');
  assert.equal((await read(page)).elapsed, 0);
  await page.locator('[data-difficulty="normal"]').click();
  assert.equal((await read(page)).difficulty, 'normal');
  assert.equal((await read(page)).limits.tilt, 32);
  assert.equal((await read(page)).mode, 'paused');
  assert.equal((await read(page)).phase, 'ground');
  await screenshot(page, '02-pause-desktop');
  await page.locator('#resume-btn').click();
  assert.equal((await read(page)).mode, 'running');
  checked('pause-menu difficulty selection resets the car and keeps play paused until resume');

  await page.keyboard.down('KeyW');
  await advance(page, 1000);
  await page.keyboard.up('KeyW');
  assert.ok((await read(page)).speedKmh > 30);
  await screenshot(page, '03-ground-desktop');
  checked('actual W keyboard accelerates on ground');

  await page.keyboard.press('Escape');
  const paused = await read(page);
  assert.equal(paused.mode, 'paused');
  await advance(page, 2000);
  assertFrozen(paused, await read(page));
  await page.locator('#resume-btn').click();
  assert.equal((await read(page)).mode, 'running');
  await page.keyboard.press('Escape');
  await page.locator('#pause-restart-btn').click();
  assert.equal((await read(page)).mode, 'running');
  assert.equal((await read(page)).elapsed, 0);
  assert.equal((await read(page)).phase, 'ground');
  assert.deepEqual((await read(page)).heldKeys, []);
  checked('pause freezes position, elapsed time and fuel; resume and pause-menu restart work');

  await page.keyboard.press('KeyV');
  assertCamera(await read(page));
  assert.equal(await page.locator('#camera-btn').count(), 0);
  await page.keyboard.press('KeyR');
  let state = await read(page);
  assert.equal(state.phase, 'ground');
  assert.equal(state.elapsed, 0);
  assert.equal(state.fuel, 100);
  assert.deepEqual(state.heldKeys, []);
  assert.deepEqual(state.activeJets, []);
  checked('opening and climb stay wide without a V toggle; R restores the wide approach');

  for (const [key, sign] of [['a', 1], ['d', -1]]) {
    await page.keyboard.down('KeyW');
    await page.keyboard.down(`Key${key.toUpperCase()}`);
    await advance(page, 1000);
    assert.equal(Math.sign((await read(page)).player.position.x), sign);
    await releaseAll(page);
    await page.keyboard.press('KeyR');
  }
  checked('actual A and D keyboard steering preserves the established driving convention');

  await page.keyboard.down('KeyW');
  for (let frame = 0; frame < 80; frame += 1) {
    state = await advanceRead(page, 50);
    if (state.phase === 'climb' && state.trackAngle > 0.6) break;
  }
  assert.equal(state.phase, 'climb');
  await page.keyboard.up('KeyW');
  state = await advanceRead(page, 4000);
  assert.equal(state.phase, 'climb');
  const coastingStop = state;
  state = await advanceRead(page, 3000);
  assert.deepEqual(state.player.position, coastingStop.player.position);
  assert.equal(state.trackAngle, coastingStop.trackAngle);
  assert.equal(state.fuel, 100);
  await page.keyboard.down('KeyW');
  await advance(page, 250);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyS');
  state = await advanceRead(page, 1000);
  assert.equal(state.phase, 'climb');
  assert.ok(Math.hypot(...Object.values(state.player.velocity)) < 1e-9);
  await releaseAll(page);
  await page.keyboard.press('KeyR');
  checked('releasing W coasts to a stop on the arc; S brakes; attachment never drives or releases by timer');

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await advance(page, 500);
  await page.keyboard.up('KeyA');
  const heading = (await read(page)).player.yaw;
  for (let frame = 0; frame < 60; frame += 1) {
    state = await advanceRead(page, 50);
    if (state.phase === 'climb') break;
  }
  assert.equal(state.phase, 'climb');
  assert.ok(state.player.position.x > 0.2);
  assert.ok(Math.abs(state.player.yaw - heading) < 1e-12, 'entry must preserve the player heading within floating-point precision');
  await releaseAll(page);
  await page.keyboard.press('KeyR');
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await advance(page, 1000);
  await page.keyboard.up('KeyA');
  state = await advanceRead(page, 1800);
  assert.equal(state.phase, 'ground');
  assert.ok(state.player.position.x > 4);
  assert.ok(state.player.position.z > 35);
  await releaseAll(page);
  await page.keyboard.press('KeyR');
  checked('steered entry preserves player x and heading; missing the arc receives no auto-alignment');

  state = await driveToAir(page, true);
  checked('air controls show nine keys around the top-view car with centered S and no handoff banner');
  assert.ok(state.heldKeys.includes('w'));
  assert.ok(state.suppressedKeys.includes('w'));
  await advance(page, 100);
  state = await read(page);
  assert.deepEqual(state.activeJets, []);
  assert.equal(state.fuel, 100);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyW');
  await advance(page);
  assert.deepEqual((await read(page)).activeJets, ['w']);
  await page.keyboard.up('KeyW');
  checked('driving W is suppressed at takeoff until release and re-press');

  for (const key of jetKeys) {
    await page.keyboard.down(`Key${key.toUpperCase()}`);
    await advance(page);
    state = await read(page);
    assert.deepEqual(state.activeJets, [key], `independent keyboard jet ${key}`);
    assert.equal(await page.locator(`#jet-${key}`).getAttribute('aria-pressed'), 'true');
    await page.keyboard.up(`Key${key.toUpperCase()}`);
  }
  for (const key of jetKeys) await page.keyboard.down(`Key${key.toUpperCase()}`);
  await advance(page, 50);
  assert.equal((await read(page)).activeJets.length, 9);
  await screenshot(page, '08-air-nine-jets');
  await releaseAll(page);
  checked('all nine keyboard jets and simultaneous combination activate visible controls');

  await page.keyboard.down('KeyS');
  await advance(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const blurred = await read(page);
  assert.equal(blurred.mode, 'paused');
  assert.deepEqual(blurred.heldKeys, []);
  await advance(page, 3000);
  assertFrozen(blurred, await read(page));
  await page.keyboard.up('KeyS');
  await page.locator('#resume-btn').click();
  await advance(page);
  assert.deepEqual((await read(page)).activeJets, []);
  checked('blur during firing clears held keys, pauses and resumes without stuck thrust');

  await page.keyboard.press('KeyR');
  await driveToAir(page);
  await page.keyboard.up('KeyW');
  state = await flyWithKeyboard(page);
  assert.equal(state.phase, 'landed', JSON.stringify(state.result));
  assert.equal(state.result.success, true);
  assert.equal(state.mode, 'result');
  assert.ok(state.best.normal >= state.result.score);
  report.results.success = state;
  await screenshot(page, '12-success-desktop');
  checked('full real-key drive, body-axis side-roll and safe landing preserve outward nose direction; personal best saved');

  await page.keyboard.press('KeyR');
  state = await read(page);
  assert.equal(state.phase, 'ground');
  assert.equal(state.mode, 'running');
  assert.equal(state.elapsed, 0);
  assert.deepEqual(state.activeJets, []);
  assert.deepEqual(state.heldKeys, []);
  await driveToAir(page);
  await page.keyboard.up('KeyW');
  for (let frame = 0; frame < 250; frame++) {
    state = await advanceRead(page, 100); assertCamera(state);
    if (state.phase === 'contact') {
      const geometry = await page.evaluate(() => window.inspect_vehicle_geometry());
      assert.ok(geometry.minimumY >= -0.035, `inverted GLB must remain above the floor: ${geometry.minimumY}`);
    }
    if (state.mode === 'result') break;
  }
  state = await read(page);
  assert.equal(state.phase, 'crashed');
  assert.equal(state.result.success, false);
  assert.equal(state.result.score, 0, 'an overturned car earns zero');
  assert.equal(state.mode, 'result');
  report.results.failure = state;
  await screenshot(page, '13-failure-desktop');
  checked('an uncorrected inverted impact collides and settles above ground before the zero-score overturn result');
  await page.locator('#retry-btn').click();
  assert.equal((await read(page)).mode, 'running');
  assert.equal((await read(page)).phase, 'ground');
  assert.equal((await read(page)).elapsed, 0);
  assert.deepEqual((await read(page)).heldKeys, []);
  checked('result retry button starts a fresh run without an intro');

  const imperfectContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  contexts.push(imperfectContext);
  const imperfectPage = await imperfectContext.newPage(); watch(imperfectPage, 'imperfect');
  await open(imperfectPage); await driveToAir(imperfectPage); await imperfectPage.keyboard.up('KeyW');
  await imperfectLanding(imperfectPage);
  checked('a real-key 20-degree landing bounces from partial wheel contact onto four wheels, rolls forward and saves a positive score');

  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  contexts.push(phoneContext);
  const phone = await phoneContext.newPage();
  watch(phone, 'phone');
  await open(phone);
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await assertControlLayout(phone, 'drive');
  await screenshot(phone, '14-auto-start-phone-390x844');
  await phone.locator('#pause-btn').tap();
  assert.equal((await read(phone)).mode, 'paused');
  await phone.locator('#resume-btn').tap();
  assert.equal((await read(phone)).mode, 'running');
  await driveToAir(phone);
  await phone.keyboard.up('KeyW');
  await assertControlLayout(phone, 'air');
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await screenshot(phone, '15-air-phone-390x844');
  checked('390x844 automatic start, touch pause/resume and both car-key layouts fit without instruction overlays');

  assert.deepEqual(report.errors, [], 'browser page, console and request errors');
  checked('no console errors, page exceptions or failed requests');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const context of contexts) await context.close();
  await browser.close();
  console.log(`Report: ${path.join(output, 'report.json')}`);
}
