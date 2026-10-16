import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion, Vector3 } from 'three';
import { createState, stepPhysics, evaluateLanding, getQuaternion, groundSupport, FUEL_CONSUMPTION_MULTIPLIER, JETS, WORLD, trackPoint } from '../src/physics.js';

const DT = 1 / 120;

function airborne(overrides = {}) {
  const state = createState();
  Object.assign(state, { phase: 'air', pos: { x: 0, y: 30, z: WORLD.padZ } }, overrides);
  setAttitude(state);
  return state;
}

function setAttitude(state) {
  const quaternion = new Quaternion().setFromEuler(new Euler(-state.pitch, state.yaw, -state.roll, 'YXZ'));
  state.orientation = { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w };
}

const forwardVector = (state) => new Vector3(0, 0, 1).applyQuaternion(getQuaternion(state));

function finishContact(state, inspect = () => {}) {
  for (let frame = 0; frame < 3600 && ['air', 'contact'].includes(state.phase); frame += 1) {
    stepPhysics(state, new Set(), DT);
    inspect(state);
    assert.ok(groundSupport(state).minimumY >= -0.00301, 'rotated support geometry cannot pass through the ground');
  }
  assert.ok(['landed', 'crashed'].includes(state.phase), `contact must settle: ${JSON.stringify(state.contact)}`);
}

function dropState({ roll = 0, pitch = 0, speed = 2, forwardSpeed = 2, clearance = 0.03, x = 0, z = WORLD.padZ } = {}) {
  const state = airborne({ roll: roll * Math.PI / 180, pitch: pitch * Math.PI / 180,
    pos: { x, y: 0, z }, vel: { x: 0, y: -speed, z: forwardSpeed } });
  state.pos.y = clearance - groundSupport(state).minimumY;
  return state;
}

function driveToTrack() {
  const state = createState();
  for (let frame = 0; frame < 2400 && state.phase === 'ground'; frame += 1) {
    stepPhysics(state, new Set(['w']), DT);
  }
  assert.equal(state.phase, 'climb', 'player W reaches the curved contact surface');
  return state;
}

function driveToTakeoff() {
  const state = driveToTrack();
  for (let frame = 0; frame < 2400 && state.phase === 'climb'; frame += 1) {
    stepPhysics(state, new Set(['w']), DT);
  }
  assert.equal(state.phase, 'air', 'player must keep driving W along the curve to leave its lip');
  return state;
}

// A feedback pilot only presses actual player keys; it never overwrites vehicle state.
function feedbackKeys(state) {
  const keys = new Set();
  const rollCorrection = -12 * state.roll - 1.5 * state.angular.roll;
  if (rollCorrection < -0.04) keys.add('a');
  else if (rollCorrection > 0.04) keys.add('d');
  // First roll around the existing nose direction. Front/rear jets only trim once upright.
  if (Math.abs(state.roll) < 0.2) {
    const pitchCorrection = -5 * state.pitch - 2 * state.angular.pitch;
    if (pitchCorrection < -0.04) keys.add('x');
    else if (pitchCorrection > 0.04) keys.add('w');
  }
  const targetDescent = -Math.min(5.5, 1.5 + Math.sqrt(6 * Math.max(0, state.pos.y)));
  if (Math.cos(state.pitch) * Math.cos(state.roll) > 0.98 && state.vel.y < targetDescent) keys.add('s');
  return keys;
}

