import './style.css';
import { createState, stepPhysics, getQuaternion, JETS, WORLD, landingLimits } from './physics.js';
import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const VERSION = '0.0.3';
const FIXED_STEP = 1 / 120;
const keys = new Set();
const held = new Set();
const suppressed = new Set();
const controls = new Set(JETS.map((jet) => jet.key));
const driveLabels = { w: '加速', a: '左转', s: '制动 / 倒车', d: '右转' };
let difficulty = 'normal';
let state = createState(difficulty);
let screen = 'loading';
const cameraMode = 'wide-follow';
let world;
let accumulator = 0;
let externalClock = false;
let lastFrame = performance.now();
let resultRevealTime = 0;
let lastAssetStatus = '';
let best = {};
try { best = JSON.parse(localStorage.getItem('roadster-flight-lab-best') || '{}') || {}; } catch { best = {}; }
if (typeof best !== 'object' || Array.isArray(best)) best = {};

for (const jet of JETS) {
  const button = document.createElement('button');
  button.className = `jet-key${jet.key === 's' ? ' center' : ''}`;
  button.id = `jet-${jet.key}`;
  button.textContent = jet.key.toUpperCase();
  button.setAttribute('aria-label', `${jet.key.toUpperCase()} ${jet.label}喷口`);
  button.setAttribute('aria-pressed', 'false');
  button.title = `${jet.key.toUpperCase()} · ${jet.label}`;
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    pressKey(jet.key);
  });
  const release = () => releaseKey(jet.key);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  $('jet-grid').append(button);
}

function pressKey(key) {
  if (screen !== 'running' || ['contact', 'landed', 'crashed'].includes(state.phase)) return;
  held.add(key);
  if (!suppressed.has(key)) keys.add(key);
}
function releaseKey(key) { held.delete(key); keys.delete(key); suppressed.delete(key); }
function clearKeys() { held.clear(); keys.clear(); suppressed.clear(); }

function setScreen(value) {
  screen = value;
  $('loading-screen').hidden = value !== 'loading';
  $('hud').hidden = value === 'loading';
  $('pause-screen').hidden = value !== 'paused';
  $('result-screen').hidden = value !== 'result';
  document.body.classList.toggle('playing', value !== 'loading');
  if (value !== 'running') clearKeys();
  accumulator = 0;
  updateHud();
}

function start() {
  if (world?.assetState.status !== 'ready') return;
  state = createState(difficulty);
  clearKeys();
  resultRevealTime = 0;
  setScreen('running');
  document.activeElement?.blur();
  audio.resume();
}

function pause() {
  if (screen === 'running') {
    setScreen('paused');
    $('resume-btn').focus({ preventScroll: true });
  } else if (screen === 'paused') {
    setScreen('running');
    document.activeElement?.blur();
  }
}

function finish() {
  if (!state.result) return;
  const result = state.result;
  $('result-title').textContent = result.title || (result.success ? '安全着陆' : '着陆完成');
  $('score').textContent = result.score;
  $('result-descent').textContent = `${result.verticalSpeed.toFixed(1)} m/s`;
  $('result-tilt').textContent = `${result.tilt.toFixed(1)}°`;
  $('result-fuel').textContent = `${Math.round(state.fuel)}%`;
  const previousBest = Number.isFinite(best[difficulty]) ? best[difficulty] : 0;
  const improved = result.score > previousBest;
  if (improved) {
    best[difficulty] = result.score;
    try { localStorage.setItem('roadster-flight-lab-best', JSON.stringify(best)); } catch { /* Storage is optional. */ }
  }
  $('best-score').textContent = `${difficulty === 'practice' ? '练习' : '标准'} · ${improved ? '新纪录' : '最佳'} ${best[difficulty] || '—'}`;
  setScreen('result');
  audio.finish(result.success);
  $('retry-btn').focus({ preventScroll: true });
}

function simulate(dt) {
  if (screen !== 'running') return;
  if (state.phase === 'landed' || state.phase === 'crashed') {
    resultRevealTime += dt;
    if (resultRevealTime >= 1.4) finish();
    return;
  }
  const previousPhase = state.phase;
  stepPhysics(state, keys, dt);
  if (['ground', 'climb'].includes(previousPhase) && state.phase === 'air') {
    // A key that drove the car cannot silently become a jet until it is released.
    for (const key of held) suppressed.add(key);
    keys.clear();
    audio.launch();
  }
  if (state.phase === 'contact' || state.phase === 'landed' || state.phase === 'crashed') { resultRevealTime = 0; clearKeys(); }
}

