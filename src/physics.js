import { Euler, Quaternion, Vector3 } from 'three';
import { CONTACT_BODY, groundSupport, beginGroundContact, stepGroundContact } from './ground-contact.js';
export { groundSupport } from './ground-contact.js';

export const WORLD = Object.freeze({
  rampStart: 35,
  rampRadius: 11,
  rampThetaEnd: 170 * Math.PI / 180,
  rampHeight: 11 * (1 - Math.cos(170 * Math.PI / 180)),
  rampHalfWidth: 4,
  trackMaxSpeed: 16,
  releaseImpulse: 2.5,
  attachmentDownforce: 4700,
  padZ: -12,
  padHalfWidth: 10,
  padHalfLength: 25,
  vehicleLength: CONTACT_BODY.length,
  vehicleWidth: CONTACT_BODY.width,
  vehicleHeight: CONTACT_BODY.height,
  gravity: 9.81,
  safeVerticalSpeed: 6,
  safeHorizontalSpeed: 15,
  safeTilt: 32,
});

// z is forward. With the chase camera behind -z, +x is the driver's left.
// Each outer jet produces its own turning moment; positive roll lowers the left side.
export const JETS = Object.freeze([
  { key: 'q', x: 0.95, z: 1.6, power: 5.8, label: '左前' },
  { key: 'w', x: 0, z: 1.6, power: 5.8, label: '前部' },
  { key: 'e', x: -0.95, z: 1.6, power: 5.8, label: '右前' },
  { key: 'a', x: 0.95, z: 0, power: 5.8, label: '左侧' },
  { key: 's', x: 0, z: 0, power: 24, label: '主升力' },
  { key: 'd', x: -0.95, z: 0, power: 5.8, label: '右侧' },
  { key: 'z', x: 0.95, z: -1.6, power: 5.8, label: '左后' },
  { key: 'x', x: 0, z: -1.6, power: 5.8, label: '后部' },
  { key: 'c', x: -0.95, z: -1.6, power: 5.8, label: '右后' },
].map(Object.freeze));

const EMPTY_KEYS = new Set();
export const FUEL_CONSUMPTION_MULTIPLIER = 3;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const wrapAngle = (value) => Math.atan2(Math.sin(value), Math.cos(value));

function vehicleFootprint(yaw) {
  return {
    halfWidth: Math.abs(Math.cos(yaw)) * WORLD.vehicleWidth / 2 + Math.abs(Math.sin(yaw)) * WORLD.vehicleLength / 2,
    halfLength: Math.abs(Math.cos(yaw)) * WORLD.vehicleLength / 2 + Math.abs(Math.sin(yaw)) * WORLD.vehicleWidth / 2,
  };
}

function writeOrientation(state, quaternion) {
  quaternion.normalize();
  state.orientation = { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w };
}

function syncAirTelemetry(state) {
  const quaternion = getQuaternion(state);
  const forward = new Vector3(0, 0, 1).applyQuaternion(quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);
  const left = new Vector3(1, 0, 0).applyQuaternion(quaternion);
  state.pitch = Math.asin(clamp(forward.y, -1, 1));
  if (Math.hypot(forward.x, forward.z) > 1e-7) {
    state.yaw = Math.atan2(forward.x, forward.z);
    state.roll = Math.atan2(-left.y, up.y);
  }
}

/** Shared curved contact surface; angle is in radians, not a world-z height lookup. */
export function trackPoint(angle) {
  const theta = clamp(Number.isFinite(angle) ? angle : 0, 0, WORLD.rampThetaEnd);
  return {
    z: WORLD.rampStart + WORLD.rampRadius * Math.sin(theta),
    y: WORLD.rampRadius * (1 - Math.cos(theta)),
    pitch: theta,
  };
}