test('shared arc geometry turns through vertical to a 170-degree inverted release', () => {
  assert.deepEqual(trackPoint(0), { z: WORLD.rampStart, y: 0, pitch: 0 });
  assert.ok(Math.abs(trackPoint(Math.PI / 2).z - 46) < 1e-12);
  assert.ok(Math.abs(trackPoint(Math.PI / 2).y - 11) < 1e-12);
  assert.ok(trackPoint(WORLD.rampThetaEnd).z < trackPoint(Math.PI / 2).z);
  const state = driveToTakeoff();
  assert.equal(state.launches, 1);
  assert.ok(Math.abs(state.pos.y - WORLD.rampHeight) < 1e-10);
  assert.ok(Math.abs(state.pitch - (Math.PI - WORLD.rampThetaEnd)) < 1e-10);
  assert.ok(Math.abs(Math.abs(state.roll) - Math.PI) < 1e-10);
  assert.ok(Math.abs(Math.abs(state.yaw) - Math.PI) < 1e-10);
  assert.ok(forwardVector(state).z < -0.98, 'inverted release already points away from the track');
  assert.ok(Math.abs(state.vel.y - WORLD.trackMaxSpeed * Math.sin(WORLD.rampThetaEnd) - WORLD.releaseImpulse) < 1e-10);
  assert.ok(Math.abs(state.vel.z - WORLD.trackMaxSpeed * Math.cos(WORLD.rampThetaEnd)) < 1e-10);
  assert.ok(Math.abs(getQuaternion(state).length() - 1) < 1e-12);
});

test('adhesion does not accelerate, auto-steer, correct lateral position or release a stopped car', () => {
  const state = createState();
  state.pos.x = 0.4;
  state.yaw = 0.06;
  while (state.phase === 'ground') stepPhysics(state, new Set(['w']), DT);
  assert.ok(state.pos.x > 0.4, 'entry preserves player lateral motion');
  assert.equal(state.yaw, 0.06, 'entry does not straighten the heading');
  assert.equal(state.fuel, 100, 'automatic adhesion does not consume player jet fuel');
  assert.equal(state.downforce, WORLD.attachmentDownforce);
  for (let frame = 0; frame < 240; frame += 1) stepPhysics(state, new Set(['s']), DT);
  assert.equal(state.speed, 0);
  const stopped = { ...state.pos };
  const stoppedAngle = state.trackAngle;
  for (let frame = 0; frame < 1200; frame += 1) stepPhysics(state, new Set(), DT);
  assert.equal(state.phase, 'climb');
  assert.deepEqual(state.pos, stopped);
  assert.equal(state.trackAngle, stoppedAngle);
  assert.equal(state.launches, 0);
});

test('missing the entrance stays on the ground; steering off the attached surface releases early', () => {
  const missed = createState();
  missed.pos.x = WORLD.rampHalfWidth + 1;
  for (let frame = 0; frame < 240; frame += 1) stepPhysics(missed, new Set(['w']), DT);
  assert.equal(missed.phase, 'ground');
  assert.ok(missed.pos.z > WORLD.rampStart);
  const side = driveToTrack();
  while (side.phase === 'climb') stepPhysics(side, new Set(['w', 'a']), DT);
  assert.equal(side.phase, 'air');
  assert.ok(side.pos.x > 0);
  assert.ok(side.pos.x < WORLD.rampHalfWidth - WORLD.vehicleWidth / 2, 'yawed vehicle reaches edge before its center-width-only footprint');
  assert.ok(side.trackAngle < WORLD.rampThetaEnd);
  assert.ok(side.vel.x > 0);
});

test('yaw-expanded vehicle footprint rejects an angled entrance and releases an angled edge', () => {
  const angled = createState();
  angled.pos = { x: 2, y: 0, z: WORLD.rampStart - 0.01 };
  angled.yaw = Math.PI / 4;
  angled.speed = 10;
  stepPhysics(angled, new Set(['w']), DT);
  assert.equal(angled.phase, 'ground', 'the angled nose overhang prevents adhesion');
  const straight = createState();
  straight.pos = { x: 2, y: 0, z: WORLD.rampStart - 0.01 };
  straight.speed = 10;
  stepPhysics(straight, new Set(['w']), DT);
  assert.equal(straight.phase, 'climb', 'the same center position fits when aligned');
  straight.speed = 0;
  straight.yaw = Math.PI / 4;
  stepPhysics(straight, new Set(), DT);
  assert.equal(straight.phase, 'air', 'angled rear/front corners crossing the edge lose adhesion');
});