function updateHud() {
  const air = state.phase === 'air';
  const touchdown = ['contact', 'landed', 'crashed'].includes(state.phase);
  const horizontal = Math.hypot(state.vel.x, state.vel.z);
  const attitude = getQuaternion(state);
  const upY = 1 - 2 * (attitude.x ** 2 + attitude.z ** 2);
  const tilt = Math.acos(Math.max(-1, Math.min(1, upY))) * 180 / Math.PI;
  const limits = landingLimits(state);
  $('speed').textContent = Math.round((air || touchdown ? horizontal : Math.abs(state.speed)) * 3.6);
  $('altitude').textContent = (Math.max(0, state.pos.y) * 3.28084).toFixed(1);
  $('downforce').textContent = air || touchdown ? (state.gForce || 0).toFixed(1) : Math.round(state.downforce || 0);
  $('force-label').textContent = air || touchdown ? 'G-FORCE' : 'DOWNFORCE';
  $('force-unit').textContent = air || touchdown ? 'G' : 'KG';
  $('pitch-value').textContent = Math.abs(state.pitch * 180 / Math.PI).toFixed(1);
  $('vertical').textContent = Math.abs(state.vel.y).toFixed(1);
  $('vertical-label').textContent = state.vel.y >= 0 ? '↑' : '↓';
  $('vertical').classList.toggle('danger', air && state.vel.y < -limits.verticalSpeed);
  $('fuel').textContent = Math.max(0, Math.ceil(state.fuel));
  $('fuel').classList.toggle('danger', state.fuel < 20);
  $('fuel-fill').style.width = `${state.fuel}%`;
  $('fuel-fill').style.backgroundColor = state.fuel < 20 ? 'var(--danger)' : '#aebec9';
  $('tilt').textContent = `${Math.round(tilt)}°`;
  $('tilt').classList.toggle('danger', (air || touchdown) && tilt > limits.tilt);
  // Project the actual body axes, so a barrel roll never becomes a fake nose-over flip.
  const forwardY = 2 * (attitude.y * attitude.z - attitude.w * attitude.x);
  const forwardZ = 1 - 2 * (attitude.x ** 2 + attitude.y ** 2);
  const upZ = 2 * (attitude.y * attitude.z + attitude.w * attitude.x);
  $('orientation-car').style.transform = `matrix(${forwardZ},${forwardY},${upZ},${upY},0,0)`;
  $('distance').textContent = `${Math.round(Math.hypot(state.pos.x, WORLD.padZ - state.pos.z))} m`;
  $('jet-panel').dataset.mode = air || touchdown ? 'air' : 'drive';
  for (const jet of JETS) {
    const button = $(`jet-${jet.key}`);
    button.hidden = !air && !touchdown && !['w', 'a', 's', 'd'].includes(jet.key);
    const label = `${jet.key.toUpperCase()} · ${air || touchdown ? `${jet.label}喷口` : driveLabels[jet.key] || jet.label}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    const active = air ? state.activeJets.includes(jet.key) : keys.has(jet.key) && ['w', 'a', 's', 'd'].includes(jet.key);
    button.classList.toggle('active', active);
    button.classList.toggle('disabled', touchdown || (!air && !['w', 'a', 's', 'd'].includes(jet.key)));
    button.setAttribute('aria-pressed', String(active));
  }
  $('jet-panel').classList.toggle('touchdown', touchdown);
}

function updateAssetStatus() {
  if (!world) return;
  const status = world.assetState.status;
  if (status === lastAssetStatus) return;
  lastAssetStatus = status;
  if (status === 'ready' && screen === 'loading') {
    start();
    if (document.hidden) pause();
  } else if (status === 'error') {
    fail(new Error(world.assetState.error || '车辆载入失败'));
  }
}

function fail(error) {
  console.error(error);
  screen = 'error';
  $('error-screen').hidden = false;
  $('error-message').textContent = `请使用支持 WebGL 2 的浏览器并开启硬件加速。${error?.message || String(error)}`;
  clearKeys();
}

const audio = {
  context: null, enabled: false, engine: null, engineGain: null, jetGain: null,
  init() {
    if (this.context) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    this.context = new Context();
    const master = this.context.createGain();
    master.gain.value = 0.18;
    master.connect(this.context.destination);
    this.engine = this.context.createOscillator();
    this.engine.type = 'triangle';
    this.engineGain = this.context.createGain();
    this.engineGain.gain.value = 0;
    this.engine.connect(this.engineGain).connect(master);
    this.engine.start();
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 2, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = this.context.createBufferSource();
    noise.buffer = buffer; noise.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 950;
    this.jetGain = this.context.createGain(); this.jetGain.gain.value = 0;
    noise.connect(filter).connect(this.jetGain).connect(master); noise.start();
  },
  resume() { if (this.enabled) this.context?.resume().catch(() => {}); },
  toggle() {
    this.init();
    if (!this.context) return;
    this.enabled = !this.enabled;
    $('sound-btn').textContent = `声音 ${this.enabled ? '开' : '关'}`;
    $('sound-btn').setAttribute('aria-label', this.enabled ? '关闭声音' : '开启声音');
    this.resume();
  },
  update() {
    if (!this.context) return;
    const active = this.enabled && screen === 'running';
    const now = this.context.currentTime;
    this.engine.frequency.setTargetAtTime(60 + Math.abs(state.speed) * 6, now, 0.12);
    this.engineGain.gain.setTargetAtTime(active && ['ground', 'climb'].includes(state.phase) ? 0.04 + Math.abs(state.speed) * 0.004 : 0, now, 0.1);
    this.jetGain.gain.setTargetAtTime(active ? Math.min(0.65, state.activeJets.length * 0.1) : 0, now, 0.06);
  },
  tone(frequency, duration, volume = 0.04) {
    if (!this.enabled || !this.context) return;
    const tone = this.context.createOscillator(); const gain = this.context.createGain();
    tone.frequency.value = frequency; gain.gain.value = volume;
    tone.connect(gain).connect(this.context.destination);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);
    tone.start(); tone.stop(this.context.currentTime + duration);
    tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  },
  launch() { this.tone(520, 0.25); },
  finish(success) { this.tone(success ? 780 : 150, 0.6); },
};

function frame(timestamp) {
  const delta = Math.max(0, Math.min((timestamp - lastFrame) / 1000, 0.1));
  lastFrame = timestamp;
  try {
    if (!externalClock && screen === 'running') {
      accumulator += delta;
      while (accumulator >= FIXED_STEP) { simulate(FIXED_STEP); accumulator -= FIXED_STEP; }
    }
    updateHud(); updateAssetStatus(); audio.update();
    world?.render(state, delta, { menu: false, paused: screen !== 'running', cameraMode });
  } catch (error) { fail(error); return; }
  requestAnimationFrame(frame);
}

window.render_game_to_text = () => JSON.stringify({
  version: VERSION, mode: screen, phase: state.phase, difficulty,
  coordinates: '+x initial driver left, +y up, +z approach direction; meters; orientation quaternion [x,y,z,w] is authoritative',
  player: { position: { ...state.pos }, velocity: { ...state.vel }, pitch: state.pitch, roll: state.roll, yaw: state.yaw, orientation: getQuaternion(state).toArray() },
  altitude: state.pos.y, speedKmh: Math.hypot(state.vel.x, state.vel.z) * 3.6,
  fuel: state.fuel, elapsed: state.elapsed, flightTime: state.flightTime, activeJets: [...state.activeJets],
  heldKeys: [...held], suppressedKeys: [...suppressed], limits: landingLimits(state),
  angular: { ...state.angular }, target: { x: 0, z: WORLD.padZ, halfWidth: WORLD.padHalfWidth, halfLength: WORLD.padHalfLength },
  model: world?.assetState || null, result: state.result, cameraMode, shot: world?.scene.userData.shot,
  camera: world?.scene.userData.camera, contact: state.contact || null, impact: state.impact || null,
  trackAngle: state.trackAngle, downforce: state.downforce, gForce: state.gForce, best,
});

window.inspect_vehicle_geometry = () => world?.measureVehicle() || null;

window.advanceTime = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return;
  externalClock = true;
  const count = Math.round(Math.min(ms, 60000) / (1000 * FIXED_STEP));
  for (let index = 0; index < count; index += 1) simulate(FIXED_STEP);
  updateHud(); updateAssetStatus();
  world?.render(state, Math.min(ms / 1000, 0.1), { menu: false, paused: screen !== 'running', cameraMode });
};

window.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code.toLowerCase();
  if (controls.has(key)) { event.preventDefault(); pressKey(key); }
  if (event.repeat) return;
  if (key === 'escape') { event.preventDefault(); pause(); }
  if (key === 'r' && screen !== 'loading') { event.preventDefault(); start(); }
  if (key === 'f') { event.preventDefault(); fullscreen(); }
});
window.addEventListener('keyup', (event) => { if (event.code.startsWith('Key')) releaseKey(event.code.slice(3).toLowerCase()); });
window.addEventListener('blur', () => { clearKeys(); if (screen === 'running') pause(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearKeys(); if (screen === 'running') pause(); } });
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const modal = [...document.querySelectorAll('.modal-backdrop')].reverse().find((item) => !item.hidden);
  if (!modal) return;
  const focusable = [...modal.querySelectorAll('button:not(:disabled), a[href], summary')];
  const first = focusable[0]; const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});

async function fullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { $('fullscreen-btn').title = '浏览器未允许全屏，可使用 F11'; }
}

$('retry-btn').addEventListener('click', start);
$('restart-btn').addEventListener('click', start);
$('pause-btn').addEventListener('click', pause);
$('resume-btn').addEventListener('click', pause);
$('pause-restart-btn').addEventListener('click', start);
$('sound-btn').addEventListener('click', () => audio.toggle());
$('fullscreen-btn').addEventListener('click', fullscreen);
$('reload-btn').addEventListener('click', () => location.reload());
for (const button of document.querySelectorAll('[data-difficulty]')) {
  button.addEventListener('click', () => {
    if (screen !== 'paused') return;
    difficulty = button.dataset.difficulty;
    state = createState(difficulty);
    clearKeys();
    resultRevealTime = 0;
    for (const option of document.querySelectorAll('[data-difficulty]')) {
      option.classList.toggle('selected', option === button);
      option.setAttribute('aria-pressed', String(option === button));
    }
    updateHud();
  });
}

try {
  world = createScene($('world'));
  window.addEventListener('resize', () => world.resize());
  $('world').addEventListener('webglcontextlost', (event) => { event.preventDefault(); if (screen === 'running') pause(); fail(new Error('图形上下文已丢失，请重新载入。')); });
  setScreen('loading');
  requestAnimationFrame(frame);
} catch (error) { fail(error); }