export function createState(difficulty = 'normal') {
  return {
    phase: 'ground',
    pos: { x: 0, y: 0, z: 20 },
    vel: { x: 0, y: 0, z: 0 },
    pitch: 0,
    roll: 0,
    yaw: 0,
    angular: { pitch: 0, roll: 0, yaw: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    speed: 0,
    fuel: 100,
    elapsed: 0,
    flightTime: 0,
    activeJets: [],
    result: null,
    impact: null,
    contact: null,
    difficulty: difficulty === 'practice' ? 'practice' : 'normal',
    launches: 0,
    maxAltitude: 0,
    fuelUsed: 0,
    trackAngle: 0,
    stageTime: 0,
    downforce: 0,
    gForce: 1,
  };
}

export function getQuaternion(state) {
  const { x, y, z, w } = state.orientation;
  return new Quaternion(x, y, z, w);
}

export function landingLimits(state) {
  return state.difficulty === 'practice'
    ? { verticalSpeed: 8, horizontalSpeed: 18, tilt: 42 }
    : { verticalSpeed: WORLD.safeVerticalSpeed, horizontalSpeed: WORLD.safeHorizontalSpeed, tilt: WORLD.safeTilt };
}

/** First-impact quality only; final wheel support decides success/rollover later. */
export function evaluateLanding(state) {
  const verticalSpeed = Math.abs(state.vel.y);
  const horizontalSpeed = Math.hypot(state.vel.x, state.vel.z);
  const up = new Vector3(0, 1, 0).applyQuaternion(getQuaternion(state));
  const tilt = Math.acos(clamp(up.y, -1, 1)) * 180 / Math.PI;
  const envelope = groundSupport(state);
  const overlapX = Math.max(0, Math.min(WORLD.padHalfWidth, envelope.maximumX) - Math.max(-WORLD.padHalfWidth, envelope.minimumX));
  const overlapZ = Math.max(0, Math.min(WORLD.padZ + WORLD.padHalfLength, envelope.maximumZ) - Math.max(WORLD.padZ - WORLD.padHalfLength, envelope.minimumZ));
  const coverage = clamp(overlapX * overlapZ / Math.max(1e-9, (envelope.maximumX - envelope.minimumX) * (envelope.maximumZ - envelope.minimumZ)), 0, 1);
  const onPad = coverage >= 0.85;
  const limits = landingLimits(state);
  const accuracy = clamp(1 - Math.hypot(state.pos.x / WORLD.padHalfWidth, (state.pos.z - WORLD.padZ) / WORLD.padHalfLength), 0, 1);
  const success = onPad && verticalSpeed <= limits.verticalSpeed && horizontalSpeed <= limits.horizontalSpeed && tilt <= limits.tilt;
  let reason = '姿态、速度和落点均在安全范围内。';
  if (!onPad) reason = coverage > 0 ? '已获得接地分；让更多车身进入白色落地区可提高得分。' : '落点偏离平台，让车身进入白色落地区。';
  else if (tilt > limits.tilt) reason = '车身倾斜过大，点按较低一侧的喷口调平后再接地。';
  else if (verticalSpeed > limits.verticalSpeed) reason = '下降过快，提前点喷主升力或同时开启对称喷口。';
  else if (horizontalSpeed > limits.horizontalSpeed) reason = '水平速度过快，调整倾斜方向，用推力抵消水平漂移。';
  const softness = Math.exp(-((verticalSpeed / 10) ** 1.3));
  const level = 0.18 + 0.82 * Math.max(0, up.y);
  const drift = Math.exp(-((horizontalSpeed / 27) ** 2));
  const location = (0.4 + 0.6 * accuracy) * (0.35 + 0.65 * coverage);
  const score = Math.max(1, Math.round(1000 * location * softness * level * drift));
  return { success, title: success ? '安全着陆' : '完成着陆', reason, score, verticalSpeed, horizontalSpeed, tilt, accuracy, coverage };
}

function recordContact(state) {
  state.impact = Object.freeze({
    ...evaluateLanding(state),
    position: Object.freeze({ ...state.pos }),
    orientation: Object.freeze({ ...state.orientation }),
    angular: Object.freeze({ ...state.angular }),
  });
  state.phase = 'contact';
  state.stageTime = 0;
  state.contact = { elapsed: 0, stableTime: 0, rolloutTime: 0, impacts: 0, bounces: 0, grounded: false, normalImpulse: 0, wheels: [], forwardSpeed: 0 };
  state.activeJets = [];
  state.gForce = 0;
  beginGroundContact(state, WORLD.gravity);
}

function updateContactImpulse(state, dt) {
  const wasGrounded = state.contact.grounded;
  const collision = stepGroundContact(state, dt, WORLD.gravity);
  Object.assign(state.contact, { grounded: collision.grounded, normalImpulse: collision.normalImpulse, wheels: collision.wheels, forwardSpeed: collision.forwardSpeed });
  state.gForce = collision.normalImpulse / (dt * WORLD.gravity);
  if (collision.grounded && !wasGrounded && (collision.impactSpeed > 0.5 || collision.normalImpulse > 0.2)) {
    state.contact.impacts += 1;
    if (state.vel.y > 0.2) state.contact.bounces += 1;
  }
  syncAirTelemetry(state);
  state.speed = Math.hypot(state.vel.x, state.vel.z);
}

function updateContact(state, dt) {
  state.stageTime += dt;
  state.contact.elapsed += dt;
  state.activeJets = [];
  updateContactImpulse(state, dt);
  const restingUp = new Vector3(0, 1, 0).applyQuaternion(getQuaternion(state)).y;
  const onWheels = state.contact.wheels.length >= 3 && restingUp > 0.75;
  const quiet = state.contact.grounded && Math.abs(state.vel.y) < 0.22
    && Math.hypot(state.angular.pitch, state.angular.roll, state.angular.yaw) < 0.22
    && (onWheels || Math.hypot(state.vel.x, state.vel.z) < 0.18);
  state.contact.stableTime = quiet ? state.contact.stableTime + dt : 0;
  if (onWheels && quiet) state.contact.rolloutTime += dt;
  if (Math.abs(state.pos.x) > 150 || state.pos.z > 250 || state.pos.z < -150 || state.pos.y > 160) {
    failOutOfBounds(state);
    return;
  }
  if (state.contact.stableTime < 0.65) return;
  if (onWheels && state.contact.rolloutTime < 1.2) return;
  if (Math.hypot(state.vel.x, state.vel.z) > 0.25) return;
  // Finish only after stable vertical/rotational support and a visible wheel
  // rollout. Retain the solver's pose and first-impact quality; a rollover is 0.
  const success = onWheels;
  state.result = { ...state.impact, success };
  if (!success) {
    state.result.score = 0;
    state.result.title = '翻车';
    state.result.reason = '车辆最终翻倒；接地前用侧边喷口调平并减少转动。';
  }
  state.phase = success ? 'landed' : 'crashed';
  state.vel = { x: 0, y: 0, z: 0 };
  state.speed = 0;
  state.angular = { pitch: 0, roll: 0, yaw: 0 };
  state.gForce = 1;
}

function launch(state, fromTop) {
  state.phase = 'air';
  // Preserve the complete attitude at release. Telemetry changes representation, never pose.
  syncAirTelemetry(state);
  state.launches += 1;
  state.stageTime = 0;
  state.downforce = 0;
  state.gForce = 0;
  // The release preserves actual tangent velocity; only the lip adds a small game impulse.
  if (fromTop) state.vel.y += WORLD.releaseImpulse;
  state.speed = Math.hypot(state.vel.x, state.vel.z);
  state.angular.pitch = 0;
  state.angular.roll = 0;
}

function updateTrack(state, keys, dt) {
  state.stageTime += dt;
  state.activeJets = [];
  state.downforce = WORLD.attachmentDownforce;
  state.roll = 0;
  state.angular.pitch = 0;
  state.angular.roll = 0;
  if (keys.has('s')) state.speed = Math.max(0, state.speed - 18 * dt);
  else if (keys.has('w')) state.speed += (11 - WORLD.gravity * Math.sin(state.trackAngle) * Math.cos(state.yaw)) * dt;
  else state.speed = Math.max(0, state.speed - (2.5 + WORLD.gravity * Math.abs(Math.sin(state.trackAngle))) * dt);
  state.speed = clamp(state.speed, 0, WORLD.trackMaxSpeed);
  const steering = Number(keys.has('a')) - Number(keys.has('d'));
  state.yaw = wrapAngle(state.yaw + steering * 0.72 * Math.min(state.speed / 12, 1) * dt);
  const tangentSpeed = state.speed * Math.cos(state.yaw);
  state.pos.x += state.speed * Math.sin(state.yaw) * dt;
  const nextAngle = state.trackAngle + tangentSpeed * dt / WORLD.rampRadius;
  state.trackAngle = clamp(nextAngle, 0, WORLD.rampThetaEnd);
  const point = trackPoint(state.trackAngle);
  state.pos.y = point.y;
  state.pos.z = point.z;
  state.pitch = point.pitch;
  // Steering follows the curved surface's normal; adhesion never corrects the player's yaw.
  writeOrientation(state, new Quaternion().setFromEuler(new Euler(-state.pitch, state.yaw, 0, 'XYZ')));
  state.vel = { x: state.speed * Math.sin(state.yaw), y: tangentSpeed * Math.sin(state.trackAngle), z: tangentSpeed * Math.cos(state.trackAngle) };
  state.gForce = 1 + tangentSpeed * tangentSpeed / (WORLD.rampRadius * WORLD.gravity);
  state.maxAltitude = Math.max(state.maxAltitude, state.pos.y);
  if (Math.abs(state.pos.x) + vehicleFootprint(state.yaw).halfWidth > WORLD.rampHalfWidth) launch(state, false);
  else if (nextAngle >= WORLD.rampThetaEnd) launch(state, true);
  else if (nextAngle < 0) {
    state.phase = 'ground';
    state.stageTime = 0;
    state.downforce = 0;
    state.gForce = 1;
    state.pos.z = WORLD.rampStart + WORLD.rampRadius * nextAngle;
    state.vel.y = 0;
  }
}

function updateGround(state, keys, dt) {
  const previousZ = state.pos.z;
  state.stageTime += dt;
  const forward = keys.has('w');
  const brake = keys.has('s');
  let acceleration = forward ? 11 : 0;
  if (brake) acceleration -= state.speed > 0 ? 18 : 7;
  state.speed += acceleration * dt;
  if (!forward && !brake) state.speed *= Math.exp(-0.42 * dt);
  if (Math.abs(state.speed) < 0.02) state.speed = 0;
  state.speed = clamp(state.speed, -9, 30);
  const steering = Number(keys.has('a')) - Number(keys.has('d'));
  state.yaw = wrapAngle(state.yaw + steering * 0.72 * Math.min(Math.abs(state.speed) / 12, 1) * Math.sign(state.speed) * dt);
  state.vel.x = Math.sin(state.yaw) * state.speed;
  state.vel.z = Math.cos(state.yaw) * state.speed;
  state.vel.y = 0;
  state.pos.x += state.vel.x * dt;
  state.pos.z += state.vel.z * dt;
  if (previousZ < WORLD.rampStart && state.pos.z >= WORLD.rampStart && state.vel.z > 0
    && Math.abs(state.pos.x) + vehicleFootprint(state.yaw).halfWidth <= WORLD.rampHalfWidth) {
    state.phase = 'climb';
    state.stageTime = 0;
    state.trackAngle = 0;
    state.pos.y = 0;
    state.pos.z = WORLD.rampStart;
    updateTrack(state, keys, 0);
    return;
  }
  state.pos.y = 0;
  state.pitch = 0;
  state.roll = 0;
  writeOrientation(state, new Quaternion().setFromEuler(new Euler(0, state.yaw, 0, 'YXZ')));
  state.activeJets = [];
  if (Math.abs(state.pos.x) > 150 || state.pos.z > 230 || state.pos.z < -150) {
    failOutOfBounds(state);
  }
}

function updateAir(state, keys, dt) {
  state.flightTime += dt;
  state.stageTime += dt;
  const requested = state.fuel > 0 ? JETS.filter((jet) => keys.has(jet.key)) : [];
  const consumption = requested.reduce((sum, jet) => sum + jet.power * 0.37, 0)
    * (state.difficulty === 'practice' ? 0.65 : 1) * FUEL_CONSUMPTION_MULTIPLIER;
  const fuelNeeded = consumption * dt;
  const thrustRatio = fuelNeeded > 0 ? Math.min(1, state.fuel / fuelNeeded) : 0;
  const spent = Math.min(state.fuel, fuelNeeded);
  state.fuel = Math.max(0, state.fuel - spent);
  state.fuelUsed += spent;
  state.activeJets = thrustRatio > 0 ? requested.map((jet) => jet.key) : [];
  let lift = 0;
  let pitchTorque = 0;
  let rollTorque = 0;
  for (const jet of requested) {
    const force = jet.power * thrustRatio;
    lift += force;
    pitchTorque += force * jet.z * 0.35;
    rollTorque -= force * jet.x * 1.8;
  }
  state.angular.pitch = (state.angular.pitch + pitchTorque * dt) * Math.exp(-1.6 * dt);
  state.angular.roll = (state.angular.roll + rollTorque * dt) * Math.exp(-1.6 * dt);
  const rotation = new Vector3(-state.angular.pitch, state.angular.yaw ?? 0, -state.angular.roll);
  const angularSpeed = rotation.length();
  const orientation = getQuaternion(state);
  if (angularSpeed > 1e-12) {
    rotation.multiplyScalar(1 / angularSpeed);
    // Post-multiplication integrates body-local torque, including after a 180° roll.
    orientation.multiply(new Quaternion().setFromAxisAngle(rotation, angularSpeed * dt));
  }
  writeOrientation(state, orientation);
  syncAirTelemetry(state);
  const up = new Vector3(0, 1, 0).applyQuaternion(orientation);
  const upX = up.x;
  const upY = up.y;
  const upZ = up.z;
  state.vel.x = (state.vel.x + upX * lift * dt) * Math.exp(-0.36 * dt);
  state.vel.z = (state.vel.z + upZ * lift * dt) * Math.exp(-0.36 * dt);
  state.vel.y += (upY * lift - WORLD.gravity) * dt;
  state.pos.x += state.vel.x * dt;
  state.pos.y += state.vel.y * dt;
  state.pos.z += state.vel.z * dt;
  state.maxAltitude = Math.max(state.maxAltitude, state.pos.y);
  state.speed = Math.hypot(state.vel.x, state.vel.z);
  state.gForce = lift / WORLD.gravity;
  // Adhesion constrains only track contact; after release, free flight collides with ground.
  if (groundSupport(state).minimumY <= 0) recordContact(state);
  else if (Math.abs(state.pos.x) > 150 || state.pos.z > 250 || state.pos.z < -150 || state.pos.y > 160 || state.flightTime > 45) failOutOfBounds(state);
}

function failOutOfBounds(state) {
  state.phase = 'crashed';
  state.activeJets = [];
  state.result = {
    success: false, title: '飞离测试区', reason: '车辆离开测试范围，重试后沿中线驶向弧形轨道。',
    score: 0, verticalSpeed: Math.abs(state.vel.y), horizontalSpeed: Math.hypot(state.vel.x, state.vel.z),
    tilt: 0, accuracy: 0,
  };
}

function isFiniteState(state) {
  return [state.pos.x, state.pos.y, state.pos.z, state.vel.x, state.vel.y, state.vel.z,
    state.pitch, state.roll, state.yaw, state.angular.pitch, state.angular.roll, state.angular.yaw ?? 0, state.speed, state.fuel,
    state.trackAngle, state.stageTime, state.downforce, state.gForce,
    state.orientation?.x, state.orientation?.y, state.orientation?.z, state.orientation?.w]
    .every(Number.isFinite) && Math.hypot(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w) > 1e-9;
}

/** Mutable fixed-substep simulation. Invalid/nonpositive time is ignored; long frames are bounded. */
export function stepPhysics(state, keys, dt) {
  if (!Number.isFinite(dt) || dt <= 0 || state.phase === 'landed' || state.phase === 'crashed') return state;
  if (!isFiniteState(state)) {
    state.phase = 'crashed';
    state.activeJets = [];
    state.result = { success: false, title: '测试已中止', reason: '车辆状态无效，请重试。', score: 0, verticalSpeed: 0, horizontalSpeed: 0, tilt: 0, accuracy: 0 };
    return state;
  }
  const duration = Math.min(dt, 0.1);
  const substeps = Math.ceil(duration / (1 / 120));
  const step = duration / substeps;
  const input = keys instanceof Set ? keys : EMPTY_KEYS;
  state.fuel = clamp(state.fuel, 0, 100);
  for (let index = 0; index < substeps; index += 1) {
    if (!['ground', 'climb', 'air', 'contact'].includes(state.phase)) break;
    state.elapsed += step;
    if (state.phase === 'ground') updateGround(state, input, step);
    else if (state.phase === 'climb') updateTrack(state, input, step);
    else if (state.phase === 'air') updateAir(state, input, step);
    else updateContact(state, step);
  }
  return state;
}