test('A steers screen-left toward world +x and D screen-right toward world -x', () => {
  for (const [key, sign] of [['a', 1], ['d', -1]]) {
    const state = createState();
    for (let frame = 0; frame < 120; frame += 1) stepPhysics(state, new Set(['w', key]), DT);
    assert.equal(Math.sign(state.pos.x), sign);
    assert.equal(Math.sign(state.yaw), sign);
    assert.equal(Math.sign(state.vel.x), sign);
  }
  for (const key of ['q', 'a', 'z']) assert.ok(JETS.find((jet) => jet.key === key).x > 0, `${key} belongs on the driver's left`);
  for (const key of ['e', 'd', 'c']) assert.ok(JETS.find((jet) => jet.key === key).x < 0, `${key} belongs on the driver's right`);
});

test('all nine keys fire independent jets with the expected torque signs', () => {
  assert.equal(new Set(JETS.map((jet) => jet.key)).size, 9);
  for (const jet of JETS) {
    const state = airborne();
    stepPhysics(state, new Set([jet.key]), DT);
    assert.deepEqual(state.activeJets, [jet.key]);
    assert.equal(Math.sign(state.angular.pitch), Math.sign(jet.z), `${jet.key}: front/rear pitch`);
    assert.equal(Math.sign(state.angular.roll), jet.x === 0 ? 0 : Math.sign(-jet.x), `${jet.key}: left/right roll`);
    assert.ok(state.vel.y > -WORLD.gravity * DT, `${jet.key}: upward thrust`);
    assert.ok(state.fuel < 100);
  }
});

test('symmetric jets cancel torque and center S provides lift without rotation', () => {
  const state = airborne();
  stepPhysics(state, new Set(JETS.map((jet) => jet.key)), 0.1);
  assert.ok(Math.abs(state.angular.pitch) < 1e-12);
  assert.ok(Math.abs(state.angular.roll) < 1e-12);
  assert.ok(state.vel.y > 2.8);
  const center = airborne();
  stepPhysics(center, new Set(['s']), 0.1);
  assert.equal(center.pitch, 0);
  assert.ok(Math.abs(center.roll) < 1e-12);
  assert.ok(center.vel.y > 0);
});

test('tilted local jets translate laterally instead of applying world-up magic', () => {
  const pitch = airborne({ pitch: 0.2 });
  stepPhysics(pitch, new Set(['s']), 0.1);
  assert.ok(pitch.vel.z < -0.2, 'nose-up lift brakes forward momentum');
  const roll = airborne({ roll: 0.2 });
  stepPhysics(roll, new Set(['s']), 0.1);
  assert.ok(roll.vel.x > 0.2, 'banked thrust moves sideways');
  const inverted = airborne({ pitch: Math.PI });
  stepPhysics(inverted, new Set(['s']), 0.1);
  assert.ok(inverted.vel.y < -3, 'S pushes down while inverted; it cannot auto-flip or save the car');
  assert.ok(forwardVector(inverted).z < -0.99);
  assert.ok(Math.abs(Math.abs(inverted.roll) - Math.PI) < 1e-12);
});

test('fuel never goes negative; empty tanks stop thrust even with all keys held', () => {
  const state = airborne({ fuel: 2 });
  const all = new Set(JETS.map((jet) => jet.key));
  for (let index = 0; index < 10; index += 1) stepPhysics(state, all, 0.1);
  assert.equal(state.fuel, 0);
  assert.deepEqual(state.activeJets, []);
  const previousVelocity = state.vel.y;
  stepPhysics(state, all, 0.1);
  assert.ok(Math.abs(state.vel.y - previousVelocity + WORLD.gravity * 0.1) < 1e-9);
  assert.ok(Math.abs(state.fuelUsed - 2) < 1e-9);
});

test('impact quality is continuous across the old angle cutoff and beyond the painted pad', () => {
  const safe = airborne({ pos: { x: 0, y: 0, z: WORLD.padZ }, vel: { x: 0, y: -2, z: 6 } });
  assert.equal(evaluateLanding(safe).success, true);
  const scores = [];
  for (const angle of [0, 14, 15, 30, 45, 60]) {
    const state = structuredClone(safe);
    state.roll = angle * Math.PI / 180;
    setAttitude(state);
    const quality = evaluateLanding(state);
    scores.push(quality.score);
    assert.ok(quality.score > 0, 'an angle alone never means zero points');
    if (angle <= 30) assert.equal(quality.success, true, 'normal safe-quality tolerance is relaxed');
  }
  assert.ok(scores.every((score, index) => index === 0 || score <= scores[index - 1]));
  assert.ok(scores[1] - scores[2] < 15, '14 to 15 degrees no longer destroys the score');
  for (const mutate of [
    (state) => { state.pos.x = WORLD.padHalfWidth + 5; },
    (state) => { state.pos.z = WORLD.padZ + WORLD.padHalfLength + 5; },
    (state) => { state.vel.y = -10; },
    (state) => { state.vel.z = 25; },
    (state) => { state.roll = Math.PI / 2; },
    (state) => { state.pitch = Math.PI; },
  ]) {
    const unsafe = structuredClone(safe);
    mutate(unsafe);
    setAttitude(unsafe);
    const quality = evaluateLanding(unsafe);
    assert.equal(quality.success, false, 'unsafe impact quality is distinct from eventual upright recovery');
    assert.ok(quality.score > 0, 'an impact snapshot does not decide a rollover or discard imperfect landing points');
  }
});

test('fast downward motion cannot tunnel through the ground', () => {
  const state = airborne({ pos: { x: 0, y: 0.01, z: 130 }, vel: { x: 0, y: -50, z: 0 } });
  stepPhysics(state, new Set(), 0.1);
  assert.equal(state.phase, 'contact');
  assert.equal(state.result, null);
  assert.ok(groundSupport(state).minimumY >= -0.00301);
  assert.ok(state.impact.verticalSpeed >= 50);
  finishContact(state);
});

test('invalid time is ignored, long frames bounded, invalid numeric state terminates cleanly', () => {
  const state = createState();
  for (const dt of [NaN, Infinity, -1, 0]) stepPhysics(state, new Set(['w']), dt);
  assert.equal(state.elapsed, 0);
  stepPhysics(state, new Set(['w']), 5);
  assert.ok(Math.abs(state.elapsed - 0.1) < 1e-12);
  state.vel.x = NaN;
  stepPhysics(state, new Set(), DT);
  assert.equal(state.phase, 'crashed');
  assert.equal(state.result.success, false);
  assert.ok(Number.isFinite(state.result.score));
});

test('continuous player W -> attached arc -> inverted release -> real-key flip -> safe landing', () => {
  const state = driveToTakeoff();
  const used = new Set();
  for (let frame = 0; frame < 3600 && state.phase === 'air'; frame += 1) {
    const keys = feedbackKeys(state);
    keys.forEach((key) => used.add(key));
    stepPhysics(state, keys, DT);
    assert.ok(forwardVector(state).z < -0.98, 'side-roll recovery never reverses the nose toward the track');
    assert.ok(Math.abs(getQuaternion(state).length() - 1) < 1e-12);
  }
  finishContact(state);
  assert.equal(state.phase, 'landed', JSON.stringify({ pos: state.pos, vel: state.vel, result: state.result }));
  assert.ok(state.result.score >= 400);
  assert.ok(state.fuel > 0 && state.fuel < 100);
  assert.ok(['a', 'd', 's', 'x', 'w'].every((key) => used.has(key)), 'pilot must side-roll, counter-roll, trim pitch and brake descent');
  assert.ok(state.flightTime > 2);
  const terminal = structuredClone(state);
  stepPhysics(state, new Set(['s']), 0.1);
  assert.deepEqual(state, terminal, 'results freeze only after collision settling and rollout');
});

test('a learnable D side-roll, A rotation brake and S descent control also lands safely', () => {
  const state = driveToTakeoff();
  for (let frame = 0; frame < 3600 && state.phase === 'air'; frame += 1) {
    const keys = new Set();
    if (state.flightTime < 0.85) keys.add('d');
    else if (state.flightTime < 1.2) keys.add('a');
    else if (state.vel.y < -Math.min(5.5, 1.5 + Math.sqrt(6 * Math.max(0, state.pos.y)))) keys.add('s');
    stepPhysics(state, keys, DT);
  }
  finishContact(state);
  assert.equal(state.phase, 'landed', JSON.stringify(state.result));
  assert.ok(state.result.tilt < 11);
  assert.ok(state.result.verticalSpeed < 4);
  assert.ok(forwardVector(state).z < -0.98);
});

test('local side-roll keeps the forward axis and W raises the nose after rolling upright', () => {
  const state = driveToTakeoff();
  const initialForward = forwardVector(state);
  for (let frame = 0; frame < 144; frame += 1) {
    stepPhysics(state, new Set([frame < 102 ? 'd' : 'a']), DT);
    assert.ok(forwardVector(state).distanceTo(initialForward) < 1e-12, 'rolling cannot change nose direction');
    assert.ok(Math.abs(getQuaternion(state).length() - 1) < 1e-12);
  }
  assert.ok(Math.abs(state.roll) < 0.06);
  const uprightForward = forwardVector(state);
  for (let frame = 0; frame < 20; frame += 1) stepPhysics(state, new Set(['w']), DT);
  assert.ok(forwardVector(state).y > uprightForward.y + 0.02, 'front thrust physically raises the nose after the 180-degree roll');
  assert.ok(forwardVector(state).z < -0.9, 'pitch trim retains the outward heading');
});

test('the same launch with no air input crashes instead of granting automatic success', () => {
  const state = driveToTakeoff();
  while (state.phase === 'air') stepPhysics(state, new Set(), DT);
  finishContact(state);
  assert.equal(state.phase, 'crashed');
  assert.equal(state.result.success, false);
  assert.equal(state.result.score, 0, 'a car that remains overturned scores zero');
  assert.ok(state.result.verticalSpeed > WORLD.safeVerticalSpeed);
});

test('physics reproduces identical state for identical initial conditions and inputs', () => {
  const left = createState();
  const right = createState();
  for (let frame = 0; frame < 1200; frame += 1) {
    const keys = ['ground', 'climb'].includes(left.phase) ? new Set(['w']) : feedbackKeys(left);
    stepPhysics(left, keys, DT);
    stepPhysics(right, keys, DT);
  }
  assert.deepEqual(left, right);
});

test('all difficulties keep full thrust but spend the normalized tank three times faster', () => {
  assert.equal(FUEL_CONSUMPTION_MULTIPLIER, 3);
  for (const difficulty of ['normal', 'practice']) {
    const state = airborne({ difficulty, pos: { x: 0, y: 80, z: WORLD.padZ }, vel: { x: 0, y: -30, z: 0 } });
    const legacyRate = 24 * 0.37 * (difficulty === 'practice' ? 0.65 : 1);
    for (let frame = 0; frame < 120; frame += 1) stepPhysics(state, new Set(['s']), DT);
    assert.ok(Math.abs(state.fuelUsed - legacyRate * 3) < 1e-9, 'same one-second input consumes exactly triple the former capacity');
    assert.ok(Math.abs(state.vel.y - (-30 + 24 - WORLD.gravity)) < 1e-9, 'force is unchanged while fuel remains');
    const expectedDuration = (100 / legacyRate) / 3;
    for (let frame = 0; frame < 900 && state.fuel > 0; frame += 1) stepPhysics(state, new Set(['s']), DT);
    assert.equal(state.phase, 'air');
    assert.equal(state.fuel, 0);
    assert.ok(Math.abs(state.flightTime - expectedDuration) <= DT + 1e-9, 'usable duration is the former duration divided by three');
    stepPhysics(state, new Set(['s']), DT);
    assert.deepEqual(state.activeJets, []);
    assert.ok(Math.abs(state.fuelUsed - 100) < 1e-9);
  }
});

test('the last fraction of fuel applies only its affordable fraction of thrust', () => {
  const state = airborne({ fuel: 0.001 });
  const requested = 24 * 0.37 * FUEL_CONSUMPTION_MULTIPLIER * DT;
  stepPhysics(state, new Set(['s']), DT);
  assert.equal(state.fuel, 0);
  assert.ok(Math.abs(state.vel.y - (24 * 0.001 / requested - WORLD.gravity) * DT) < 1e-12);
  assert.ok(Math.abs(state.fuelUsed - 0.001) < 1e-12);
});

test('moderately tilted contacts naturally settle onto four wheels and retain partial points', () => {
  for (const roll of [15, 30, 45, 60]) {
    const state = dropState({ roll, speed: 3, forwardSpeed: 3 });
    const supports = new Set();
    finishContact(state, (current) => {
      if (current.contact) supports.add(current.contact.wheels.length);
    });
    assert.equal(state.phase, 'landed', `${roll} degrees should naturally recover through tyre contacts`);
    assert.ok(supports.has(2), 'the lowered pair of wheels contacts before the other pair');
    assert.ok(supports.has(4), 'all four wheels eventually carry the car');
    assert.ok(new Vector3(0, 1, 0).applyQuaternion(getQuaternion(state)).y > 0.99);
    assert.ok(state.result.score > 0);
    assert.ok(state.contact.rolloutTime >= 1.2);
  }
});

test('combined pitch and roll touch one wheel first, then all four, without a pose reset', () => {
  const state = dropState({ roll: 22, pitch: 10, speed: 2, forwardSpeed: 3 });
  let firstWheels;
  let previous = getQuaternion(state);
  let largestStep = 0;
  finishContact(state, (current) => {
    if (current.contact?.wheels.length && !firstWheels) firstWheels = [...current.contact.wheels];
    const next = getQuaternion(current);
    largestStep = Math.max(largestStep, previous.angleTo(next));
    previous = next;
  });
  assert.equal(firstWheels.length, 1);
  assert.equal(state.contact.wheels.length, 4);
  assert.equal(state.phase, 'landed');
  assert.ok(largestStep < 0.1, 'settling rotates continuously rather than snapping upright');
});

test('roof and side landings stay above ground and score zero only after settling overturned', () => {
  for (const roll of [90, 170, 180]) {
    const state = dropState({ roll, speed: 3, forwardSpeed: 1 });
    finishContact(state);
    assert.equal(state.phase, 'crashed');
    assert.equal(state.result.score, 0);
    assert.equal(state.result.title, '翻车');
    assert.ok(state.pos.y > 1, 'inverted/sideways model origin remains above its actual support');
    assert.ok(new Vector3(0, 1, 0).applyQuaternion(getQuaternion(state)).y < 0.01, 'no hidden auto-righting');
  }
});

test('tyre impact visibly rebounds, dissipates energy, rolls forward and keeps its impact snapshot', () => {
  const state = dropState({ speed: 4, forwardSpeed: 3 });
  let rebound = 0;
  let reboundClearance = 0;
  let impact;
  let contactZ;
  let fuelAtContact;
  finishContact(state, (current) => {
    if (!current.contact) return;
    impact ??= current.impact;
    contactZ ??= current.pos.z;
    fuelAtContact ??= current.fuel;
    assert.equal(current.impact, impact, 'first-impact snapshot is never recomputed from a later quiet bounce');
    assert.equal(current.fuel, fuelAtContact, 'contact simulation does not secretly burn jet fuel');
    rebound = Math.max(rebound, current.vel.y);
    if (current.vel.y > 0) reboundClearance = Math.max(reboundClearance, groundSupport(current).minimumY);
  });
  assert.equal(state.phase, 'landed');
  assert.ok(rebound > 0.4 && rebound < impact.verticalSpeed * 0.8, 'restitution causes an energetic but dissipative bounce');
  assert.ok(reboundClearance > 0.005, 'rebound is a real separation from the ground');
  assert.ok(state.pos.z > contactZ + 0.6, 'the free wheels carry forward momentum after landing');
  assert.ok(state.contact.rolloutTime >= 1.2);
  assert.equal(state.result.score, impact.score);
  assert.ok(state.result.verticalSpeed > 3.9);
  assert.equal(state.vel.y, 0);
});

test('soft, angled and hard upright landings receive graduated scores, including outside white markings', () => {
  const soft = dropState({ speed: 0.6, forwardSpeed: 0, clearance: 0.001 });
  const angled = dropState({ roll: 40, speed: 3, forwardSpeed: 1 });
  const hard = dropState({ speed: 16, forwardSpeed: 0 });
  const outside = dropState({ speed: 2, forwardSpeed: 1, x: WORLD.padHalfWidth + 8 });
  for (const state of [soft, angled, hard, outside]) {
    finishContact(state);
    assert.equal(state.phase, 'landed');
    assert.ok(state.result.score > 0);
  }
  assert.ok(soft.result.score > 900);
  assert.ok(soft.result.score > angled.result.score && angled.result.score > hard.result.score);
  assert.ok(hard.result.score < 250);
  assert.equal(outside.result.coverage, 0);
  assert.ok(outside.result.score < soft.result.score);
});

test('contacts ignore held flight controls and a true test-area escape still scores zero', () => {
  const state = dropState({ roll: 30, speed: 2 });
  while (state.phase === 'air') stepPhysics(state, new Set(), DT);
  const fuel = state.fuel;
  for (let frame = 0; frame < 120; frame += 1) stepPhysics(state, new Set(JETS.map((jet) => jet.key)), DT);
  assert.equal(state.fuel, fuel);
  assert.deepEqual(state.activeJets, []);
  const escaped = airborne({ pos: { x: 151, y: 20, z: 0 } });
  stepPhysics(escaped, new Set(), DT);
  assert.equal(escaped.phase, 'crashed');
  assert.equal(escaped.result.score, 0);
});

test('a high-speed wheel landing decelerates physically before the result instead of stopping abruptly', () => {
  const state = dropState({ speed: 2, forwardSpeed: 25 });
  let previousSpeed = 25;
  let preResultSpeed = Infinity;
  let slowRollingSeconds = 0;
  finishContact(state, (current) => {
    const speed = Math.hypot(current.vel.x, current.vel.z);
    if (current.phase === 'contact' && speed > 0.25 && speed < 2) slowRollingSeconds += DT;
    if (['landed', 'crashed'].includes(current.phase)) preResultSpeed = previousSpeed;
    previousSpeed = speed;
  });
  assert.equal(state.phase, 'landed');
  assert.ok(preResultSpeed < 0.27, 'only a nearly stopped body can enter the frozen result state');
  assert.ok(slowRollingSeconds > 1, 'the player sees a low-speed rollout before the result');
  assert.ok(state.contact.elapsed > 2);
});

test('contact G telemetry shows an impact peak and approximately one G at rest', () => {
  const state = dropState({ speed: 4, forwardSpeed: 1 });
  let peak = 0;
  const resting = [];
  finishContact(state, (current) => {
    if (current.phase !== 'contact') return;
    assert.ok(Number.isFinite(current.gForce) && current.gForce >= 0);
    peak = Math.max(peak, current.gForce);
    if (current.contact.elapsed > 0.6 && current.contact.wheels.length === 4 && Math.abs(current.vel.y) < 0.03) resting.push(current.gForce);
  });
  assert.ok(peak > 5, 'collision impulses must replace the last airborne thrust G');
  assert.ok(resting.length > 10);
  const mean = resting.reduce((sum, value) => sum + value, 0) / resting.length;
  assert.ok(mean > 0.8 && mean < 1.2, `supported car carries its own weight: ${mean}`);
  assert.equal(state.gForce, 1);
});
